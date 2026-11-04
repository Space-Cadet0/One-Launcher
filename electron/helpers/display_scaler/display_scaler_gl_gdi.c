/*
 * One Launcher Clean-Room Win32 Universal Display Virtualizer & Fullscreen Presenter
 * OpenGL Offscreen FBO Upscaler, WineD3D GL Backbuffer Upscaler & GDI 2D Stretch Presenter
 * (`display_scaler_gl_gdi.c`)
 */

#include "display_scaler_internal.h"
#include <string.h>

typedef void   (APIENTRY *pfn_glGenFramebuffers_t)(GLsizei, GLuint *);
typedef void   (APIENTRY *pfn_glDeleteFramebuffers_t)(GLsizei, const GLuint *);
typedef void   (APIENTRY *pfn_glFramebufferTexture2D_t)(GLenum, GLenum, GLenum, GLuint, GLint);
typedef void   (APIENTRY *pfn_glGenRenderbuffers_t)(GLsizei, GLuint *);
typedef void   (APIENTRY *pfn_glDeleteRenderbuffers_t)(GLsizei, const GLuint *);
typedef void   (APIENTRY *pfn_glBindRenderbuffer_t)(GLenum, GLuint);
typedef void   (APIENTRY *pfn_glRenderbufferStorage_t)(GLenum, GLenum, GLsizei, GLsizei);
typedef void   (APIENTRY *pfn_glFramebufferRenderbuffer_t)(GLenum, GLenum, GLenum, GLuint);
typedef GLenum (APIENTRY *pfn_glCheckFramebufferStatus_t)(GLenum);
typedef void   (APIENTRY *pfn_glBlitFramebuffer_t)(GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum);
typedef void   (APIENTRY *pfn_glBindBuffer_t)(GLenum, GLuint);

typedef void      (APIENTRY *pfn_glGenTextures_t)(GLsizei, GLuint *);
typedef void      (APIENTRY *pfn_glDeleteTextures_t)(GLsizei, const GLuint *);
typedef void      (APIENTRY *pfn_glBindTexture_t)(GLenum, GLuint);
typedef void      (APIENTRY *pfn_glTexImage2D_t)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const GLvoid *);
typedef void      (APIENTRY *pfn_glTexParameteri_t)(GLenum, GLenum, GLint);
typedef GLboolean (APIENTRY *pfn_glIsEnabled_t)(GLenum);
typedef void      (APIENTRY *pfn_glEnable_t)(GLenum);
typedef void      (APIENTRY *pfn_glDisable_t)(GLenum);
typedef void      (APIENTRY *pfn_glGetIntegerv_t)(GLenum, GLint *);
typedef void      (APIENTRY *pfn_glClearColor_t)(GLclampf, GLclampf, GLclampf, GLclampf);
typedef void      (APIENTRY *pfn_glClear_t)(GLbitfield);
typedef HGLRC     (WINAPI   *pfn_wglGetCurrentContext_t)(void);
typedef BOOL      (WINAPI   *pfn_wglSetPixelFormatWINE_t)(HDC, int);
typedef BOOL      (WINAPI   *pfn_wglChoosePixelFormatARB_t)(HDC, const int *, const FLOAT *, UINT, int *, UINT *);
typedef BOOL      (WINAPI   *pfn_wglGetPixelFormatAttribivARB_t)(HDC, int, int, UINT, const int *, int *);
typedef BOOL      (WINAPI   *pfn_wglGetPixelFormatAttribfvARB_t)(HDC, int, int, UINT, const int *, FLOAT *);
typedef HGLRC     (WINAPI   *pfn_wglCreateContextAttribsARB_t)(HDC, HGLRC, const int *);
typedef const char *(WINAPI *pfn_wglGetExtensionsStringARB_t)(HDC);
typedef BOOL      (WINAPI   *pfn_wglMakeContextCurrentARB_t)(HDC, HDC, HGLRC);
typedef HDC       (WINAPI   *pfn_wglGetCurrentReadDCARB_t)(void);
typedef BOOL      (WINAPI   *pfn_wglQueryRendererIntegerWINE_t)(HDC, GLint, GLenum, GLuint *);
typedef const char *(WINAPI *pfn_wglQueryRendererStringWINE_t)(HDC, GLint, GLenum);

#define DS_MAX_GL_DC_MAP 16

typedef struct ds_gl_dc_entry_s {
    HDC  game_hdc;
    HDC  host_hdc;
    HWND host_hwnd;
} ds_gl_dc_entry_t;

typedef struct ds_gl_state_s {
    bool                          procs_queried;
    bool                          fbo_supported;
    HGLRC                         game_hglrc;
    HGLRC                         fbo_ctx;
    GLuint                        fbo_id;
    GLuint                        color_tex;
    GLuint                        depth_rb;
    int32_t                       fbo_w;
    int32_t                       fbo_h;
    bool                          fbo_redirect_active;
    GLuint                        game_draw_fbo;
    GLuint                        game_read_fbo;

    /* WineD3D OpenGL presentation tracking & shader-blitter upscale FBO */
    HGLRC                         w3d_hglrc;
    GLuint                        w3d_fbo_id;
    GLuint                        w3d_color_tex;
    int32_t                       w3d_w;
    int32_t                       w3d_h;
    bool                          w3d_scaled_in_blit;
    bool                          last_present_was_gl;

    /* Bijective game_hdc <-> host_hdc map for OneLauncherGLHostChild */
    ds_gl_dc_entry_t              dc_map[DS_MAX_GL_DC_MAP];
    int                           last_host_pf;
    PIXELFORMATDESCRIPTOR         last_host_pfd;
    bool                          has_last_host_pfd;
    volatile LONG                 mode_trace_budget;

    pfn_wglGetCurrentContext_t    p_wglGetCurrentContext;
    pfn_wglGetCurrentDC_t         p_wglGetCurrentDC;
    pfn_wglSetPixelFormatWINE_t   p_wglSetPixelFormatWINE;
    pfn_wglChoosePixelFormatARB_t p_wglChoosePixelFormatARB;
    pfn_wglGetPixelFormatAttribivARB_t p_wglGetPixelFormatAttribivARB;
    pfn_wglGetPixelFormatAttribfvARB_t p_wglGetPixelFormatAttribfvARB;
    pfn_wglCreateContextAttribsARB_t   p_wglCreateContextAttribsARB;
    pfn_wglGetExtensionsStringARB_t    p_wglGetExtensionsStringARB;
    pfn_wglMakeContextCurrentARB_t     p_wglMakeContextCurrentARB;
    pfn_wglGetCurrentReadDCARB_t       p_wglGetCurrentReadDCARB;
    pfn_wglQueryRendererIntegerWINE_t  p_wglQueryRendererIntegerWINE;
    pfn_wglQueryRendererStringWINE_t   p_wglQueryRendererStringWINE;
    pfn_glGenFramebuffers_t       p_glGenFramebuffers;
    pfn_glDeleteFramebuffers_t    p_glDeleteFramebuffers;
    pfn_glBindFramebuffer_t       p_glBindFramebuffer;
    pfn_glFramebufferTexture2D_t  p_glFramebufferTexture2D;
    pfn_glGenRenderbuffers_t      p_glGenRenderbuffers;
    pfn_glDeleteRenderbuffers_t   p_glDeleteRenderbuffers;
    pfn_glBindRenderbuffer_t      p_glBindRenderbuffer;
    pfn_glRenderbufferStorage_t   p_glRenderbufferStorage;
    pfn_glFramebufferRenderbuffer_t p_glFramebufferRenderbuffer;
    pfn_glCheckFramebufferStatus_t p_glCheckFramebufferStatus;
    pfn_glBlitFramebuffer_t       p_glBlitFramebuffer;
    pfn_glBindBuffer_t            p_glBindBuffer;

    pfn_glGenTextures_t           p_glGenTextures;
    pfn_glDeleteTextures_t        p_glDeleteTextures;
    pfn_glBindTexture_t           p_glBindTexture;
    pfn_glTexImage2D_t            p_glTexImage2D;
    pfn_glTexParameteri_t         p_glTexParameteri;
    pfn_glIsEnabled_t             p_glIsEnabled;
    pfn_glEnable_t                p_glEnable;
    pfn_glDisable_t               p_glDisable;
    pfn_glGetIntegerv_t           p_glGetIntegerv;
    pfn_glClearColor_t            p_glClearColor;
    pfn_glClear_t                 p_glClear;
} ds_gl_state_t;

static ds_gl_state_t g_gl = { 0 };

static void *ds_gl_proc_or_ext(HMODULE h_gl, const char *core_name, const char *ext_name)
{
    void *fn = NULL;
    if (g_ds.real_wglGetProcAddress) {
        fn = (void *)(uintptr_t)g_ds.real_wglGetProcAddress(core_name);
        if (!fn && ext_name) {
            fn = (void *)(uintptr_t)g_ds.real_wglGetProcAddress(ext_name);
        }
    }
    if (!fn && h_gl && g_ds.real_GetProcAddress) {
        fn = (void *)(uintptr_t)g_ds.real_GetProcAddress(h_gl, core_name);
        if (!fn && ext_name) {
            fn = (void *)(uintptr_t)g_ds.real_GetProcAddress(h_gl, ext_name);
        }
    }
    return fn;
}

static bool ds_gl_init_procs_once(void)
{
    if (g_gl.procs_queried) {
        return g_gl.fbo_supported;
    }

    HMODULE h_gl = GetModuleHandleW(L"opengl32.dll");
    if (!h_gl || !g_ds.real_GetProcAddress) {
        return false;
    }

    if (!g_gl.p_wglGetCurrentContext) {
        g_gl.p_wglGetCurrentContext = (pfn_wglGetCurrentContext_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "wglGetCurrentContext");
    }
    if (!g_gl.p_wglGetCurrentDC) {
        g_gl.p_wglGetCurrentDC = (pfn_wglGetCurrentDC_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "wglGetCurrentDC");
    }
    if (!g_gl.p_wglGetCurrentContext || g_gl.p_wglGetCurrentContext() == NULL) {
        /* Wait until a WGL context is current so wglGetProcAddress resolves FBO entrypoints */
        return false;
    }

    g_gl.procs_queried = true;
    g_gl.p_glGenTextures        = (pfn_glGenTextures_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glGenTextures");
    g_gl.p_glDeleteTextures     = (pfn_glDeleteTextures_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glDeleteTextures");
    g_gl.p_glBindTexture        = (pfn_glBindTexture_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glBindTexture");
    g_gl.p_glTexImage2D         = (pfn_glTexImage2D_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glTexImage2D");
    g_gl.p_glTexParameteri      = (pfn_glTexParameteri_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glTexParameteri");
    g_gl.p_glIsEnabled          = (pfn_glIsEnabled_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glIsEnabled");
    g_gl.p_glEnable             = (pfn_glEnable_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glEnable");
    g_gl.p_glDisable            = (pfn_glDisable_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glDisable");
    g_gl.p_glGetIntegerv        = (pfn_glGetIntegerv_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glGetIntegerv");
    if (!g_ds.real_glDrawBuffer) {
        g_ds.real_glDrawBuffer  = (pfn_glDrawBuffer_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glDrawBuffer");
    }
    if (!g_ds.real_glReadBuffer) {
        g_ds.real_glReadBuffer  = (pfn_glReadBuffer_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glReadBuffer");
    }

    g_gl.p_glGenFramebuffers         = (pfn_glGenFramebuffers_t)ds_gl_proc_or_ext(h_gl, "glGenFramebuffers", "glGenFramebuffersEXT");
    g_gl.p_glDeleteFramebuffers      = (pfn_glDeleteFramebuffers_t)ds_gl_proc_or_ext(h_gl, "glDeleteFramebuffers", "glDeleteFramebuffersEXT");
    g_gl.p_glBindFramebuffer         = (pfn_glBindFramebuffer_t)ds_gl_proc_or_ext(h_gl, "glBindFramebuffer", "glBindFramebufferEXT");
    g_gl.p_glFramebufferTexture2D    = (pfn_glFramebufferTexture2D_t)ds_gl_proc_or_ext(h_gl, "glFramebufferTexture2D", "glFramebufferTexture2DEXT");
    g_gl.p_glGenRenderbuffers        = (pfn_glGenRenderbuffers_t)ds_gl_proc_or_ext(h_gl, "glGenRenderbuffers", "glGenRenderbuffersEXT");
    g_gl.p_glDeleteRenderbuffers     = (pfn_glDeleteRenderbuffers_t)ds_gl_proc_or_ext(h_gl, "glDeleteRenderbuffers", "glDeleteRenderbuffersEXT");
    g_gl.p_glBindRenderbuffer        = (pfn_glBindRenderbuffer_t)ds_gl_proc_or_ext(h_gl, "glBindRenderbuffer", "glBindRenderbufferEXT");
    g_gl.p_glRenderbufferStorage     = (pfn_glRenderbufferStorage_t)ds_gl_proc_or_ext(h_gl, "glRenderbufferStorage", "glRenderbufferStorageEXT");
    g_gl.p_glFramebufferRenderbuffer = (pfn_glFramebufferRenderbuffer_t)ds_gl_proc_or_ext(h_gl, "glFramebufferRenderbuffer", "glFramebufferRenderbufferEXT");
    g_gl.p_glCheckFramebufferStatus  = (pfn_glCheckFramebufferStatus_t)ds_gl_proc_or_ext(h_gl, "glCheckFramebufferStatus", "glCheckFramebufferStatusEXT");
    g_gl.p_glBlitFramebuffer         = (pfn_glBlitFramebuffer_t)ds_gl_proc_or_ext(h_gl, "glBlitFramebuffer", "glBlitFramebufferEXT");
    g_gl.p_glBindBuffer              = (pfn_glBindBuffer_t)ds_gl_proc_or_ext(h_gl, "glBindBuffer", "glBindBufferARB");
    g_gl.p_glClearColor              = (pfn_glClearColor_t)ds_gl_proc_or_ext(h_gl, "glClearColor", NULL);
    g_gl.p_glClear                   = (pfn_glClear_t)ds_gl_proc_or_ext(h_gl, "glClear", NULL);

    g_gl.fbo_supported = (
        g_gl.p_wglGetCurrentContext &&
        g_gl.p_glGenFramebuffers &&
        g_gl.p_glDeleteFramebuffers &&
        g_gl.p_glBindFramebuffer &&
        g_gl.p_glFramebufferTexture2D &&
        g_gl.p_glGenRenderbuffers &&
        g_gl.p_glDeleteRenderbuffers &&
        g_gl.p_glBindRenderbuffer &&
        g_gl.p_glRenderbufferStorage &&
        g_gl.p_glFramebufferRenderbuffer &&
        g_gl.p_glCheckFramebufferStatus &&
        g_gl.p_glBlitFramebuffer &&
        g_gl.p_glGenTextures &&
        g_gl.p_glDeleteTextures &&
        g_gl.p_glBindTexture &&
        g_gl.p_glTexImage2D &&
        g_gl.p_glTexParameteri
    );
    ds_tracef("ds_gl_init_procs_once: fbo_supp=%d genFB=%p blitFB=%p bindFB=%p",
              (int)g_gl.fbo_supported, g_gl.p_glGenFramebuffers, g_gl.p_glBlitFramebuffer, g_gl.p_glBindFramebuffer);
    return g_gl.fbo_supported;
}

static void ds_gl_destroy_fbo_current_ctx(void)
{
    if (!g_gl.fbo_supported) return;
    if (g_gl.fbo_redirect_active && g_gl.p_glBindFramebuffer) {
        g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, 0);
        if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);
        if (g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_BACK);
    }
    if (g_gl.depth_rb) {
        g_gl.p_glDeleteRenderbuffers(1, &g_gl.depth_rb);
        g_gl.depth_rb = 0;
    }
    if (g_gl.color_tex) {
        g_gl.p_glDeleteTextures(1, &g_gl.color_tex);
        g_gl.color_tex = 0;
    }
    if (g_gl.fbo_id) {
        g_gl.p_glDeleteFramebuffers(1, &g_gl.fbo_id);
        g_gl.fbo_id = 0;
    }
    g_gl.fbo_w = 0;
    g_gl.fbo_h = 0;
    g_gl.fbo_redirect_active = false;
}

static bool ds_gl_sync_fbo_for_current_ctx(int32_t virt_w, int32_t virt_h, int32_t dst_w, int32_t dst_h, bool want_fbo)
{
    if (!ds_gl_init_procs_once()) {
        return false;
    }
    HGLRC cur_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
    if (cur_ctx == NULL) {
        return false;
    }
    if (g_gl.fbo_ctx != cur_ctx) {
        g_gl.fbo_ctx = cur_ctx;
        g_gl.fbo_id = 0;
        g_gl.color_tex = 0;
        g_gl.depth_rb = 0;
        g_gl.fbo_w = 0;
        g_gl.fbo_h = 0;
        g_gl.fbo_redirect_active = false;
        g_gl.game_draw_fbo = 0;
        g_gl.game_read_fbo = 0;
    }
    if (!want_fbo || virt_w <= 0 || virt_h <= 0 || dst_w <= 0 || dst_h <= 0 ||
        (virt_w == dst_w && virt_h == dst_h)) {
        if (g_gl.fbo_redirect_active) {
            g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, 0);
            if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);
            if (g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_BACK);
            g_gl.fbo_redirect_active = false;
        }
        return false;
    }

    if (g_gl.fbo_id == 0 || g_gl.fbo_w != virt_w || g_gl.fbo_h != virt_h) {
        GLint prev_tex = 0;
        GLint prev_unpack_pbo = 0;
        if (g_gl.p_glGetIntegerv) {
            g_gl.p_glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev_tex);
            if (g_gl.p_glBindBuffer) {
                g_gl.p_glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &prev_unpack_pbo);
                if (prev_unpack_pbo != 0) {
                    g_gl.p_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
                }
            }
        }
        if (g_gl.fbo_id == 0) {
            g_gl.p_glGenFramebuffers(1, &g_gl.fbo_id);
            g_gl.p_glGenTextures(1, &g_gl.color_tex);
            g_gl.p_glGenRenderbuffers(1, &g_gl.depth_rb);
        }

        g_gl.p_glBindTexture(GL_TEXTURE_2D, g_gl.color_tex);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        g_gl.p_glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, virt_w, virt_h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        g_gl.p_glBindTexture(GL_TEXTURE_2D, (GLuint)prev_tex);
        if (prev_unpack_pbo != 0 && g_gl.p_glBindBuffer) {
            g_gl.p_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, (GLuint)prev_unpack_pbo);
        }

        g_gl.p_glBindRenderbuffer(GL_RENDERBUFFER, g_gl.depth_rb);
        g_gl.p_glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, virt_w, virt_h);
        g_gl.p_glBindRenderbuffer(GL_RENDERBUFFER, 0);

        g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, g_gl.fbo_id);
        g_gl.p_glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_gl.color_tex, 0);
        g_gl.p_glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, g_gl.depth_rb);

        GLenum status = g_gl.p_glCheckFramebufferStatus(GL_FRAMEBUFFER);
        if (status != GL_FRAMEBUFFER_COMPLETE) {
            ds_tracef("ds_gl_sync_fbo: status=0x%x FAILED (not complete)", (unsigned int)status);
            ds_gl_destroy_fbo_current_ctx();
            return false;
        }
        g_gl.fbo_w = virt_w;
        g_gl.fbo_h = virt_h;
    }

    g_gl.fbo_redirect_active = true;
    GLuint target_draw = g_gl.game_draw_fbo ? g_gl.game_draw_fbo : g_gl.fbo_id;
    GLuint target_read = g_gl.game_read_fbo ? g_gl.game_read_fbo : g_gl.fbo_id;
    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target_draw);
    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, target_read);
    if (target_draw == g_gl.fbo_id && g_ds.real_glDrawBuffer) {
        g_ds.real_glDrawBuffer(GL_COLOR_ATTACHMENT0);
    }
    if (target_read == g_gl.fbo_id && g_ds.real_glReadBuffer) {
        g_ds.real_glReadBuffer(GL_COLOR_ATTACHMENT0);
    }
    static int32_t s_last_vw = 0, s_last_vh = 0, s_last_dw = 0, s_last_dh = 0;
    static GLuint s_last_fbo = 0;
    if (s_last_vw != virt_w || s_last_vh != virt_h || s_last_dw != dst_w || s_last_dh != dst_h || s_last_fbo != g_gl.fbo_id) {
        s_last_vw = virt_w; s_last_vh = virt_h; s_last_dw = dst_w; s_last_dh = dst_h; s_last_fbo = g_gl.fbo_id;
        ds_tracef("ds_gl_sync_fbo: OK virt=%dx%d dst=%dx%d want=%d fbo_id=%u redir=%d",
                  virt_w, virt_h, dst_w, dst_h, (int)want_fbo, g_gl.fbo_id, (int)g_gl.fbo_redirect_active);
    }
    return true;
}

static void APIENTRY hook_glBindFramebuffer(GLenum target, GLuint framebuffer)
{
    if (!g_gl.p_glBindFramebuffer) return;
    if (ds_is_internal_call()) {
        g_gl.p_glBindFramebuffer(target, framebuffer);
        return;
    }
    if (g_gl.fbo_redirect_active && g_gl.fbo_id != 0 &&
        g_gl.p_wglGetCurrentContext && g_gl.p_wglGetCurrentContext() == g_gl.game_hglrc) {
        if (target == GL_FRAMEBUFFER) {
            g_gl.game_draw_fbo = framebuffer;
            g_gl.game_read_fbo = framebuffer;
            g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, framebuffer == 0 ? g_gl.fbo_id : framebuffer);
            return;
        }
        if (target == GL_DRAW_FRAMEBUFFER) {
            g_gl.game_draw_fbo = framebuffer;
            g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer == 0 ? g_gl.fbo_id : framebuffer);
            return;
        }
        if (target == GL_READ_FRAMEBUFFER) {
            g_gl.game_read_fbo = framebuffer;
            g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer == 0 ? g_gl.fbo_id : framebuffer);
            return;
        }
    }
    g_gl.p_glBindFramebuffer(target, framebuffer);
}

void APIENTRY hook_glDrawBuffer(GLenum mode)
{
    if (!g_ds.real_glDrawBuffer) return;
    if (g_gl.fbo_redirect_active && g_gl.game_draw_fbo == 0 &&
        !ds_is_internal_call() &&
        g_gl.p_wglGetCurrentContext && g_gl.p_wglGetCurrentContext() == g_gl.game_hglrc) {
        if (mode == GL_BACK || mode == GL_FRONT || mode == GL_FRONT_AND_BACK ||
            mode == GL_BACK_LEFT || mode == GL_FRONT_LEFT) {
            mode = GL_COLOR_ATTACHMENT0;
        }
    }
    g_ds.real_glDrawBuffer(mode);
}

void APIENTRY hook_glReadBuffer(GLenum mode)
{
    if (!g_ds.real_glReadBuffer) return;
    if (g_gl.fbo_redirect_active && g_gl.game_read_fbo == 0 &&
        !ds_is_internal_call() &&
        g_gl.p_wglGetCurrentContext && g_gl.p_wglGetCurrentContext() == g_gl.game_hglrc) {
        if (mode == GL_BACK || mode == GL_FRONT || mode == GL_FRONT_AND_BACK ||
            mode == GL_BACK_LEFT || mode == GL_FRONT_LEFT) {
            mode = GL_COLOR_ATTACHMENT0;
        }
    }
    g_ds.real_glReadBuffer(mode);
}

static void APIENTRY hook_glBlitFramebuffer(
    GLint srcX0,
    GLint srcY0,
    GLint srcX1,
    GLint srcY1,
    GLint dstX0,
    GLint dstY0,
    GLint dstX1,
    GLint dstY1,
    GLbitfield mask,
    GLenum filter
)
{
    if (!g_gl.p_glBlitFramebuffer) {
        HMODULE h_gl = GetModuleHandleW(L"opengl32.dll");
        g_gl.p_glBlitFramebuffer = (pfn_glBlitFramebuffer_t)ds_gl_proc_or_ext(h_gl, "glBlitFramebuffer", "glBlitFramebufferEXT");
        if (!g_gl.p_glBlitFramebuffer) return;
    }
    if ((!g_gl.p_glGetIntegerv || !g_gl.p_glIsEnabled || !g_gl.p_glDisable || !g_gl.p_glEnable || !g_gl.p_glClearColor || !g_gl.p_glClear || !g_gl.p_wglGetCurrentDC) && g_ds.real_GetProcAddress) {
        HMODULE h_gl = GetModuleHandleW(L"opengl32.dll");
        if (h_gl) {
            if (!g_gl.p_glGetIntegerv)   g_gl.p_glGetIntegerv   = (pfn_glGetIntegerv_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glGetIntegerv");
            if (!g_gl.p_glIsEnabled)     g_gl.p_glIsEnabled     = (pfn_glIsEnabled_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glIsEnabled");
            if (!g_gl.p_glDisable)       g_gl.p_glDisable       = (pfn_glDisable_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glDisable");
            if (!g_gl.p_glEnable)        g_gl.p_glEnable        = (pfn_glEnable_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glEnable");
            if (!g_gl.p_glClearColor)    g_gl.p_glClearColor    = (pfn_glClearColor_t)ds_gl_proc_or_ext(h_gl, "glClearColor", NULL);
            if (!g_gl.p_glClear)         g_gl.p_glClear         = (pfn_glClear_t)ds_gl_proc_or_ext(h_gl, "glClear", NULL);
            if (!g_gl.p_wglGetCurrentDC) g_gl.p_wglGetCurrentDC = (pfn_wglGetCurrentDC_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "wglGetCurrentDC");
        }
    }

    if (!ds_is_internal_call() && g_gl.p_glGetIntegerv && ds_is_wined3d_caller(__builtin_return_address(0))) {
        GLint draw_fbo = -1;
        g_gl.p_glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_fbo);
        if (draw_fbo == 0) {
            HDC cur_hdc = g_gl.p_wglGetCurrentDC ? g_gl.p_wglGetCurrentDC() : NULL;
            HWND cur_win = cur_hdc ? WindowFromDC(cur_hdc) : NULL;

            EnterCriticalSection(&g_ds.lock);
            g_ds.wined3d_uses_gl = true;
            bool is_target_win = (cur_win == NULL ||
                                  cur_win == g_ds.hwnd_game ||
                                  cur_win == g_ds.hwnd_gl_host ||
                                  (g_ds.hwnd_game != NULL && IsChild(g_ds.hwnd_game, cur_win)));
            int32_t win_scale = ds_get_windowed_scale_locked();
            int32_t vw = g_ds.virt_w;
            int32_t vh = g_ds.virt_h;
            int32_t dw = g_ds.fullscreen_active ? g_ds.vp.dst_w : (vw * win_scale);
            int32_t dh = g_ds.fullscreen_active ? g_ds.vp.dst_h : (vh * win_scale);
            int32_t dst_x = g_ds.fullscreen_active ? g_ds.vp.dst_x : 0;
            int32_t dst_y = g_ds.fullscreen_active ? g_ds.vp.dst_y : 0;
            int32_t real_w = g_ds.fullscreen_active ? g_ds.real_screen_w : dw;
            int32_t real_h = g_ds.fullscreen_active ? g_ds.real_screen_h : dh;
            bool should_scale = (
                is_target_win &&
                (g_ds.fullscreen_active || win_scale > 1) &&
                vw > 0 &&
                vh > 0 &&
                dw > 0 &&
                dh > 0 &&
                (vw != dw || vh != dh)
            );
            ds_aspect_mode_t aspect = g_ds.fullscreen_active ? g_ds.aspect_mode : DS_ASPECT_PRESERVE;
            LeaveCriticalSection(&g_ds.lock);

            if (should_scale) {
                int32_t gl_dst_y = real_h - (dst_y + dh);
                GLint nx0 = (GLint)(((int64_t)dstX0 * dw + (dstX0 >= 0 ? vw / 2 : -vw / 2)) / vw);
                GLint nx1 = (GLint)(((int64_t)dstX1 * dw + (dstX1 >= 0 ? vw / 2 : -vw / 2)) / vw);
                GLint ny0 = (GLint)(((int64_t)dstY0 * dh + (dstY0 >= 0 ? vh / 2 : -vh / 2)) / vh);
                GLint ny1 = (GLint)(((int64_t)dstY1 * dh + (dstY1 >= 0 ? vh / 2 : -vh / 2)) / vh);
                nx0 += dst_x;
                nx1 += dst_x;
                ny0 += gl_dst_y;
                ny1 += gl_dst_y;
                if (mask == GL_COLOR_BUFFER_BIT) {
                    filter = (aspect == DS_ASPECT_INTEGER) ? GL_NEAREST : GL_LINEAR;
                }
                static volatile LONG s_w3d_blit_logs = 0;
                if (InterlockedIncrement(&s_w3d_blit_logs) <= 16) {
                    ds_tracef("glBlitFramebuffer FBO 0 src=(%d,%d,%d,%d) dst=(%d,%d,%d,%d)->(%d,%d,%d,%d) filter=0x%x",
                              (int)srcX0, (int)srcY0, (int)srcX1, (int)srcY1,
                              (int)dstX0, (int)dstY0, (int)dstX1, (int)dstY1,
                              (int)nx0, (int)ny0, (int)nx1, (int)ny1, (unsigned int)filter);
                }
                GLboolean was_scissor = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_SCISSOR_TEST) : GL_FALSE;
                if (was_scissor && g_gl.p_glDisable) {
                    g_gl.p_glDisable(GL_SCISSOR_TEST);
                }
                GLint min_x = nx0 < nx1 ? nx0 : nx1;
                GLint max_x = nx0 > nx1 ? nx0 : nx1;
                GLint min_y = ny0 < ny1 ? ny0 : ny1;
                GLint max_y = ny0 > ny1 ? ny0 : ny1;
                if (mask == GL_COLOR_BUFFER_BIT && (min_x > 0 || min_y > 0 || max_x < real_w || max_y < real_h)) {
                    if (g_gl.p_glClearColor && g_gl.p_glClear) {
                        g_gl.p_glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
                        g_gl.p_glClear(GL_COLOR_BUFFER_BIT);
                    }
                }
                g_gl.p_glBlitFramebuffer(srcX0, srcY0, srcX1, srcY1, nx0, ny0, nx1, ny1, mask, filter);
                if (was_scissor && g_gl.p_glEnable) {
                    g_gl.p_glEnable(GL_SCISSOR_TEST);
                }
                g_gl.w3d_scaled_in_blit = true;
                g_gl.last_present_was_gl = true;
                return;
            }
        }
    }

    g_gl.p_glBlitFramebuffer(srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter);
}

static void ds_gl_upscale_wined3d_backbuffer(
    HGLRC            cur_ctx,
    int32_t          vw,
    int32_t          vh,
    int32_t          dst_x,
    int32_t          gl_dst_y,
    int32_t          dw,
    int32_t          dh,
    ds_aspect_mode_t aspect
)
{
    if (vw <= 0 || vh <= 0 || dw <= 0 || dh <= 0) {
        return;
    }

    ds_enter_internal();

    GLint prev_draw_fbo = 0;
    GLint prev_read_fbo = 0;
    if (g_gl.p_glGetIntegerv) {
        g_gl.p_glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prev_draw_fbo);
        g_gl.p_glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prev_read_fbo);
    }

    if (g_gl.w3d_hglrc != cur_ctx) {
        g_gl.w3d_hglrc = cur_ctx;
        g_gl.w3d_fbo_id = 0;
        g_gl.w3d_color_tex = 0;
        g_gl.w3d_w = 0;
        g_gl.w3d_h = 0;
    }

    if (g_gl.w3d_fbo_id == 0 || g_gl.w3d_w != vw || g_gl.w3d_h != vh) {
        GLint prev_tex = 0;
        GLint prev_unpack_pbo = 0;
        if (g_gl.p_glGetIntegerv) {
            g_gl.p_glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev_tex);
            if (g_gl.p_glBindBuffer) {
                g_gl.p_glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &prev_unpack_pbo);
                if (prev_unpack_pbo != 0) {
                    g_gl.p_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
                }
            }
        }
        if (g_gl.w3d_fbo_id == 0) {
            g_gl.p_glGenFramebuffers(1, &g_gl.w3d_fbo_id);
            g_gl.p_glGenTextures(1, &g_gl.w3d_color_tex);
        }
        g_gl.p_glBindTexture(GL_TEXTURE_2D, g_gl.w3d_color_tex);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        g_gl.p_glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, vw, vh, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        g_gl.p_glBindTexture(GL_TEXTURE_2D, (GLuint)prev_tex);
        if (prev_unpack_pbo != 0 && g_gl.p_glBindBuffer) {
            g_gl.p_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, (GLuint)prev_unpack_pbo);
        }

        g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, g_gl.w3d_fbo_id);
        g_gl.p_glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_gl.w3d_color_tex, 0);
        if (g_gl.p_glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prev_draw_fbo);
            g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prev_read_fbo);
            ds_leave_internal();
            return;
        }
        g_gl.w3d_w = vw;
        g_gl.w3d_h = vh;
    }

    GLboolean was_scissor = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_SCISSOR_TEST) : GL_FALSE;
    if (was_scissor && g_gl.p_glDisable) {
        g_gl.p_glDisable(GL_SCISSOR_TEST);
    }

    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_gl.w3d_fbo_id);
    if (g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_BACK);
    if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_COLOR_ATTACHMENT0);
    g_gl.p_glBlitFramebuffer(0, 0, vw, vh, 0, 0, vw, vh, GL_COLOR_BUFFER_BIT, GL_NEAREST);

    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, g_gl.w3d_fbo_id);
    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    if (g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_COLOR_ATTACHMENT0);
    if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);

    if (g_gl.p_glClearColor && g_gl.p_glClear) {
        g_gl.p_glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
        g_gl.p_glClear(GL_COLOR_BUFFER_BIT);
    }

    GLenum filter = (aspect == DS_ASPECT_INTEGER) ? GL_NEAREST : GL_LINEAR;
    g_gl.p_glBlitFramebuffer(0, 0, vw, vh, dst_x, gl_dst_y, dst_x + dw, gl_dst_y + dh, GL_COLOR_BUFFER_BIT, filter);

    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prev_draw_fbo);
    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prev_read_fbo);
    if (prev_draw_fbo == 0 && g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);
    if (prev_read_fbo == 0 && g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_BACK);

    if (was_scissor && g_gl.p_glEnable) {
        g_gl.p_glEnable(GL_SCISSOR_TEST);
    }

    ds_leave_internal();
}

/* -------------------------------------------------------------------------
 * Bijective `game_hdc <-> host_hdc` Redirection onto `OneLauncherGLHostChild`
 *
 * On macOS CrossOver (`winemac.drv`), once an OpenGL drawable/context attaches
 * directly to `g_ds.hwnd_game`, `-[WineOpenGLContext clearDrawableLeavingSurfaceOnScreen]`
 * intentionally leaves the opaque `CGLSurface` / `CAOpenGLLayer` pinned above
 * `hwnd_game`'s GDI `CALayer` even after `wglMakeCurrent(NULL, NULL)` and
 * `wglDeleteContext`, occluding subsequent 2D GDI screens (such as Jedi Knight's
 * in-game `ESC` menu).
 *
 * By redirecting all WGL / pixel-format operations targeting `hwnd_game` onto
 * a dedicated full-client child window (`g_ds.hwnd_gl_host`):
 *   1. `hwnd_game` itself stays a 100% pure GDI surface and never acquires an
 *      `opengl_drawable` or `CGLSurface`.
 *   2. During 2D GDI presentation after 3D gameplay, `ds_reset_gl_host_for_gdi()`
 *      destroys the 3D `hwnd_gl_host` (`[hostClientView removeFromSuperview]`),
 *      detaching all OpenGL layers/surfaces from the Cocoa window immediately
 *      and recreating a clean hidden child ready for the next 3D session.
 * ------------------------------------------------------------------------- */

void ds_gl_release_all_host_dcs_for_hwnd(HWND host_hwnd)
{
    ds_gl_dc_entry_t to_free[DS_MAX_GL_DC_MAP];
    int count = 0;

    EnterCriticalSection(&g_ds.lock);
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].host_hdc != NULL &&
            (host_hwnd == NULL || g_gl.dc_map[i].host_hwnd == host_hwnd)) {
            to_free[count++] = g_gl.dc_map[i];
            memset(&g_gl.dc_map[i], 0, sizeof(g_gl.dc_map[i]));
        }
    }
    LeaveCriticalSection(&g_ds.lock);

    if (count > 0) {
        ds_enter_internal();
        for (int i = 0; i < count; i++) {
            if (to_free[i].host_hwnd && to_free[i].host_hdc && IsWindow(to_free[i].host_hwnd)) {
                if (g_ds.real_ReleaseDC) {
                    g_ds.real_ReleaseDC(to_free[i].host_hwnd, to_free[i].host_hdc);
                } else {
                    ReleaseDC(to_free[i].host_hwnd, to_free[i].host_hdc);
                }
            }
        }
        ds_leave_internal();
    }
}

void ds_gl_on_release_dc(HWND hwnd, HDC hdc)
{
    (void)hwnd;
    if (!hdc) return;

    ds_gl_dc_entry_t victim = { 0 };
    EnterCriticalSection(&g_ds.lock);
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].game_hdc == hdc) {
            victim = g_gl.dc_map[i];
            memset(&g_gl.dc_map[i], 0, sizeof(g_gl.dc_map[i]));
            break;
        }
    }
    LeaveCriticalSection(&g_ds.lock);

    if (victim.host_hdc && victim.host_hwnd && IsWindow(victim.host_hwnd)) {
        ds_enter_internal();
        if (g_ds.real_ReleaseDC) {
            g_ds.real_ReleaseDC(victim.host_hwnd, victim.host_hdc);
        } else {
            ReleaseDC(victim.host_hwnd, victim.host_hdc);
        }
        ds_leave_internal();
    }
}

static HDC ds_gl_map_hdc_for_wgl(HDC hdc)
{
    if (!hdc || ds_is_internal_call()) {
        return hdc;
    }

    HWND cached_game = NULL;
    HWND cached_host = NULL;
    HDC  cached_host_hdc = NULL;

    EnterCriticalSection(&g_ds.lock);
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].host_hdc == hdc) {
            LeaveCriticalSection(&g_ds.lock);
            return hdc;
        }
        if (g_gl.dc_map[i].game_hdc == hdc &&
            g_gl.dc_map[i].host_hdc != NULL &&
            g_gl.dc_map[i].host_hwnd == g_ds.hwnd_gl_host &&
            g_ds.hwnd_gl_host != NULL) {
            cached_game = g_ds.hwnd_game;
            cached_host = g_gl.dc_map[i].host_hwnd;
            cached_host_hdc = g_gl.dc_map[i].host_hdc;
            break;
        }
    }
    LeaveCriticalSection(&g_ds.lock);

    if (cached_host_hdc != NULL) {
        if (cached_game != NULL && WindowFromDC(hdc) == cached_game && IsWindow(cached_host)) {
            return cached_host_hdc;
        }
        ds_gl_on_release_dc(NULL, hdc);
    }

    HWND win = WindowFromDC(hdc);
    if (!win) {
        return hdc;
    }

    if (win != g_ds.hwnd_gl_host && g_ds.hwnd_game == NULL && ds_is_candidate_game_window(win, NULL, NULL)) {
        ds_attach_and_apply_game_window(win, 0, 0);
    }

    EnterCriticalSection(&g_ds.lock);
    HWND game_hwnd = g_ds.hwnd_game;
    HWND host_hwnd = g_ds.hwnd_gl_host;
    DWORD owner_tid = g_ds.game_thread_id;
    LeaveCriticalSection(&g_ds.lock);

    if (host_hwnd != NULL && win == host_hwnd) {
        return hdc;
    }
    if (!game_hwnd || win != game_hwnd) {
        return hdc;
    }

    if ((!host_hwnd || !IsWindow(host_hwnd)) && GetCurrentThreadId() == owner_tid) {
        ds_ensure_gl_host_child_on_owner_thread(game_hwnd);
        EnterCriticalSection(&g_ds.lock);
        host_hwnd = g_ds.hwnd_gl_host;
        LeaveCriticalSection(&g_ds.lock);
    }

    if (!host_hwnd || !IsWindow(host_hwnd)) {
        return hdc;
    }

    ds_enter_internal();
    HDC host_hdc = GetDCEx(host_hwnd, NULL, DCX_CACHE | DCX_CLIPSIBLINGS);
    ds_leave_internal();
    if (!host_hdc) {
        return hdc;
    }

    ds_gl_dc_entry_t evicted = { 0 };
    EnterCriticalSection(&g_ds.lock);
    int free_slot = -1;
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].game_hdc == hdc && g_gl.dc_map[i].host_hwnd == host_hwnd && g_gl.dc_map[i].host_hdc != NULL) {
            HDC winner = g_gl.dc_map[i].host_hdc;
            LeaveCriticalSection(&g_ds.lock);
            ds_enter_internal();
            if (g_ds.real_ReleaseDC) g_ds.real_ReleaseDC(host_hwnd, host_hdc);
            else ReleaseDC(host_hwnd, host_hdc);
            ds_leave_internal();
            return winner;
        }
        if (free_slot < 0 && g_gl.dc_map[i].host_hdc == NULL) {
            free_slot = i;
        }
    }
    if (free_slot < 0) {
        free_slot = 0;
        evicted = g_gl.dc_map[0];
    }
    g_gl.dc_map[free_slot].game_hdc  = hdc;
    g_gl.dc_map[free_slot].host_hdc  = host_hdc;
    g_gl.dc_map[free_slot].host_hwnd = host_hwnd;
    LeaveCriticalSection(&g_ds.lock);

    if (evicted.host_hdc && evicted.host_hwnd && IsWindow(evicted.host_hwnd)) {
        ds_enter_internal();
        if (g_ds.real_ReleaseDC) g_ds.real_ReleaseDC(evicted.host_hwnd, evicted.host_hdc);
        else ReleaseDC(evicted.host_hwnd, evicted.host_hdc);
        ds_leave_internal();
    }

    if (g_ds.trace_file[0] != L'\0') {
        static volatile LONG s_map_logs = 0;
        if (InterlockedIncrement(&s_map_logs) <= 64) {
            ds_tracef("ds_gl_map_hdc: game_hdc=%p (win=%p) -> host_hdc=%p (host=%p)",
                      hdc, win, host_hdc, host_hwnd);
        }
    }
    return host_hdc;
}

static HDC ds_gl_unmap_host_hdc(HDC hdc)
{
    if (!hdc || ds_is_internal_call()) {
        return hdc;
    }
    HDC mapped = hdc;
    EnterCriticalSection(&g_ds.lock);
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].host_hdc == hdc && g_gl.dc_map[i].game_hdc != NULL) {
            mapped = g_gl.dc_map[i].game_hdc;
            break;
        }
    }
    LeaveCriticalSection(&g_ds.lock);
    return mapped;
}

int WINAPI hook_ReleaseDC(HWND hWnd, HDC hDC)
{
    if (!ds_is_internal_call() && hDC != NULL) {
        ds_gl_on_release_dc(hWnd, hDC);
    }
    return g_ds.real_ReleaseDC ? g_ds.real_ReleaseDC(hWnd, hDC) : 0;
}

BOOL WINAPI hook_DeleteDC(HDC hdc)
{
    if (!ds_is_internal_call() && hdc != NULL) {
        ds_gl_on_release_dc(NULL, hdc);
    }
    return g_ds.real_DeleteDC ? g_ds.real_DeleteDC(hdc) : FALSE;
}

int WINAPI hook_ChoosePixelFormat(HDC hdc, const PIXELFORMATDESCRIPTOR *ppfd)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    return g_ds.real_ChoosePixelFormat ? g_ds.real_ChoosePixelFormat(target_hdc, ppfd) : 0;
}

int WINAPI hook_DescribePixelFormat(HDC hdc, int iPixelFormat, UINT nBytes, LPPIXELFORMATDESCRIPTOR ppfd)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    return g_ds.real_DescribePixelFormat ? g_ds.real_DescribePixelFormat(target_hdc, iPixelFormat, nBytes, ppfd) : 0;
}

int WINAPI hook_GetPixelFormat(HDC hdc)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    return g_ds.real_GetPixelFormat ? g_ds.real_GetPixelFormat(target_hdc) : 0;
}

BOOL WINAPI hook_SetPixelFormat(HDC hdc, int format, const PIXELFORMATDESCRIPTOR *ppfd)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    BOOL ok = g_ds.real_SetPixelFormat ? g_ds.real_SetPixelFormat(target_hdc, format, ppfd) : FALSE;
    if (ok && target_hdc != hdc && format > 0) {
        EnterCriticalSection(&g_ds.lock);
        g_gl.last_host_pf = format;
        if (ppfd) {
            g_gl.last_host_pfd = *ppfd;
            g_gl.has_last_host_pfd = true;
        }
        LeaveCriticalSection(&g_ds.lock);
    }
    return ok;
}

HGLRC WINAPI hook_wglCreateContext(HDC hdc)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    return g_ds.real_wglCreateContext ? g_ds.real_wglCreateContext(target_hdc) : NULL;
}

HGLRC WINAPI hook_wglCreateLayerContext(HDC hdc, int iLayerPlane)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    return g_ds.real_wglCreateLayerContext ? g_ds.real_wglCreateLayerContext(target_hdc, iLayerPlane) : NULL;
}

HDC WINAPI hook_wglGetCurrentDC(void)
{
    HDC cur = g_ds.real_wglGetCurrentDC ? g_ds.real_wglGetCurrentDC() : NULL;
    return ds_gl_unmap_host_hdc(cur);
}

int WINAPI hook_wglChoosePixelFormat(HDC hdc, const PIXELFORMATDESCRIPTOR *ppfd)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    if (g_ds.real_wglChoosePixelFormat) return g_ds.real_wglChoosePixelFormat(target_hdc, ppfd);
    return g_ds.real_ChoosePixelFormat ? g_ds.real_ChoosePixelFormat(target_hdc, ppfd) : 0;
}

int WINAPI hook_wglDescribePixelFormat(HDC hdc, int iPixelFormat, UINT nBytes, LPPIXELFORMATDESCRIPTOR ppfd)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    if (g_ds.real_wglDescribePixelFormat) return g_ds.real_wglDescribePixelFormat(target_hdc, iPixelFormat, nBytes, ppfd);
    return g_ds.real_DescribePixelFormat ? g_ds.real_DescribePixelFormat(target_hdc, iPixelFormat, nBytes, ppfd) : 0;
}

int WINAPI hook_wglGetPixelFormat(HDC hdc)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    if (g_ds.real_wglGetPixelFormat) return g_ds.real_wglGetPixelFormat(target_hdc);
    return g_ds.real_GetPixelFormat ? g_ds.real_GetPixelFormat(target_hdc) : 0;
}

BOOL WINAPI hook_wglSetPixelFormat(HDC hdc, int format, const PIXELFORMATDESCRIPTOR *ppfd)
{
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    BOOL ok = g_ds.real_wglSetPixelFormat
        ? g_ds.real_wglSetPixelFormat(target_hdc, format, ppfd)
        : (g_ds.real_SetPixelFormat ? g_ds.real_SetPixelFormat(target_hdc, format, ppfd) : FALSE);
    if (ok && target_hdc != hdc && format > 0) {
        EnterCriticalSection(&g_ds.lock);
        g_gl.last_host_pf = format;
        if (ppfd) {
            g_gl.last_host_pfd = *ppfd;
            g_gl.has_last_host_pfd = true;
        }
        LeaveCriticalSection(&g_ds.lock);
    }
    return ok;
}

static BOOL WINAPI hook_wglSetPixelFormatWINE(HDC hdc, int format)
{
    if (!g_gl.p_wglSetPixelFormatWINE) {
        return FALSE;
    }
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    BOOL ok = g_gl.p_wglSetPixelFormatWINE(target_hdc, format);
    if (ok && target_hdc != hdc && format > 0) {
        EnterCriticalSection(&g_ds.lock);
        g_gl.last_host_pf = format;
        LeaveCriticalSection(&g_ds.lock);
    }
    return ok;
}

static BOOL WINAPI hook_wglChoosePixelFormatARB(HDC hdc, const int *piAttribIList, const FLOAT *pfAttribFList, UINT nMaxFormats, int *piFormats, UINT *nNumFormats)
{
    if (!g_gl.p_wglChoosePixelFormatARB) return FALSE;
    return g_gl.p_wglChoosePixelFormatARB(ds_gl_map_hdc_for_wgl(hdc), piAttribIList, pfAttribFList, nMaxFormats, piFormats, nNumFormats);
}

static BOOL WINAPI hook_wglGetPixelFormatAttribivARB(HDC hdc, int iPixelFormat, int iLayerPlane, UINT nAttributes, const int *piAttributes, int *piValues)
{
    if (!g_gl.p_wglGetPixelFormatAttribivARB) return FALSE;
    return g_gl.p_wglGetPixelFormatAttribivARB(ds_gl_map_hdc_for_wgl(hdc), iPixelFormat, iLayerPlane, nAttributes, piAttributes, piValues);
}

static BOOL WINAPI hook_wglGetPixelFormatAttribfvARB(HDC hdc, int iPixelFormat, int iLayerPlane, UINT nAttributes, const int *piAttributes, FLOAT *pfValues)
{
    if (!g_gl.p_wglGetPixelFormatAttribfvARB) return FALSE;
    return g_gl.p_wglGetPixelFormatAttribfvARB(ds_gl_map_hdc_for_wgl(hdc), iPixelFormat, iLayerPlane, nAttributes, piAttributes, pfValues);
}

static HGLRC WINAPI hook_wglCreateContextAttribsARB(HDC hDC, HGLRC hShareContext, const int *attribList)
{
    if (!g_gl.p_wglCreateContextAttribsARB) return NULL;
    return g_gl.p_wglCreateContextAttribsARB(ds_gl_map_hdc_for_wgl(hDC), hShareContext, attribList);
}

static const char *WINAPI hook_wglGetExtensionsStringARB(HDC hdc)
{
    if (!g_gl.p_wglGetExtensionsStringARB) return NULL;
    return g_gl.p_wglGetExtensionsStringARB(ds_gl_map_hdc_for_wgl(hdc));
}

static BOOL WINAPI hook_wglMakeContextCurrentARB(HDC hDrawDC, HDC hReadDC, HGLRC hglrc)
{
    if (!g_gl.p_wglMakeContextCurrentARB) return FALSE;
    return g_gl.p_wglMakeContextCurrentARB(ds_gl_map_hdc_for_wgl(hDrawDC), ds_gl_map_hdc_for_wgl(hReadDC), hglrc);
}

static HDC WINAPI hook_wglGetCurrentReadDCARB(void)
{
    if (!g_gl.p_wglGetCurrentReadDCARB) return NULL;
    return ds_gl_unmap_host_hdc(g_gl.p_wglGetCurrentReadDCARB());
}

static BOOL WINAPI hook_wglQueryRendererIntegerWINE(HDC dc, GLint renderer, GLenum param, GLuint *value)
{
    if (!g_gl.p_wglQueryRendererIntegerWINE) return FALSE;
    return g_gl.p_wglQueryRendererIntegerWINE(ds_gl_map_hdc_for_wgl(dc), renderer, param, value);
}

static const char *WINAPI hook_wglQueryRendererStringWINE(HDC dc, GLint renderer, GLenum param)
{
    if (!g_gl.p_wglQueryRendererStringWINE) return NULL;
    return g_gl.p_wglQueryRendererStringWINE(ds_gl_map_hdc_for_wgl(dc), renderer, param);
}

static void *ds_resolve_common_wgl_ext_proc(const char *name, void *real_fn)
{
    if (!name || !real_fn) return real_fn;
    if (strcmp(name, "wglSetPixelFormatWINE") == 0) {
        if (!g_gl.p_wglSetPixelFormatWINE) g_gl.p_wglSetPixelFormatWINE = (pfn_wglSetPixelFormatWINE_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglSetPixelFormatWINE;
    }
    if (strcmp(name, "wglChoosePixelFormatARB") == 0 || strcmp(name, "wglChoosePixelFormatEXT") == 0) {
        if (!g_gl.p_wglChoosePixelFormatARB) g_gl.p_wglChoosePixelFormatARB = (pfn_wglChoosePixelFormatARB_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglChoosePixelFormatARB;
    }
    if (strcmp(name, "wglGetPixelFormatAttribivARB") == 0 || strcmp(name, "wglGetPixelFormatAttribivEXT") == 0) {
        if (!g_gl.p_wglGetPixelFormatAttribivARB) g_gl.p_wglGetPixelFormatAttribivARB = (pfn_wglGetPixelFormatAttribivARB_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglGetPixelFormatAttribivARB;
    }
    if (strcmp(name, "wglGetPixelFormatAttribfvARB") == 0 || strcmp(name, "wglGetPixelFormatAttribfvEXT") == 0) {
        if (!g_gl.p_wglGetPixelFormatAttribfvARB) g_gl.p_wglGetPixelFormatAttribfvARB = (pfn_wglGetPixelFormatAttribfvARB_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglGetPixelFormatAttribfvARB;
    }
    if (strcmp(name, "wglCreateContextAttribsARB") == 0) {
        if (!g_gl.p_wglCreateContextAttribsARB) g_gl.p_wglCreateContextAttribsARB = (pfn_wglCreateContextAttribsARB_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglCreateContextAttribsARB;
    }
    if (strcmp(name, "wglGetExtensionsStringARB") == 0) {
        if (!g_gl.p_wglGetExtensionsStringARB) g_gl.p_wglGetExtensionsStringARB = (pfn_wglGetExtensionsStringARB_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglGetExtensionsStringARB;
    }
    if (strcmp(name, "wglMakeContextCurrentARB") == 0 || strcmp(name, "wglMakeContextCurrentEXT") == 0) {
        if (!g_gl.p_wglMakeContextCurrentARB) g_gl.p_wglMakeContextCurrentARB = (pfn_wglMakeContextCurrentARB_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglMakeContextCurrentARB;
    }
    if (strcmp(name, "wglGetCurrentReadDCARB") == 0 || strcmp(name, "wglGetCurrentReadDCEXT") == 0) {
        if (!g_gl.p_wglGetCurrentReadDCARB) g_gl.p_wglGetCurrentReadDCARB = (pfn_wglGetCurrentReadDCARB_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglGetCurrentReadDCARB;
    }
    if (strcmp(name, "wglQueryRendererIntegerWINE") == 0) {
        if (!g_gl.p_wglQueryRendererIntegerWINE) g_gl.p_wglQueryRendererIntegerWINE = (pfn_wglQueryRendererIntegerWINE_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglQueryRendererIntegerWINE;
    }
    if (strcmp(name, "wglQueryRendererStringWINE") == 0) {
        if (!g_gl.p_wglQueryRendererStringWINE) g_gl.p_wglQueryRendererStringWINE = (pfn_wglQueryRendererStringWINE_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglQueryRendererStringWINE;
    }
    if (strcmp(name, "wglGetPixelFormat") == 0) {
        if (!g_ds.real_wglGetPixelFormat) g_ds.real_wglGetPixelFormat = (pfn_wglGetPixelFormat_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglGetPixelFormat;
    }
    if (strcmp(name, "wglSetPixelFormat") == 0) {
        if (!g_ds.real_wglSetPixelFormat) g_ds.real_wglSetPixelFormat = (pfn_wglSetPixelFormat_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglSetPixelFormat;
    }
    if (strcmp(name, "wglChoosePixelFormat") == 0) {
        if (!g_ds.real_wglChoosePixelFormat) g_ds.real_wglChoosePixelFormat = (pfn_wglChoosePixelFormat_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglChoosePixelFormat;
    }
    if (strcmp(name, "wglDescribePixelFormat") == 0) {
        if (!g_ds.real_wglDescribePixelFormat) g_ds.real_wglDescribePixelFormat = (pfn_wglDescribePixelFormat_t)(uintptr_t)real_fn;
        return (void *)(uintptr_t)hook_wglDescribePixelFormat;
    }
    return real_fn;
}

void *ds_resolve_wined3d_gl_proc(const char *name, void *real_fn)
{
    if (!name || !real_fn) return real_fn;
    if (strcmp(name, "glBlitFramebuffer") == 0 || strcmp(name, "glBlitFramebufferEXT") == 0) {
        if (!g_gl.p_glBlitFramebuffer) {
            g_gl.p_glBlitFramebuffer = (pfn_glBlitFramebuffer_t)(uintptr_t)real_fn;
        }
        return (void *)(uintptr_t)hook_glBlitFramebuffer;
    }
    return ds_resolve_common_wgl_ext_proc(name, real_fn);
}

void *ds_resolve_gl_hook_proc(const char *name, void *real_fn)
{
    if (!name || !real_fn) return real_fn;
    if (strcmp(name, "glBlitFramebuffer") == 0 || strcmp(name, "glBlitFramebufferEXT") == 0) {
        if (!g_gl.p_glBlitFramebuffer) {
            g_gl.p_glBlitFramebuffer = (pfn_glBlitFramebuffer_t)(uintptr_t)real_fn;
        }
        return (void *)(uintptr_t)hook_glBlitFramebuffer;
    }
    void *wgl_ext = ds_resolve_common_wgl_ext_proc(name, real_fn);
    if (wgl_ext != real_fn) {
        return wgl_ext;
    }
    if (strcmp(name, "glBindFramebuffer") == 0 || strcmp(name, "glBindFramebufferEXT") == 0) {
        if (!g_gl.p_glBindFramebuffer) {
            g_gl.p_glBindFramebuffer = (pfn_glBindFramebuffer_t)(uintptr_t)real_fn;
        }
        return (void *)(uintptr_t)hook_glBindFramebuffer;
    }
    if (strcmp(name, "glDrawBuffer") == 0) {
        if (!g_ds.real_glDrawBuffer) {
            g_ds.real_glDrawBuffer = (pfn_glDrawBuffer_t)(uintptr_t)real_fn;
        }
        return (void *)(uintptr_t)hook_glDrawBuffer;
    }
    if (strcmp(name, "glReadBuffer") == 0) {
        if (!g_ds.real_glReadBuffer) {
            g_ds.real_glReadBuffer = (pfn_glReadBuffer_t)(uintptr_t)real_fn;
        }
        return (void *)(uintptr_t)hook_glReadBuffer;
    }
    return real_fn;
}

PROC WINAPI hook_wglGetProcAddress(LPCSTR lpszProc)
{
    if (!g_ds.real_wglGetProcAddress) return NULL;
    const void *caller_ret = __builtin_return_address(0);
    PROC real_fn = g_ds.real_wglGetProcAddress(lpszProc);
    if (!real_fn || !lpszProc || ds_is_internal_call()) {
        return real_fn;
    }
    if (ds_is_wined3d_caller(caller_ret)) {
        return (PROC)(uintptr_t)ds_resolve_wined3d_gl_proc(lpszProc, (void *)(uintptr_t)real_fn);
    }
    if (ds_is_system_renderer_caller(caller_ret)) {
        return real_fn;
    }
    return (PROC)(uintptr_t)ds_resolve_gl_hook_proc(lpszProc, (void *)(uintptr_t)real_fn);
}

static void ds_gl_ensure_wgl_query_procs(void)
{
    if (g_gl.p_wglGetCurrentContext && g_gl.p_wglGetCurrentDC && g_gl.p_wglSetPixelFormatWINE) {
        return;
    }
    HMODULE h_gl = GetModuleHandleW(L"opengl32.dll");
    if (!h_gl || !g_ds.real_GetProcAddress) {
        return;
    }
    if (!g_gl.p_wglGetCurrentContext) {
        g_gl.p_wglGetCurrentContext = (pfn_wglGetCurrentContext_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "wglGetCurrentContext");
    }
    if (!g_gl.p_wglGetCurrentDC) {
        g_gl.p_wglGetCurrentDC = (pfn_wglGetCurrentDC_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "wglGetCurrentDC");
    }
    if (!g_gl.p_wglSetPixelFormatWINE) {
        FARPROC wpf = g_ds.real_GetProcAddress(h_gl, "wglSetPixelFormatWINE");
        if (!wpf && g_ds.real_wglGetProcAddress) {
            ds_enter_internal();
            wpf = (FARPROC)g_ds.real_wglGetProcAddress("wglSetPixelFormatWINE");
            ds_leave_internal();
        }
        if (wpf) {
            g_gl.p_wglSetPixelFormatWINE = (pfn_wglSetPixelFormatWINE_t)(uintptr_t)wpf;
        }
    }
}

BOOL WINAPI hook_wglMakeCurrent(HDC hdc, HGLRC hglrc)
{
    if (!g_ds.real_wglMakeCurrent) return FALSE;
    if (ds_is_internal_call()) {
        return g_ds.real_wglMakeCurrent(hdc, hglrc);
    }

    const void *caller_ret = __builtin_return_address(0);
    bool is_wined3d = ds_is_wined3d_caller(caller_ret);
    bool is_sys = ds_is_system_renderer_caller(caller_ret);
    HWND win = hdc ? WindowFromDC(hdc) : NULL;

    if (win && win != g_ds.hwnd_gl_host && g_ds.hwnd_game == NULL && ds_is_candidate_game_window(win, NULL, NULL)) {
        ds_attach_and_apply_game_window(win, 0, 0);
    }

    HDC target_hdc = hdc ? ds_gl_map_hdc_for_wgl(hdc) : NULL;
    if (target_hdc && target_hdc != hdc && hglrc != NULL) {
        ds_enter_internal();
        int cur_pf = g_ds.real_GetPixelFormat ? g_ds.real_GetPixelFormat(target_hdc) : GetPixelFormat(target_hdc);
        if (cur_pf == 0) {
            EnterCriticalSection(&g_ds.lock);
            int saved_pf = g_gl.last_host_pf;
            bool has_pfd = g_gl.has_last_host_pfd;
            PIXELFORMATDESCRIPTOR saved_pfd = g_gl.last_host_pfd;
            LeaveCriticalSection(&g_ds.lock);
            if (saved_pf > 0) {
                if (g_gl.p_wglSetPixelFormatWINE) {
                    g_gl.p_wglSetPixelFormatWINE(target_hdc, saved_pf);
                } else if (g_ds.real_SetPixelFormat) {
                    g_ds.real_SetPixelFormat(target_hdc, saved_pf, has_pfd ? &saved_pfd : NULL);
                }
            }
        }
        ds_leave_internal();
    }

    BOOL ok = g_ds.real_wglMakeCurrent(target_hdc, hglrc);
    if (g_ds.trace_file[0] != L'\0') {
        static volatile LONG s_wgl_calls = 0;
        if (InterlockedIncrement(&s_wgl_calls) <= 200) {
            ds_tracef("hook_wglMakeCurrent: hdc=%p->%p win=%p hglrc=%p ok=%d is_wined3d=%d",
                      hdc, target_hdc, win, hglrc, (int)ok, (int)is_wined3d);
        }
    }

    if (!ok || !hdc || !hglrc) {
        if ((!hglrc || !hdc) && !is_wined3d && !is_sys) {
            g_gl.game_hglrc = NULL;
        }
        return ok;
    }

    if (!g_gl.p_wglSetPixelFormatWINE) {
        ds_gl_ensure_wgl_query_procs();
    }

    if (is_wined3d) {
        EnterCriticalSection(&g_ds.lock);
        g_ds.wined3d_uses_gl = true;
        LeaveCriticalSection(&g_ds.lock);
        return ok;
    }
    if (is_sys) {
        return ok;
    }

    if (win && win != g_ds.hwnd_gl_host && (g_ds.hwnd_game == NULL || g_ds.hwnd_game != win) && ds_is_candidate_game_window(win, NULL, NULL)) {
        ds_attach_and_apply_game_window(win, 0, 0);
    }

    EnterCriticalSection(&g_ds.lock);
    bool is_game_win = (
        win != NULL &&
        (win == g_ds.hwnd_game || win == g_ds.hwnd_gl_host || (g_ds.hwnd_game != NULL && IsChild(g_ds.hwnd_game, win)))
    );
    bool fs_active = g_ds.fullscreen_active;
    int32_t win_scale = ds_get_windowed_scale_locked();
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
    int32_t dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
    bool want_fbo = fs_active || (win_scale > 1);
    LeaveCriticalSection(&g_ds.lock);

    if (is_game_win) {
        if (g_gl.fbo_ctx != hglrc) {
            g_gl.fbo_ctx = hglrc;
            g_gl.fbo_id = 0;
            g_gl.color_tex = 0;
            g_gl.depth_rb = 0;
            g_gl.fbo_w = 0;
            g_gl.fbo_h = 0;
            g_gl.fbo_redirect_active = false;
            g_gl.game_draw_fbo = 0;
            g_gl.game_read_fbo = 0;
        }
        g_gl.game_hglrc = hglrc;
        ds_gl_sync_fbo_for_current_ctx(vw, vh, dw, dh, want_fbo);
    }
    return ok;
}

BOOL WINAPI hook_wglDeleteContext(HGLRC hglrc)
{
    if (hglrc && (hglrc == g_gl.game_hglrc || hglrc == g_gl.fbo_ctx)) {
        g_gl.game_hglrc = NULL;
        g_gl.fbo_ctx = NULL;
        g_gl.fbo_id = 0;
        g_gl.color_tex = 0;
        g_gl.depth_rb = 0;
        g_gl.fbo_w = 0;
        g_gl.fbo_h = 0;
        g_gl.fbo_redirect_active = false;
        g_gl.game_draw_fbo = 0;
        g_gl.game_read_fbo = 0;
    }
    if (hglrc && hglrc == g_gl.w3d_hglrc) {
        g_gl.w3d_hglrc = NULL;
        g_gl.w3d_fbo_id = 0;
        g_gl.w3d_color_tex = 0;
        g_gl.w3d_w = 0;
        g_gl.w3d_h = 0;
    }
    return g_ds.real_wglDeleteContext ? g_ds.real_wglDeleteContext(hglrc) : FALSE;
}

static void ds_gl_rebind_drawable_if_pending(HDC target_hdc)
{
    if (InterlockedCompareExchange(&g_ds.gl_drawable_rebind_pending, 0, 1) != 1) {
        return;
    }
    ds_gl_ensure_wgl_query_procs();
    HGLRC rebind_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
    HDC cur_dc = g_gl.p_wglGetCurrentDC ? g_gl.p_wglGetCurrentDC() : NULL;
    HDC read_dc = g_gl.p_wglGetCurrentReadDCARB ? g_gl.p_wglGetCurrentReadDCARB() : cur_dc;
    if (rebind_ctx != NULL && g_ds.real_wglMakeCurrent && (read_dc == NULL || read_dc == cur_dc)) {
        ds_enter_internal();
        g_ds.real_wglMakeCurrent(target_hdc, rebind_ctx);
        ds_leave_internal();
    }
}

static BOOL ds_present_gl_and_swap(HDC hdc, bool use_wgl_swap, const void *caller_ret)
{
    if (!hdc || ds_is_internal_call()) {
        return use_wgl_swap
            ? (g_ds.real_wglSwapBuffers ? g_ds.real_wglSwapBuffers(hdc) : FALSE)
            : (g_ds.real_SwapBuffers ? g_ds.real_SwapBuffers(hdc) : FALSE);
    }

    if (ds_is_wined3d_caller(caller_ret)) {
        HWND win = WindowFromDC(hdc);
        if (win && win != g_ds.hwnd_gl_host && g_ds.hwnd_game == NULL && ds_is_candidate_game_window(win, NULL, NULL)) {
            ds_attach_and_apply_game_window(win, 0, 0);
        } else if (win && win == g_ds.hwnd_game) {
            ds_ensure_game_window_bounds(win);
        }

        HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);

        EnterCriticalSection(&g_ds.lock);
        g_ds.wined3d_uses_gl = true;
        bool is_game_win = (
            win != NULL &&
            (win == g_ds.hwnd_game || win == g_ds.hwnd_gl_host || (g_ds.hwnd_game != NULL && IsChild(g_ds.hwnd_game, win)))
        );
        if (is_game_win) {
            g_gl.last_present_was_gl = true;
        }
        bool fs_active = g_ds.fullscreen_active;
        int32_t win_scale = ds_get_windowed_scale_locked();
        ds_aspect_mode_t aspect = fs_active ? g_ds.aspect_mode : DS_ASPECT_PRESERVE;
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        int32_t dst_x = fs_active ? g_ds.vp.dst_x : 0;
        int32_t dst_y = fs_active ? g_ds.vp.dst_y : 0;
        int32_t dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
        int32_t dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
        int32_t real_h = fs_active ? g_ds.real_screen_h : dh;
        bool want_scale = fs_active || (win_scale > 1);
        LeaveCriticalSection(&g_ds.lock);

        if (is_game_win) {
            ds_set_gl_host_visible(true);
            ds_gl_ensure_wgl_query_procs();
            HGLRC swap_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
            if (g_ds.trace_file[0] != L'\0' && InterlockedDecrement(&g_gl.mode_trace_budget) >= 0) {
                ds_tracef("wined3d_swap: win=%p hdc=%p->%p ctx=%p vw=%dx%d dw=%dx%d scaled_in_blit=%d",
                          win, hdc, target_hdc, swap_ctx, (int)vw, (int)vh, (int)dw, (int)dh, (int)g_gl.w3d_scaled_in_blit);
            }
            if (!g_gl.w3d_scaled_in_blit && want_scale && vw > 0 && vh > 0 && dw > 0 && dh > 0 &&
                (vw != dw || vh != dh) && ds_gl_init_procs_once()) {
                HGLRC cur_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
                if (cur_ctx != NULL) {
                    int32_t gl_dst_y = real_h - (dst_y + dh);
                    ds_gl_upscale_wined3d_backbuffer(cur_ctx, vw, vh, dst_x, gl_dst_y, dw, dh, aspect);
                }
            }
        }
        g_gl.w3d_scaled_in_blit = false;

        ds_enter_internal();
        BOOL w3d_swapped = use_wgl_swap
            ? (g_ds.real_wglSwapBuffers ? g_ds.real_wglSwapBuffers(target_hdc) : FALSE)
            : (g_ds.real_SwapBuffers ? g_ds.real_SwapBuffers(target_hdc) : FALSE);
        ds_leave_internal();

        if (is_game_win) {
            ds_gl_rebind_drawable_if_pending(target_hdc);
        }
        return w3d_swapped;
    }

    if (ds_is_system_renderer_caller(caller_ret)) {
        return use_wgl_swap
            ? (g_ds.real_wglSwapBuffers ? g_ds.real_wglSwapBuffers(hdc) : FALSE)
            : (g_ds.real_SwapBuffers ? g_ds.real_SwapBuffers(hdc) : FALSE);
    }

    HWND win = WindowFromDC(hdc);
    if (win && win != g_ds.hwnd_gl_host && (g_ds.hwnd_game == NULL || g_ds.hwnd_game != win) && ds_is_candidate_game_window(win, NULL, NULL)) {
        ds_attach_and_apply_game_window(win, 0, 0);
    } else if (win && win == g_ds.hwnd_game) {
        ds_ensure_game_window_bounds(win);
    }

    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);

    EnterCriticalSection(&g_ds.lock);
    bool is_game_win = (
        win != NULL &&
        (win == g_ds.hwnd_game || win == g_ds.hwnd_gl_host || (g_ds.hwnd_game != NULL && IsChild(g_ds.hwnd_game, win)))
    );
    bool fs_active = g_ds.fullscreen_active;
    int32_t win_scale = ds_get_windowed_scale_locked();
    ds_aspect_mode_t aspect = fs_active ? g_ds.aspect_mode : DS_ASPECT_PRESERVE;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t dst_x = fs_active ? g_ds.vp.dst_x : 0;
    int32_t dst_y = fs_active ? g_ds.vp.dst_y : 0;
    int32_t dst_w = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
    int32_t dst_h = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
    int32_t dw = dst_w;
    int32_t dh = dst_h;
    int32_t real_h = fs_active ? g_ds.real_screen_h : dst_h;
    bool want_fbo = fs_active || (win_scale > 1);
    LeaveCriticalSection(&g_ds.lock);

    if (is_game_win && ds_gl_init_procs_once()) {
        HGLRC cur_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
        if (cur_ctx != NULL) {
            if (g_gl.game_hglrc != cur_ctx || g_gl.fbo_ctx != cur_ctx) {
                g_gl.game_hglrc = cur_ctx;
                ds_gl_sync_fbo_for_current_ctx(vw, vh, dw, dh, want_fbo);
            }
            if (cur_ctx == g_gl.game_hglrc) {
                EnterCriticalSection(&g_ds.lock);
                g_gl.last_present_was_gl = true;
                LeaveCriticalSection(&g_ds.lock);
                ds_set_gl_host_visible(true);
                if (g_gl.fbo_redirect_active && g_gl.fbo_id != 0 && want_fbo && dw > 0 && dh > 0) {
                    GLint dx0 = dst_x;
                    GLint dy0 = real_h - (dst_y + dst_h);
                    GLint dx1 = dst_x + dst_w;
                    GLint dy1 = dy0 + dst_h;
                    GLboolean was_scissor = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_SCISSOR_TEST) : GL_FALSE;
                    if (was_scissor && g_gl.p_glDisable) {
                        g_gl.p_glDisable(GL_SCISSOR_TEST);
                    }

                    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, g_gl.fbo_id);
                    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
                    if (g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_COLOR_ATTACHMENT0);
                    if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);

                    if (g_gl.p_glClearColor && g_gl.p_glClear) {
                        g_gl.p_glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
                        g_gl.p_glClear(GL_COLOR_BUFFER_BIT);
                    }

                    GLenum filter = (aspect == DS_ASPECT_INTEGER) ? GL_NEAREST : GL_LINEAR;
                    g_gl.p_glBlitFramebuffer(0, 0, g_gl.fbo_w, g_gl.fbo_h, dx0, dy0, dx1, dy1, GL_COLOR_BUFFER_BIT, filter);

                    if (was_scissor && g_gl.p_glEnable) {
                        g_gl.p_glEnable(GL_SCISSOR_TEST);
                    }
                }

                ds_enter_internal();
                BOOL swapped = use_wgl_swap
                    ? (g_ds.real_wglSwapBuffers ? g_ds.real_wglSwapBuffers(target_hdc) : FALSE)
                    : (g_ds.real_SwapBuffers ? g_ds.real_SwapBuffers(target_hdc) : FALSE);
                ds_leave_internal();

                ds_gl_rebind_drawable_if_pending(target_hdc);

                /* Prepare FBO (or unbind to 0 if unscaled windowed) for next frame */
                EnterCriticalSection(&g_ds.lock);
                fs_active = g_ds.fullscreen_active;
                win_scale = ds_get_windowed_scale_locked();
                vw = g_ds.virt_w;
                vh = g_ds.virt_h;
                dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
                dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
                want_fbo = fs_active || (win_scale > 1);
                LeaveCriticalSection(&g_ds.lock);
                ds_gl_sync_fbo_for_current_ctx(vw, vh, dw, dh, want_fbo);
                return swapped;
            }
        }
    }

    return use_wgl_swap
        ? (g_ds.real_wglSwapBuffers ? g_ds.real_wglSwapBuffers(target_hdc) : FALSE)
        : (g_ds.real_SwapBuffers ? g_ds.real_SwapBuffers(target_hdc) : FALSE);
}

BOOL WINAPI hook_SwapBuffers(HDC hdc)
{
    return ds_present_gl_and_swap(hdc, false, __builtin_return_address(0));
}

BOOL WINAPI hook_wglSwapBuffers(HDC hdc)
{
    return ds_present_gl_and_swap(hdc, true, __builtin_return_address(0));
}

void ds_gl_notify_mode_changed(void)
{
    if (!g_gl.fbo_supported || !g_gl.p_wglGetCurrentContext || g_gl.game_hglrc == NULL) {
        return;
    }
    if (g_gl.p_wglGetCurrentContext() == g_gl.game_hglrc) {
        EnterCriticalSection(&g_ds.lock);
        bool fs_active = g_ds.fullscreen_active;
        int32_t win_scale = ds_get_windowed_scale_locked();
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        int32_t dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
        int32_t dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
        bool want_fbo = fs_active || (win_scale > 1);
        LeaveCriticalSection(&g_ds.lock);
        ds_gl_sync_fbo_for_current_ctx(vw, vh, dw, dh, want_fbo);
    }
}

void ds_gl_notify_display_mode_switch(void)
{
    InterlockedExchange(&g_gl.mode_trace_budget, 16);
}

void ds_gl_shutdown(void)
{
    g_gl.game_hglrc = NULL;
    g_gl.w3d_hglrc = NULL;
    g_gl.fbo_redirect_active = false;
    g_gl.last_present_was_gl = false;
    ds_gl_release_all_host_dcs_for_hwnd(NULL);
}

/* -------------------------------------------------------------------------
 * GDI 2D Stretch Presenter (Legacy 2D menus, Smacker/Bink FMVs, Win9x GDI)
 * ------------------------------------------------------------------------- */

static void ds_clear_gdi_margins(HDC hdcDst, int32_t dx, int32_t dy, int32_t dw, int32_t dh, bool force_clear)
{
    static HWND    s_last_win = NULL;
    static int32_t s_last_dx = -1, s_last_dy = -1, s_last_dw = -1, s_last_dh = -1;

    if (!g_ds.fullscreen_active) {
        return;
    }

    HWND win = WindowFromDC(hdcDst);
    if (!force_clear && win == s_last_win &&
        dx == s_last_dx && dy == s_last_dy && dw == s_last_dw && dh == s_last_dh) {
        return;
    }
    s_last_win = win;
    s_last_dx = dx;
    s_last_dy = dy;
    s_last_dw = dw;
    s_last_dh = dh;

    int32_t sw = g_ds.real_screen_w;
    int32_t sh = g_ds.real_screen_h;
    if (sw <= 0 || sh <= 0) return;

    ds_enter_internal();
    if (dx > 0) {
        PatBlt(hdcDst, 0, 0, dx, sh, BLACKNESS);
    }
    if (dx + dw < sw) {
        PatBlt(hdcDst, dx + dw, 0, sw - (dx + dw), sh, BLACKNESS);
    }
    if (dy > 0) {
        PatBlt(hdcDst, dx, 0, dw, dy, BLACKNESS);
    }
    if (dy + dh < sh) {
        PatBlt(hdcDst, dx, dy + dh, dw, sh - (dy + dh), BLACKNESS);
    }
    ds_leave_internal();
}

static bool ds_should_scale_gdi_dc(HDC hdcDst, const void *caller_ret, int32_t *out_vw, int32_t *out_vh, int32_t *out_dx, int32_t *out_dy, int32_t *out_dw, int32_t *out_dh)
{
    (void)caller_ret;
    if (!hdcDst || ds_is_internal_call()) {
        return false;
    }
    if (GetObjectType(hdcDst) != OBJ_DC) {
        return false;
    }
    HWND win = WindowFromDC(hdcDst);
    if (!win || win == g_ds.hwnd_gl_host) {
        return false;
    }

    bool need_reset_gl_host = false;
    EnterCriticalSection(&g_ds.lock);
    int32_t win_scale = ds_get_windowed_scale_locked();
    bool is_game_gdi_target = (
        win == g_ds.hwnd_game ||
        win == GetDesktopWindow() ||
        (g_ds.hwnd_game != NULL && IsChild(g_ds.hwnd_game, win))
    );
    bool match = false;
    if (g_ds.fullscreen_active) {
        match = (
            is_game_gdi_target &&
            g_ds.virt_w > 0 &&
            g_ds.virt_h > 0 &&
            g_ds.vp.dst_w > 0 &&
            g_ds.vp.dst_h > 0 &&
            (g_ds.vp.dst_w != g_ds.virt_w || g_ds.vp.dst_h != g_ds.virt_h)
        );
        if (match) {
            *out_vw = g_ds.virt_w;
            *out_vh = g_ds.virt_h;
            *out_dx = g_ds.vp.dst_x;
            *out_dy = g_ds.vp.dst_y;
            *out_dw = g_ds.vp.dst_w;
            *out_dh = g_ds.vp.dst_h;
        }
    } else if (win_scale > 1 && g_ds.virt_w > 0 && g_ds.virt_h > 0 &&
               (win == g_ds.hwnd_game || (g_ds.hwnd_game != NULL && IsChild(g_ds.hwnd_game, win)))) {
        match = true;
        *out_vw = g_ds.virt_w;
        *out_vh = g_ds.virt_h;
        *out_dx = 0;
        *out_dy = 0;
        *out_dw = g_ds.virt_w * win_scale;
        *out_dh = g_ds.virt_h * win_scale;
    }
    if (is_game_gdi_target && (g_gl.last_present_was_gl || g_ds.gl_host_visible)) {
        g_gl.last_present_was_gl = false;
        need_reset_gl_host = true;
    }
    LeaveCriticalSection(&g_ds.lock);

    if (need_reset_gl_host) {
        ds_reset_gl_host_for_gdi();
    }
    if (g_ds.trace_file[0] != L'\0' && is_game_gdi_target && InterlockedDecrement(&g_gl.mode_trace_budget) >= 0) {
        ds_tracef("gdi_present: win=%p match=%d reset_gl_host=%d vw=%dx%d",
                  win, (int)match, (int)need_reset_gl_host, (int)g_ds.virt_w, (int)g_ds.virt_h);
    }
    return match;
}

int WINAPI hook_GetDeviceCaps(HDC hdc, int index)
{
    if (!ds_is_internal_call() && !ds_is_system_renderer_caller(__builtin_return_address(0))) {
        if (hdc == NULL || GetObjectType(hdc) == OBJ_DC) {
            EnterCriticalSection(&g_ds.lock);
            bool active = g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0;
            int32_t vw = g_ds.virt_w;
            int32_t vh = g_ds.virt_h;
            int32_t vbpp = g_ds.virt_bpp > 0 ? g_ds.virt_bpp : g_ds.real_bpp;
            int32_t vhz = g_ds.virt_hz > 0 ? g_ds.virt_hz : g_ds.real_hz;
            LeaveCriticalSection(&g_ds.lock);

            if (active) {
                if (index == HORZRES || index == DESKTOPHORZRES) return vw;
                if (index == VERTRES || index == DESKTOPVERTRES) return vh;
                if (index == BITSPIXEL) {
                    if (g_ds.legacy_d3d_loaded && vbpp > 16) return 16;
                    if (vbpp >= 8) return vbpp;
                }
                if (index == PLANES) return 1;
                if (index == VREFRESH && vhz > 0) return vhz;
            }
            int real_val = g_ds.real_GetDeviceCaps ? g_ds.real_GetDeviceCaps(hdc, index) : 0;
            if (index == BITSPIXEL) {
                if (g_ds.legacy_d3d_loaded) return 16;
                if (real_val < 8) return (vbpp >= 8) ? vbpp : 32;
            }
            if (index == PLANES && real_val < 1) return 1;
            return real_val;
        }
    }
    return g_ds.real_GetDeviceCaps ? g_ds.real_GetDeviceCaps(hdc, index) : 0;
}

BOOL WINAPI hook_BitBlt(HDC hdcDst, int x, int y, int cx, int cy, HDC hdcSrc, int x1, int y1, DWORD rop)
{
    int32_t vw = 0, vh = 0, dx = 0, dy = 0, dw = 0, dh = 0;
    if (hdcSrc != hdcDst && cx > 0 && cy > 0 && g_ds.real_StretchBlt &&
        ds_should_scale_gdi_dc(hdcDst, __builtin_return_address(0), &vw, &vh, &dx, &dy, &dw, &dh)) {
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        if (ds_map_subrect_virt_to_phys(x, y, cx, cy, dx, dy, dw, dh, vw, vh, &px, &py, &pw, &ph)) {
            ds_clear_gdi_margins(hdcDst, dx, dy, dw, dh, (x <= 0 && y <= 0 && cx >= vw && cy >= vh));
            SetStretchBltMode(hdcDst, COLORONCOLOR);
            return g_ds.real_StretchBlt(hdcDst, px, py, pw, ph, hdcSrc, x1, y1, cx, cy, rop);
        }
    }
    return g_ds.real_BitBlt ? g_ds.real_BitBlt(hdcDst, x, y, cx, cy, hdcSrc, x1, y1, rop) : FALSE;
}

BOOL WINAPI hook_StretchBlt(HDC hdcDst, int xDst, int yDst, int wDst, int hDst, HDC hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, DWORD rop)
{
    int32_t vw = 0, vh = 0, dx = 0, dy = 0, dw = 0, dh = 0;
    if (hdcSrc != hdcDst && wDst > 0 && hDst > 0 && g_ds.real_StretchBlt &&
        ds_should_scale_gdi_dc(hdcDst, __builtin_return_address(0), &vw, &vh, &dx, &dy, &dw, &dh)) {
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        if (ds_map_subrect_virt_to_phys(xDst, yDst, wDst, hDst, dx, dy, dw, dh, vw, vh, &px, &py, &pw, &ph)) {
            ds_clear_gdi_margins(hdcDst, dx, dy, dw, dh, (xDst <= 0 && yDst <= 0 && wDst >= vw && hDst >= vh));
            SetStretchBltMode(hdcDst, COLORONCOLOR);
            return g_ds.real_StretchBlt(hdcDst, px, py, pw, ph, hdcSrc, xSrc, ySrc, wSrc, hSrc, rop);
        }
    }
    return g_ds.real_StretchBlt ? g_ds.real_StretchBlt(hdcDst, xDst, yDst, wDst, hDst, hdcSrc, xSrc, ySrc, wSrc, hSrc, rop) : FALSE;
}

int WINAPI hook_SetDIBitsToDevice(HDC hdc, int xDest, int yDest, DWORD w, DWORD h, int xSrc, int ySrc, UINT StartScan, UINT cLines, const VOID *lpvBits, const BITMAPINFO *lpbmi, UINT ColorUse)
{
    int32_t vw = 0, vh = 0, dx = 0, dy = 0, dw = 0, dh = 0;
    if (w > 0 && h > 0 && StartScan == 0 && cLines >= h && g_ds.real_StretchDIBits &&
        ds_should_scale_gdi_dc(hdc, __builtin_return_address(0), &vw, &vh, &dx, &dy, &dw, &dh)) {
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        if (ds_map_subrect_virt_to_phys(xDest, yDest, (int32_t)w, (int32_t)h, dx, dy, dw, dh, vw, vh, &px, &py, &pw, &ph)) {
            ds_clear_gdi_margins(hdc, dx, dy, dw, dh, (xDest <= 0 && yDest <= 0 && (int32_t)w >= vw && (int32_t)h >= vh));
            SetStretchBltMode(hdc, COLORONCOLOR);
            return g_ds.real_StretchDIBits(hdc, px, py, pw, ph, xSrc, ySrc, (int)w, (int)h, lpvBits, lpbmi, ColorUse, SRCCOPY);
        }
    }
    return g_ds.real_SetDIBitsToDevice
        ? g_ds.real_SetDIBitsToDevice(hdc, xDest, yDest, w, h, xSrc, ySrc, StartScan, cLines, lpvBits, lpbmi, ColorUse)
        : 0;
}

int WINAPI hook_StretchDIBits(HDC hdc, int xDest, int yDest, int DestWidth, int DestHeight, int xSrc, int ySrc, int SrcWidth, int SrcHeight, const VOID *lpBits, const BITMAPINFO *lpbmi, UINT iUsage, DWORD rop)
{
    int32_t vw = 0, vh = 0, dx = 0, dy = 0, dw = 0, dh = 0;
    if (DestWidth > 0 && DestHeight > 0 && g_ds.real_StretchDIBits &&
        ds_should_scale_gdi_dc(hdc, __builtin_return_address(0), &vw, &vh, &dx, &dy, &dw, &dh)) {
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        if (ds_map_subrect_virt_to_phys(xDest, yDest, DestWidth, DestHeight, dx, dy, dw, dh, vw, vh, &px, &py, &pw, &ph)) {
            ds_clear_gdi_margins(hdc, dx, dy, dw, dh, (xDest <= 0 && yDest <= 0 && DestWidth >= vw && DestHeight >= vh));
            SetStretchBltMode(hdc, COLORONCOLOR);
            return g_ds.real_StretchDIBits(hdc, px, py, pw, ph, xSrc, ySrc, SrcWidth, SrcHeight, lpBits, lpbmi, iUsage, rop);
        }
    }
    return g_ds.real_StretchDIBits
        ? g_ds.real_StretchDIBits(hdc, xDest, yDest, DestWidth, DestHeight, xSrc, ySrc, SrcWidth, SrcHeight, lpBits, lpbmi, iUsage, rop)
        : 0;
}
