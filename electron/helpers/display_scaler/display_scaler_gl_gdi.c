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
typedef void      (APIENTRY *pfn_glGetBooleanv_t)(GLenum, GLboolean *);
typedef void      (APIENTRY *pfn_glGetFloatv_t)(GLenum, GLfloat *);
typedef void      (APIENTRY *pfn_glColorMask_t)(GLboolean, GLboolean, GLboolean, GLboolean);
typedef void      (APIENTRY *pfn_glClearColor_t)(GLclampf, GLclampf, GLclampf, GLclampf);
typedef void      (APIENTRY *pfn_glClear_t)(GLbitfield);
typedef void      (APIENTRY *pfn_glScissor_t)(GLint, GLint, GLsizei, GLsizei);
typedef void      (APIENTRY *pfn_glViewport_t)(GLint, GLint, GLsizei, GLsizei);
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

#ifndef GL_VIEWPORT
#define GL_VIEWPORT 0x0BA2
#endif
#ifndef GL_SCISSOR_BOX
#define GL_SCISSOR_BOX 0x0C10
#endif
#ifndef GL_COLOR_CLEAR_VALUE
#define GL_COLOR_CLEAR_VALUE 0x0C22
#endif

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
    GLint                         last_w3d_vp[4];
    GLint                         last_w3d_sc[4];

    /* Two-pass zero-shader FBO Sharp-Bilinear intermediate surface */
    HGLRC                         sharp_ctx;
    GLuint                        sharp_fbo;
    GLuint                        sharp_tex;
    int32_t                       sharp_w;
    int32_t                       sharp_h;

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
    pfn_glGetBooleanv_t           p_glGetBooleanv;
    pfn_glGetIntegerv_t           p_glGetIntegerv;
    pfn_glGetFloatv_t             p_glGetFloatv;
    pfn_glColorMask_t             p_glColorMask;
    pfn_glClearColor_t            p_glClearColor;
    pfn_glClear_t                 p_glClear;
    pfn_glScissor_t               p_glScissor;
    pfn_glViewport_t              p_glViewport;
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

#define DS_GLP_EXT     1u
#define DS_GLP_REQ_FBO 2u
#define DS_GLP_STATE   4u

typedef struct ds_gl_proc_def_s {
    const char *core;
    const char *ext;
    uint16_t    slot_off;
    uint8_t     flags;
} ds_gl_proc_def_t;

#define DS_GL_OFF(field) ((uint16_t)offsetof(ds_gl_state_t, field))

static const ds_gl_proc_def_t k_gl_proc_defs[] = {
    { "glGenTextures",             NULL,                        DS_GL_OFF(p_glGenTextures),             DS_GLP_REQ_FBO },
    { "glDeleteTextures",          NULL,                        DS_GL_OFF(p_glDeleteTextures),          DS_GLP_REQ_FBO },
    { "glBindTexture",             NULL,                        DS_GL_OFF(p_glBindTexture),             DS_GLP_REQ_FBO },
    { "glTexImage2D",              NULL,                        DS_GL_OFF(p_glTexImage2D),              DS_GLP_REQ_FBO },
    { "glTexParameteri",           NULL,                        DS_GL_OFF(p_glTexParameteri),           DS_GLP_REQ_FBO },
    { "glIsEnabled",               NULL,                        DS_GL_OFF(p_glIsEnabled),               DS_GLP_STATE },
    { "glEnable",                  NULL,                        DS_GL_OFF(p_glEnable),                  DS_GLP_STATE },
    { "glDisable",                 NULL,                        DS_GL_OFF(p_glDisable),                 DS_GLP_STATE },
    { "glGetBooleanv",             NULL,                        DS_GL_OFF(p_glGetBooleanv),             DS_GLP_STATE },
    { "glGetIntegerv",             NULL,                        DS_GL_OFF(p_glGetIntegerv),             DS_GLP_STATE },
    { "glGetFloatv",               NULL,                        DS_GL_OFF(p_glGetFloatv),               DS_GLP_STATE },
    { "glColorMask",               NULL,                        DS_GL_OFF(p_glColorMask),               DS_GLP_STATE },
    { "glViewport",                NULL,                        DS_GL_OFF(p_glViewport),                DS_GLP_STATE },
    { "wglGetCurrentDC",           NULL,                        DS_GL_OFF(p_wglGetCurrentDC),           DS_GLP_STATE },
    { "glGenFramebuffers",         "glGenFramebuffersEXT",      DS_GL_OFF(p_glGenFramebuffers),         DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glDeleteFramebuffers",      "glDeleteFramebuffersEXT",   DS_GL_OFF(p_glDeleteFramebuffers),      DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glBindFramebuffer",         "glBindFramebufferEXT",      DS_GL_OFF(p_glBindFramebuffer),         DS_GLP_EXT | DS_GLP_REQ_FBO | DS_GLP_STATE },
    { "glFramebufferTexture2D",    "glFramebufferTexture2DEXT", DS_GL_OFF(p_glFramebufferTexture2D),    DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glGenRenderbuffers",        "glGenRenderbuffersEXT",     DS_GL_OFF(p_glGenRenderbuffers),        DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glDeleteRenderbuffers",     "glDeleteRenderbuffersEXT",  DS_GL_OFF(p_glDeleteRenderbuffers),     DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glBindRenderbuffer",        "glBindRenderbufferEXT",     DS_GL_OFF(p_glBindRenderbuffer),        DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glRenderbufferStorage",     "glRenderbufferStorageEXT",  DS_GL_OFF(p_glRenderbufferStorage),     DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glFramebufferRenderbuffer", "glFramebufferRenderbufferEXT", DS_GL_OFF(p_glFramebufferRenderbuffer), DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glCheckFramebufferStatus",  "glCheckFramebufferStatusEXT",  DS_GL_OFF(p_glCheckFramebufferStatus),  DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glBlitFramebuffer",         "glBlitFramebufferEXT",      DS_GL_OFF(p_glBlitFramebuffer),         DS_GLP_EXT | DS_GLP_REQ_FBO },
    { "glBindBuffer",              "glBindBufferARB",           DS_GL_OFF(p_glBindBuffer),              DS_GLP_EXT },
    { "glClearColor",              NULL,                        DS_GL_OFF(p_glClearColor),              DS_GLP_EXT | DS_GLP_STATE },
    { "glClear",                   NULL,                        DS_GL_OFF(p_glClear),                   DS_GLP_EXT | DS_GLP_STATE },
    { "glScissor",                 NULL,                        DS_GL_OFF(p_glScissor),                 DS_GLP_EXT | DS_GLP_STATE },
};

DS_ALWAYS_INLINE void **ds_gl_slot_ptr(uint16_t off)
{
    return (void **)(void *)((uint8_t *)&g_gl + off);
}

static void ds_gl_resolve_table_procs(HMODULE h_gl, bool state_only)
{
    for (size_t i = 0; i < sizeof(k_gl_proc_defs) / sizeof(k_gl_proc_defs[0]); i++) {
        const ds_gl_proc_def_t *d = &k_gl_proc_defs[i];
        if (state_only && (d->flags & DS_GLP_STATE) == 0) continue;
        void **slot = ds_gl_slot_ptr(d->slot_off);
        if (*slot != NULL) continue;
        *slot = (d->flags & DS_GLP_EXT)
            ? ds_gl_proc_or_ext(h_gl, d->core, d->ext)
            : (void *)(uintptr_t)g_ds.real_GetProcAddress(h_gl, d->core);
    }
    if (!g_ds.real_glGetIntegerv && g_gl.p_glGetIntegerv) {
        g_ds.real_glGetIntegerv = g_gl.p_glGetIntegerv;
    }
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
    ds_gl_resolve_table_procs(h_gl, false);
    if (!g_ds.real_glDrawBuffer) {
        g_ds.real_glDrawBuffer = (pfn_glDrawBuffer_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glDrawBuffer");
    }
    if (!g_ds.real_glReadBuffer) {
        g_ds.real_glReadBuffer = (pfn_glReadBuffer_t)(uintptr_t)g_ds.real_GetProcAddress(h_gl, "glReadBuffer");
    }

    bool ok = (g_gl.p_wglGetCurrentContext != NULL);
    for (size_t i = 0; i < sizeof(k_gl_proc_defs) / sizeof(k_gl_proc_defs[0]); i++) {
        if ((k_gl_proc_defs[i].flags & DS_GLP_REQ_FBO) && *ds_gl_slot_ptr(k_gl_proc_defs[i].slot_off) == NULL) {
            ok = false;
            break;
        }
    }
    g_gl.fbo_supported = ok;
    ds_tracef("gl_init: supp=%d gen=%p blit=%p bind=%p",
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
    if (g_gl.sharp_ctx == g_gl.fbo_ctx) {
        if (g_gl.sharp_tex) {
            g_gl.p_glDeleteTextures(1, &g_gl.sharp_tex);
            g_gl.sharp_tex = 0;
        }
        if (g_gl.sharp_fbo) {
            g_gl.p_glDeleteFramebuffers(1, &g_gl.sharp_fbo);
            g_gl.sharp_fbo = 0;
        }
        g_gl.sharp_w = 0;
        g_gl.sharp_h = 0;
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
        GLint prev_rb = 0;
        GLint prev_unpack_pbo = 0;
        if (g_gl.p_glGetIntegerv) {
            g_gl.p_glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev_tex);
            g_gl.p_glGetIntegerv(GL_RENDERBUFFER_BINDING, &prev_rb);
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
        g_gl.p_glBindRenderbuffer(GL_RENDERBUFFER, (GLuint)prev_rb);

        g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, g_gl.fbo_id);
        g_gl.p_glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_gl.color_tex, 0);
        g_gl.p_glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, g_gl.depth_rb);
        if (g_ds.real_glDrawBuffer) {
            g_ds.real_glDrawBuffer(GL_COLOR_ATTACHMENT0);
        }
        if (g_ds.real_glReadBuffer) {
            g_ds.real_glReadBuffer(GL_COLOR_ATTACHMENT0);
        }

        GLenum status = g_gl.p_glCheckFramebufferStatus(GL_FRAMEBUFFER);
        if (status != GL_FRAMEBUFFER_COMPLETE) {
            ds_tracef("gl_fbo: status=0x%x FAIL", (unsigned int)status);
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
    static int32_t s_last_vw = 0, s_last_vh = 0, s_last_dw = 0, s_last_dh = 0;
    static GLuint s_last_fbo = 0;
    if (s_last_vw != virt_w || s_last_vh != virt_h || s_last_dw != dst_w || s_last_dh != dst_h || s_last_fbo != g_gl.fbo_id) {
        s_last_vw = virt_w; s_last_vh = virt_h; s_last_dw = dst_w; s_last_dh = dst_h; s_last_fbo = g_gl.fbo_id;
        ds_tracef("gl_fbo: OK %dx%d->%dx%d w=%d id=%u r=%d",
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
        GLuint virt_fb = (framebuffer == g_gl.fbo_id) ? 0u : framebuffer;
        if (target == GL_FRAMEBUFFER) {
            g_gl.game_draw_fbo = virt_fb;
            g_gl.game_read_fbo = virt_fb;
            g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, virt_fb == 0 ? g_gl.fbo_id : virt_fb);
            return;
        }
        if (target == GL_DRAW_FRAMEBUFFER) {
            g_gl.game_draw_fbo = virt_fb;
            g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, virt_fb == 0 ? g_gl.fbo_id : virt_fb);
            return;
        }
        if (target == GL_READ_FRAMEBUFFER) {
            g_gl.game_read_fbo = virt_fb;
            g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, virt_fb == 0 ? g_gl.fbo_id : virt_fb);
            return;
        }
    }
    g_gl.p_glBindFramebuffer(target, framebuffer);
}

static void APIENTRY hook_glDeleteFramebuffers(GLsizei n, const GLuint *framebuffers)
{
    if (!g_gl.p_glDeleteFramebuffers) return;
    if (!ds_is_internal_call() && n > 0 && framebuffers &&
        g_gl.p_wglGetCurrentContext && g_gl.p_wglGetCurrentContext() == g_gl.game_hglrc) {
        bool has_protected = false;
        bool rebound = false;
        for (GLsizei i = 0; i < n; i++) {
            GLuint fb = framebuffers[i];
            if (fb != 0 && (fb == g_gl.fbo_id || fb == g_gl.sharp_fbo)) {
                has_protected = true;
                break;
            }
        }
        if (has_protected) {
            for (GLsizei i = 0; i < n; i++) {
                GLuint fb = framebuffers[i];
                if (fb == 0 || fb == g_gl.fbo_id || fb == g_gl.sharp_fbo) continue;
                if (fb == g_gl.game_draw_fbo) { g_gl.game_draw_fbo = 0; rebound = true; }
                if (fb == g_gl.game_read_fbo) { g_gl.game_read_fbo = 0; rebound = true; }
                g_gl.p_glDeleteFramebuffers(1, &fb);
            }
        } else {
            for (GLsizei i = 0; i < n; i++) {
                GLuint fb = framebuffers[i];
                if (fb == 0) continue;
                if (fb == g_gl.game_draw_fbo) { g_gl.game_draw_fbo = 0; rebound = true; }
                if (fb == g_gl.game_read_fbo) { g_gl.game_read_fbo = 0; rebound = true; }
            }
            g_gl.p_glDeleteFramebuffers(n, framebuffers);
        }
        if (rebound && g_gl.fbo_redirect_active && g_gl.fbo_id != 0 && g_gl.p_glBindFramebuffer) {
            g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_gl.game_draw_fbo ? g_gl.game_draw_fbo : g_gl.fbo_id);
            g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, g_gl.game_read_fbo ? g_gl.game_read_fbo : g_gl.fbo_id);
        }
        return;
    }
    g_gl.p_glDeleteFramebuffers(n, framebuffers);
}

void APIENTRY hook_glGetIntegerv(GLenum pname, GLint *data)
{
    pfn_glGetIntegerv_t fn = g_ds.real_glGetIntegerv ? g_ds.real_glGetIntegerv : g_gl.p_glGetIntegerv;
    if (!fn) return;
    fn(pname, data);
    if (!data || ds_is_internal_call()) return;
    if ((pname == GL_FRAMEBUFFER_BINDING || pname == GL_READ_FRAMEBUFFER_BINDING) &&
        g_gl.fbo_redirect_active && g_gl.fbo_id != 0 &&
        g_gl.p_wglGetCurrentContext && g_gl.p_wglGetCurrentContext() == g_gl.game_hglrc) {
        if ((GLuint)(*data) == g_gl.fbo_id) {
            *data = 0;
        }
    }
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

static void ds_gl_ensure_state_procs(void)
{
    if (g_gl.p_glGetIntegerv && g_gl.p_glGetBooleanv && g_gl.p_glGetFloatv &&
        g_gl.p_glIsEnabled && g_gl.p_glDisable && g_gl.p_glEnable &&
        g_gl.p_glColorMask && g_gl.p_glClearColor && g_gl.p_glClear &&
        g_gl.p_glScissor && g_gl.p_glViewport && g_gl.p_wglGetCurrentDC) {
        return;
    }
    if (!g_ds.real_GetProcAddress) {
        return;
    }
    HMODULE h_gl = GetModuleHandleW(L"opengl32.dll");
    if (!h_gl) {
        return;
    }
    ds_gl_resolve_table_procs(h_gl, true);
}

static bool ds_gl_compute_phys_viewport(
    int32_t          backing_w,
    int32_t          backing_h,
    int32_t          vw,
    int32_t          vh,
    ds_aspect_mode_t aspect,
    ds_viewport_t   *out_vp
)
{
    if (backing_w <= 0 || backing_h <= 0) {
        return false;
    }
    int32_t phys_inset_top = 0;
    if (g_ds.safe_inset_top > 0 && g_ds.real_screen_h > 0) {
        phys_inset_top = (int32_t)(((int64_t)g_ds.safe_inset_top * backing_h + g_ds.real_screen_h / 2) / g_ds.real_screen_h);
    }
    return ds_compute_viewport(backing_w, backing_h, phys_inset_top, vw, vh, aspect, out_vp);
}

static void ds_gl_clear_pillarbox_margins(
    int32_t dx0,
    int32_t dy0,
    int32_t dx1,
    int32_t dy1,
    int32_t backing_w,
    int32_t backing_h
)
{
    if (dx0 <= 0 && dx1 >= backing_w && dy0 <= 0 && dy1 >= backing_h) {
        return;
    }
    if (!g_gl.p_glClearColor || !g_gl.p_glClear || !g_gl.p_glScissor || !g_gl.p_glEnable || !g_gl.p_glDisable) {
        return;
    }

    GLboolean was_scissor = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_SCISSOR_TEST) : GL_FALSE;
    GLboolean was_srgb = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_FRAMEBUFFER_SRGB) : GL_FALSE;
    GLboolean prev_cmask[4] = { GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE };
    bool has_cmask = (g_gl.p_glGetBooleanv != NULL && g_gl.p_glColorMask != NULL);
    GLint prev_scissor[4] = { 0, 0, 0, 0 };
    GLfloat prev_clear[4] = { 0.0f, 0.0f, 0.0f, 0.0f };
    bool has_prev_scissor = (g_gl.p_glGetIntegerv != NULL);
    bool has_prev_clear = (g_gl.p_glGetFloatv != NULL);
    if (has_cmask) {
        g_gl.p_glGetBooleanv(GL_COLOR_WRITEMASK, prev_cmask);
        g_gl.p_glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    }
    if (was_srgb) {
        g_gl.p_glDisable(GL_FRAMEBUFFER_SRGB);
    }
    if (has_prev_scissor) {
        g_gl.p_glGetIntegerv(GL_SCISSOR_BOX, prev_scissor);
    }
    if (has_prev_clear) {
        g_gl.p_glGetFloatv(GL_COLOR_CLEAR_VALUE, prev_clear);
    }

    g_gl.p_glEnable(GL_SCISSOR_TEST);
    g_gl.p_glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    if (dx0 > 0) {
        g_gl.p_glScissor(0, 0, dx0, backing_h);
        g_gl.p_glClear(GL_COLOR_BUFFER_BIT);
    }
    if (dx1 < backing_w) {
        g_gl.p_glScissor(dx1, 0, backing_w - dx1, backing_h);
        g_gl.p_glClear(GL_COLOR_BUFFER_BIT);
    }
    if (dy0 > 0) {
        g_gl.p_glScissor(0, 0, backing_w, dy0);
        g_gl.p_glClear(GL_COLOR_BUFFER_BIT);
    }
    if (dy1 < backing_h) {
        g_gl.p_glScissor(0, dy1, backing_w, backing_h - dy1);
        g_gl.p_glClear(GL_COLOR_BUFFER_BIT);
    }

    if (has_prev_clear) {
        g_gl.p_glClearColor(prev_clear[0], prev_clear[1], prev_clear[2], prev_clear[3]);
    }
    if (has_cmask) {
        g_gl.p_glColorMask(prev_cmask[0], prev_cmask[1], prev_cmask[2], prev_cmask[3]);
    }
    if (was_srgb) {
        g_gl.p_glEnable(GL_FRAMEBUFFER_SRGB);
    }
    if (has_prev_scissor && prev_scissor[2] >= 0 && prev_scissor[3] >= 0) {
        g_gl.p_glScissor(prev_scissor[0], prev_scissor[1], prev_scissor[2], prev_scissor[3]);
    }
    if (!was_scissor) {
        g_gl.p_glDisable(GL_SCISSOR_TEST);
    }
}

static bool ds_gl_setup_color_fbo(GLuint *io_fbo, GLuint *io_tex, int32_t w, int32_t h)
{
    GLint prev_tex = 0;
    GLint prev_unpack = 0;
    if (g_gl.p_glGetIntegerv) {
        g_gl.p_glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev_tex);
        if (g_gl.p_glBindBuffer) {
            g_gl.p_glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &prev_unpack);
            if (prev_unpack != 0) {
                g_gl.p_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
            }
        }
    }
    if (*io_fbo == 0) {
        g_gl.p_glGenFramebuffers(1, io_fbo);
        g_gl.p_glGenTextures(1, io_tex);
    }
    g_gl.p_glBindTexture(GL_TEXTURE_2D, *io_tex);
    g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    g_gl.p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    g_gl.p_glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    g_gl.p_glBindTexture(GL_TEXTURE_2D, (GLuint)prev_tex);
    if (prev_unpack != 0 && g_gl.p_glBindBuffer) {
        g_gl.p_glBindBuffer(GL_PIXEL_UNPACK_BUFFER, (GLuint)prev_unpack);
    }
    g_gl.p_glBindFramebuffer(GL_FRAMEBUFFER, *io_fbo);
    g_gl.p_glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, *io_tex, 0);
    if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_COLOR_ATTACHMENT0);
    if (g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_COLOR_ATTACHMENT0);
    return (g_gl.p_glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
}

static bool ds_gl_ensure_sharp_fbo(HGLRC cur_ctx, int32_t inter_w, int32_t inter_h)
{
    if (!cur_ctx || inter_w <= 0 || inter_h <= 0 || !ds_gl_init_procs_once()) {
        return false;
    }
    if (g_gl.sharp_ctx != cur_ctx) {
        g_gl.sharp_ctx = cur_ctx;
        g_gl.sharp_fbo = 0;
        g_gl.sharp_tex = 0;
        g_gl.sharp_w = 0;
        g_gl.sharp_h = 0;
    }
    if (g_gl.sharp_fbo != 0 && g_gl.sharp_w == inter_w && g_gl.sharp_h == inter_h) {
        return true;
    }

    GLint prev_draw = 0;
    GLint prev_read = 0;
    if (g_gl.p_glGetIntegerv) {
        g_gl.p_glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prev_draw);
        g_gl.p_glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prev_read);
    }

    bool complete = ds_gl_setup_color_fbo(&g_gl.sharp_fbo, &g_gl.sharp_tex, inter_w, inter_h);
    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prev_draw);
    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prev_read);

    if (!complete) {
        if (g_gl.sharp_tex) {
            g_gl.p_glDeleteTextures(1, &g_gl.sharp_tex);
            g_gl.sharp_tex = 0;
        }
        if (g_gl.sharp_fbo) {
            g_gl.p_glDeleteFramebuffers(1, &g_gl.sharp_fbo);
            g_gl.sharp_fbo = 0;
        }
        g_gl.sharp_w = 0;
        g_gl.sharp_h = 0;
        return false;
    }
    g_gl.sharp_w = inter_w;
    g_gl.sharp_h = inter_h;
    return true;
}

static void ds_gl_present_blit_to_backbuffer(
    HGLRC             cur_ctx,
    GLuint            src_read_fbo,
    GLint             sx0,
    GLint             sy0,
    GLint             sx1,
    GLint             sy1,
    GLint             dx0,
    GLint             dy0,
    GLint             dx1,
    GLint             dy1,
    GLbitfield        mask,
    GLenum            fallback_filter,
    ds_aspect_mode_t  aspect,
    ds_scale_filter_t scale_filter
)
{
    GLboolean was_srgb = (g_gl.p_glIsEnabled && (mask & GL_COLOR_BUFFER_BIT))
        ? g_gl.p_glIsEnabled(GL_FRAMEBUFFER_SRGB)
        : GL_FALSE;
    if (was_srgb && g_gl.p_glDisable) {
        g_gl.p_glDisable(GL_FRAMEBUFFER_SRGB);
    }

    if (mask == GL_COLOR_BUFFER_BIT) {
        GLenum filter = (aspect == DS_ASPECT_INTEGER) ? GL_NEAREST : GL_LINEAR;
        int32_t src_w = (sx1 >= sx0) ? (sx1 - sx0) : (sx0 - sx1);
        int32_t src_h = (sy1 >= sy0) ? (sy1 - sy0) : (sy0 - sy1);
        int32_t dst_w = (dx1 >= dx0) ? (dx1 - dx0) : (dx0 - dx1);
        int32_t dst_h = (dy1 >= dy0) ? (dy1 - dy0) : (dy0 - dy1);

        if (aspect == DS_ASPECT_INTEGER || scale_filter == DS_FILTER_NEAREST) {
            filter = GL_NEAREST;
        } else if (scale_filter != DS_FILTER_LINEAR && src_w > 0 && src_h > 0 && dst_w > 0 && dst_h > 0) {
            bool want_sharp = (scale_filter == DS_FILTER_SHARP)
                ? (dst_w > src_w || dst_h > src_h)
                : (((int64_t)dst_w * 2LL >= (int64_t)src_w * 3LL) ||
                   ((int64_t)dst_h * 2LL >= (int64_t)src_h * 3LL));
            if (want_sharp) {
                int32_t fbo_cap = g_ds.gl_max_texture_size;
                if (fbo_cap <= 0) {
                    GLint max_tex = 0;
                    if (g_gl.p_glGetIntegerv) {
                        g_gl.p_glGetIntegerv(GL_MAX_TEXTURE_SIZE, &max_tex);
                    }
                    fbo_cap = (int32_t)max_tex;
                    if (fbo_cap <= 0) fbo_cap = 4096;
                    if (fbo_cap > 16384) fbo_cap = 16384;
                    g_ds.gl_max_texture_size = fbo_cap;
                }
                int32_t max_kx = fbo_cap / src_w;
                if (max_kx < 1) max_kx = 1;
                int32_t ceil_kx = (dst_w + src_w - 1) / src_w;
                if (ceil_kx < 1) ceil_kx = 1;
                int32_t kx = (ceil_kx < max_kx) ? ceil_kx : max_kx;

                int32_t max_ky = fbo_cap / src_h;
                if (max_ky < 1) max_ky = 1;
                int32_t ceil_ky = (dst_h + src_h - 1) / src_h;
                if (ceil_ky < 1) ceil_ky = 1;
                int32_t ky = (ceil_ky < max_ky) ? ceil_ky : max_ky;

                int32_t inter_w = src_w * kx;
                int32_t inter_h = src_h * ky;
                if (inter_w == dst_w && inter_h == dst_h) {
                    filter = GL_NEAREST;
                } else if ((kx > 1 || ky > 1) && ds_gl_ensure_sharp_fbo(cur_ctx, inter_w, inter_h)) {
                    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, src_read_fbo);
                    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_gl.sharp_fbo);
                    g_gl.p_glBlitFramebuffer(sx0, sy0, sx1, sy1, 0, 0, inter_w, inter_h, GL_COLOR_BUFFER_BIT, GL_NEAREST);

                    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, g_gl.sharp_fbo);
                    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
                    if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);
                    g_gl.p_glBlitFramebuffer(0, 0, inter_w, inter_h, dx0, dy0, dx1, dy1, GL_COLOR_BUFFER_BIT, GL_LINEAR);

                    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, src_read_fbo);
                    if (was_srgb && g_gl.p_glEnable) {
                        g_gl.p_glEnable(GL_FRAMEBUFFER_SRGB);
                    }
                    return;
                }
            }
        }
        fallback_filter = filter;
    }

    g_gl.p_glBlitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, fallback_filter);
    if (was_srgb && g_gl.p_glEnable) {
        g_gl.p_glEnable(GL_FRAMEBUFFER_SRGB);
    }
}

static void ds_gl_pick_w3d_rect(const GLint saved[4], int32_t vw, int32_t vh, GLint out[4])
{
    if (saved[2] > 0 && saved[3] > 0) {
        memcpy(out, saved, sizeof(GLint) * 4u);
    } else {
        out[0] = 0; out[1] = 0; out[2] = vw; out[3] = vh;
    }
}

static bool ds_is_target_gl_win_locked(HWND win, bool allow_null);
static void ds_gl_rebind_drawable_if_pending(HDC target_hdc);

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
    ds_gl_ensure_state_procs();

    if (!ds_is_internal_call() && g_gl.p_glGetIntegerv && ds_is_wined3d_caller(__builtin_return_address(0))) {
        GLint draw_fbo = -1;
        GLint read_fbo = 0;
        g_gl.p_glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_fbo);
        g_gl.p_glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read_fbo);
        if (draw_fbo == 0) {
            HDC cur_hdc = g_gl.p_wglGetCurrentDC ? g_gl.p_wglGetCurrentDC() : NULL;
            HWND cur_win = cur_hdc ? WindowFromDC(cur_hdc) : NULL;

            EnterCriticalSection(&g_ds.lock);
            g_ds.wined3d_uses_gl = true;
            g_ds.wined3d_uses_vulkan = false;
            ds_notify_gl_context_active_locked();
            bool is_target_win = ds_is_target_gl_win_locked(cur_win, true);
            int32_t win_scale = ds_get_windowed_scale_locked();
            int32_t vw = g_ds.virt_w;
            int32_t vh = g_ds.virt_h;
            int32_t dw = g_ds.fullscreen_active ? g_ds.vp.dst_w : (vw * win_scale);
            int32_t dh = g_ds.fullscreen_active ? g_ds.vp.dst_h : (vh * win_scale);
            int32_t dst_x = g_ds.fullscreen_active ? g_ds.vp.dst_x : 0;
            int32_t dst_y = g_ds.fullscreen_active ? g_ds.vp.dst_y : 0;
            bool should_scale = (
                !ds_is_modern_tier_locked() &&
                is_target_win &&
                (g_ds.fullscreen_active || win_scale > 1) &&
                vw > 0 &&
                vh > 0 &&
                dw > 0 &&
                dh > 0 &&
                (vw != dw || vh != dh)
            );
            ds_aspect_mode_t aspect = g_ds.fullscreen_active ? g_ds.aspect_mode : DS_ASPECT_PRESERVE;
            ds_scale_filter_t sfilter = g_ds.scale_filter;
            LeaveCriticalSection(&g_ds.lock);

            if (should_scale) {
                int32_t backing_w = g_ds.fullscreen_active ? g_ds.phys_screen_w : dw;
                int32_t backing_h = g_ds.fullscreen_active ? g_ds.phys_screen_h : dh;
                if (g_ds.fullscreen_active && backing_w > 0 && backing_h > 0) {
                    ds_viewport_t phys_vp;
                    if (ds_gl_compute_phys_viewport(backing_w, backing_h, vw, vh, aspect, &phys_vp)) {
                        dst_x = phys_vp.dst_x;
                        dst_y = phys_vp.dst_y;
                        dw = phys_vp.dst_w;
                        dh = phys_vp.dst_h;
                    }
                }
                int32_t gl_dst_y = backing_h - (dst_y + dh);
                GLint nx0 = (GLint)(((int64_t)dstX0 * dw + (dstX0 >= 0 ? vw / 2 : -vw / 2)) / vw);
                GLint nx1 = (GLint)(((int64_t)dstX1 * dw + (dstX1 >= 0 ? vw / 2 : -vw / 2)) / vw);
                GLint ny0 = (GLint)(((int64_t)dstY0 * dh + (dstY0 >= 0 ? vh / 2 : -vh / 2)) / vh);
                GLint ny1 = (GLint)(((int64_t)dstY1 * dh + (dstY1 >= 0 ? vh / 2 : -vh / 2)) / vh);
                nx0 += dst_x;
                nx1 += dst_x;
                ny0 += gl_dst_y;
                ny1 += gl_dst_y;
                if (mask == GL_COLOR_BUFFER_BIT) {
                    if (g_gl.p_glGetIntegerv && g_gl.p_glViewport && backing_w > 0 && backing_h > 0 &&
                        (vw != backing_w || vh != backing_h)) {
                        GLint cur_vp[4] = { 0, 0, 0, 0 };
                        GLint cur_sc[4] = { 0, 0, 0, 0 };
                        g_gl.p_glGetIntegerv(GL_VIEWPORT, cur_vp);
                        g_gl.p_glGetIntegerv(GL_SCISSOR_BOX, cur_sc);
                        if (cur_vp[0] == 0 && cur_vp[1] == 0 && cur_vp[2] == backing_w && cur_vp[3] == backing_h) {
                            GLint rv[4];
                            ds_gl_pick_w3d_rect(g_gl.last_w3d_vp, vw, vh, rv);
                            g_gl.p_glViewport(rv[0], rv[1], rv[2], rv[3]);
                            if (g_gl.p_glScissor && cur_sc[0] == 0 && cur_sc[1] == 0 &&
                                cur_sc[2] == backing_w && cur_sc[3] == backing_h) {
                                ds_gl_pick_w3d_rect(g_gl.last_w3d_sc, vw, vh, rv);
                                g_gl.p_glScissor(rv[0], rv[1], rv[2], rv[3]);
                            }
                        } else if (cur_vp[2] > 0 && cur_vp[3] > 0) {
                            memcpy(g_gl.last_w3d_vp, cur_vp, sizeof(cur_vp));
                            if (cur_sc[2] > 0 && cur_sc[3] > 0) {
                                memcpy(g_gl.last_w3d_sc, cur_sc, sizeof(cur_sc));
                            }
                        }
                    }
                    if (read_fbo != 0 && cur_hdc != NULL) {
                        ds_gl_rebind_drawable_if_pending(cur_hdc);
                    }
                    ds_gl_clear_pillarbox_margins(dst_x, gl_dst_y, dst_x + dw, gl_dst_y + dh, backing_w, backing_h);
                }
                GLboolean was_scissor = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_SCISSOR_TEST) : GL_FALSE;
                if (was_scissor && g_gl.p_glDisable) {
                    g_gl.p_glDisable(GL_SCISSOR_TEST);
                }
                HGLRC cur_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
                ds_enter_internal();
                ds_gl_present_blit_to_backbuffer(
                    cur_ctx,
                    (GLuint)read_fbo,
                    srcX0,
                    srcY0,
                    srcX1,
                    srcY1,
                    nx0,
                    ny0,
                    nx1,
                    ny1,
                    mask,
                    filter,
                    aspect,
                    sfilter
                );
                ds_leave_internal();
                if (was_scissor && g_gl.p_glEnable) {
                    g_gl.p_glEnable(GL_SCISSOR_TEST);
                }
                g_gl.w3d_scaled_in_blit = true;
                g_gl.last_present_was_gl = true;
                InterlockedIncrement(&g_ds.gdi_margin_gen);
                return;
            }
        }
    }

    g_gl.p_glBlitFramebuffer(srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter);
}

static void ds_gl_push_blit_caps(GLboolean *out_scissor, GLboolean *out_srgb)
{
    *out_scissor = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_SCISSOR_TEST) : GL_FALSE;
    *out_srgb = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_FRAMEBUFFER_SRGB) : GL_FALSE;
    if (*out_scissor && g_gl.p_glDisable) g_gl.p_glDisable(GL_SCISSOR_TEST);
    if (*out_srgb && g_gl.p_glDisable) g_gl.p_glDisable(GL_FRAMEBUFFER_SRGB);
}

static void ds_gl_pop_blit_caps(GLboolean was_scissor, GLboolean was_srgb)
{
    if (was_srgb && g_gl.p_glEnable) g_gl.p_glEnable(GL_FRAMEBUFFER_SRGB);
    if (was_scissor && g_gl.p_glEnable) g_gl.p_glEnable(GL_SCISSOR_TEST);
}

static void ds_gl_upscale_wined3d_backbuffer(
    HDC               target_hdc,
    HGLRC             cur_ctx,
    int32_t           vw,
    int32_t           vh,
    int32_t           dst_x,
    int32_t           gl_dst_y,
    int32_t           dw,
    int32_t           dh,
    ds_aspect_mode_t  aspect,
    ds_scale_filter_t scale_filter
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
        if (!ds_gl_setup_color_fbo(&g_gl.w3d_fbo_id, &g_gl.w3d_color_tex, vw, vh)) {
            g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prev_draw_fbo);
            g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prev_read_fbo);
            ds_leave_internal();
            return;
        }
        g_gl.w3d_w = vw;
        g_gl.w3d_h = vh;
    }

    GLboolean was_scissor = GL_FALSE, was_srgb = GL_FALSE;
    ds_gl_push_blit_caps(&was_scissor, &was_srgb);

    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_gl.w3d_fbo_id);
    if (g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_BACK);
    g_gl.p_glBlitFramebuffer(0, 0, vw, vh, 0, 0, vw, vh, GL_COLOR_BUFFER_BIT, GL_NEAREST);

    /* Rebind Cocoa drawable now that Frame 1 is safely preserved in `w3d_fbo_id` */
    ds_gl_rebind_drawable_if_pending(target_hdc);

    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, g_gl.w3d_fbo_id);
    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    if (g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);

    int32_t backing_w = g_ds.fullscreen_active ? g_ds.phys_screen_w : dw;
    int32_t backing_h = g_ds.fullscreen_active ? g_ds.phys_screen_h : dh;

    int32_t dst_w = dw;
    int32_t dst_h = dh;
    if (g_ds.fullscreen_active && backing_w > 0 && backing_h > 0) {
        ds_viewport_t phys_vp;
        if (ds_gl_compute_phys_viewport(backing_w, backing_h, vw, vh, aspect, &phys_vp)) {
            dst_x = phys_vp.dst_x;
            dst_w = phys_vp.dst_w;
            dst_h = phys_vp.dst_h;
            gl_dst_y = backing_h - (phys_vp.dst_y + phys_vp.dst_h);
        }
    }

    ds_gl_clear_pillarbox_margins(dst_x, gl_dst_y, dst_x + dst_w, gl_dst_y + dst_h, backing_w, backing_h);

    ds_gl_present_blit_to_backbuffer(
        cur_ctx,
        g_gl.w3d_fbo_id,
        0,
        0,
        vw,
        vh,
        dst_x,
        gl_dst_y,
        dst_x + dst_w,
        gl_dst_y + dst_h,
        GL_COLOR_BUFFER_BIT,
        (aspect == DS_ASPECT_INTEGER) ? GL_NEAREST : GL_LINEAR,
        aspect,
        scale_filter
    );

    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prev_draw_fbo);
    g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prev_read_fbo);
    if (prev_draw_fbo == 0 && g_ds.real_glDrawBuffer) g_ds.real_glDrawBuffer(GL_BACK);
    if (prev_read_fbo == 0 && g_ds.real_glReadBuffer) g_ds.real_glReadBuffer(GL_BACK);

    ds_gl_pop_blit_caps(was_scissor, was_srgb);
    ds_leave_internal();
}

/* -------------------------------------------------------------------------
 * Bijective `game_hdc <-> host_hdc` Redirection onto `OneLauncherGLHostChild`
 *
 * On macOS CrossOver (`winemac.drv`), once an OpenGL drawable/context attaches
 * directly to `g_ds.hwnd_game`, `-[WineOpenGLContext clearDrawableLeavingSurfaceOnScreen]`
 * intentionally leaves the opaque `CGLSurface` / `CAOpenGLLayer` pinned above
 * `hwnd_game`'s GDI `CALayer` even after `wglMakeCurrent(NULL, NULL)` and
 * `wglDeleteContext`, occluding subsequent 2D GDI screens (such as classic hybrid
 * 2D/3D engines returning to an in-game `ESC` menu).
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

    ds_lock();
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].host_hdc != NULL &&
            (host_hwnd == NULL || g_gl.dc_map[i].host_hwnd == host_hwnd)) {
            to_free[count++] = g_gl.dc_map[i];
            memset(&g_gl.dc_map[i], 0, sizeof(g_gl.dc_map[i]));
        }
    }
    ds_unlock();

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
    ds_lock();
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].game_hdc == hdc) {
            victim = g_gl.dc_map[i];
            memset(&g_gl.dc_map[i], 0, sizeof(g_gl.dc_map[i]));
            break;
        }
    }
    ds_unlock();

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

    ds_lock();
    if (ds_is_modern_tier_locked()) {
        ds_unlock();
        return hdc;
    }
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].host_hdc == hdc) {
            ds_unlock();
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
    ds_unlock();

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

    ds_lock();
    HWND game_hwnd = g_ds.hwnd_game;
    HWND host_hwnd = g_ds.hwnd_gl_host;
    DWORD owner_tid = g_ds.game_thread_id;
    ds_unlock();

    if (host_hwnd != NULL && win == host_hwnd) {
        return hdc;
    }
    if (!game_hwnd || win != game_hwnd) {
        return hdc;
    }

    if ((!host_hwnd || !IsWindow(host_hwnd)) && GetCurrentThreadId() == owner_tid) {
        ds_ensure_gl_host_child_on_owner_thread(game_hwnd);
        ds_lock();
        host_hwnd = g_ds.hwnd_gl_host;
        ds_unlock();
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
    ds_lock();
    int free_slot = -1;
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].game_hdc == hdc && g_gl.dc_map[i].host_hwnd == host_hwnd && g_gl.dc_map[i].host_hdc != NULL) {
            HDC winner = g_gl.dc_map[i].host_hdc;
            ds_unlock();
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
    ds_unlock();

    if (evicted.host_hdc && evicted.host_hwnd && IsWindow(evicted.host_hwnd)) {
        ds_enter_internal();
        if (g_ds.real_ReleaseDC) g_ds.real_ReleaseDC(evicted.host_hwnd, evicted.host_hdc);
        else ReleaseDC(evicted.host_hwnd, evicted.host_hdc);
        ds_leave_internal();
    }

    if (g_ds.trace_file[0] != L'\0') {
        static volatile LONG s_map_logs = 0;
        if (InterlockedIncrement(&s_map_logs) <= 64) {
            ds_tracef("ds_gl_map_hdc: %p(%p)->%p(%p)",
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
    ds_lock();
    for (int i = 0; i < DS_MAX_GL_DC_MAP; i++) {
        if (g_gl.dc_map[i].host_hdc == hdc && g_gl.dc_map[i].game_hdc != NULL) {
            mapped = g_gl.dc_map[i].game_hdc;
            break;
        }
    }
    ds_unlock();
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
        ds_lock();
        g_gl.last_host_pf = format;
        if (ppfd) {
            g_gl.last_host_pfd = *ppfd;
            g_gl.has_last_host_pfd = true;
        }
        ds_unlock();
    }
    return ok;
}

static void ds_gl_mark_context_creator_caller(const void *caller_ret)
{
    if (!caller_ret || ds_is_internal_call()) return;
    bool is_wined3d = ds_is_wined3d_caller(caller_ret);
    bool is_sys = ds_is_system_renderer_caller(caller_ret);
    if (is_wined3d || !is_sys) {
        ds_lock();
        if (is_wined3d) {
            g_ds.wined3d_uses_gl = true;
            g_ds.wined3d_uses_vulkan = false;
        } else {
            g_ds.game_gl_active = true;
        }
        ds_notify_gl_context_active_locked();
        ds_unlock();
    }
}

HGLRC WINAPI hook_wglCreateContext(HDC hdc)
{
    ds_gl_mark_context_creator_caller(__builtin_return_address(0));
    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);
    return g_ds.real_wglCreateContext ? g_ds.real_wglCreateContext(target_hdc) : NULL;
}

HGLRC WINAPI hook_wglCreateLayerContext(HDC hdc, int iLayerPlane)
{
    ds_gl_mark_context_creator_caller(__builtin_return_address(0));
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
        ds_lock();
        g_gl.last_host_pf = format;
        if (ppfd) {
            g_gl.last_host_pfd = *ppfd;
            g_gl.has_last_host_pfd = true;
        }
        ds_unlock();
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
        ds_lock();
        g_gl.last_host_pf = format;
        ds_unlock();
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
    ds_gl_mark_context_creator_caller(__builtin_return_address(0));
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

#define DS_GLH_GAME_ONLY 1u
#define DS_GLH_IN_GDS    2u

typedef struct ds_gl_hook_def_s {
    const char *name;
    const char *alt;
    void       *hook;
    uint16_t    slot_off;
    uint8_t     flags;
} ds_gl_hook_def_t;

#define DS_GDS_OFF(field) ((uint16_t)offsetof(ds_runtime_t, field))

static const ds_gl_hook_def_t k_gl_hook_defs[] = {
    { "glBlitFramebuffer",          "glBlitFramebufferEXT",          (void *)(uintptr_t)hook_glBlitFramebuffer,          DS_GL_OFF(p_glBlitFramebuffer),          0 },
    { "wglSetPixelFormatWINE",      NULL,                            (void *)(uintptr_t)hook_wglSetPixelFormatWINE,      DS_GL_OFF(p_wglSetPixelFormatWINE),      0 },
    { "wglChoosePixelFormatARB",    "wglChoosePixelFormatEXT",       (void *)(uintptr_t)hook_wglChoosePixelFormatARB,    DS_GL_OFF(p_wglChoosePixelFormatARB),    0 },
    { "wglGetPixelFormatAttribivARB", "wglGetPixelFormatAttribivEXT", (void *)(uintptr_t)hook_wglGetPixelFormatAttribivARB, DS_GL_OFF(p_wglGetPixelFormatAttribivARB), 0 },
    { "wglGetPixelFormatAttribfvARB", "wglGetPixelFormatAttribfvEXT", (void *)(uintptr_t)hook_wglGetPixelFormatAttribfvARB, DS_GL_OFF(p_wglGetPixelFormatAttribfvARB), 0 },
    { "wglCreateContextAttribsARB", NULL,                            (void *)(uintptr_t)hook_wglCreateContextAttribsARB, DS_GL_OFF(p_wglCreateContextAttribsARB), 0 },
    { "wglGetExtensionsStringARB",  NULL,                            (void *)(uintptr_t)hook_wglGetExtensionsStringARB,  DS_GL_OFF(p_wglGetExtensionsStringARB),  0 },
    { "wglMakeContextCurrentARB",   "wglMakeContextCurrentEXT",      (void *)(uintptr_t)hook_wglMakeContextCurrentARB,   DS_GL_OFF(p_wglMakeContextCurrentARB),   0 },
    { "wglGetCurrentReadDCARB",     "wglGetCurrentReadDCEXT",        (void *)(uintptr_t)hook_wglGetCurrentReadDCARB,     DS_GL_OFF(p_wglGetCurrentReadDCARB),     0 },
    { "wglQueryRendererIntegerWINE", NULL,                           (void *)(uintptr_t)hook_wglQueryRendererIntegerWINE, DS_GL_OFF(p_wglQueryRendererIntegerWINE), 0 },
    { "wglQueryRendererStringWINE", NULL,                            (void *)(uintptr_t)hook_wglQueryRendererStringWINE, DS_GL_OFF(p_wglQueryRendererStringWINE), 0 },
    { "wglGetPixelFormat",          NULL,                            (void *)(uintptr_t)hook_wglGetPixelFormat,          DS_GDS_OFF(real_wglGetPixelFormat),      DS_GLH_IN_GDS },
    { "wglSetPixelFormat",          NULL,                            (void *)(uintptr_t)hook_wglSetPixelFormat,          DS_GDS_OFF(real_wglSetPixelFormat),      DS_GLH_IN_GDS },
    { "wglChoosePixelFormat",       NULL,                            (void *)(uintptr_t)hook_wglChoosePixelFormat,       DS_GDS_OFF(real_wglChoosePixelFormat),   DS_GLH_IN_GDS },
    { "wglDescribePixelFormat",     NULL,                            (void *)(uintptr_t)hook_wglDescribePixelFormat,     DS_GDS_OFF(real_wglDescribePixelFormat), DS_GLH_IN_GDS },
    { "glBindFramebuffer",          "glBindFramebufferEXT",          (void *)(uintptr_t)hook_glBindFramebuffer,          DS_GL_OFF(p_glBindFramebuffer),          DS_GLH_GAME_ONLY },
    { "glDeleteFramebuffers",       "glDeleteFramebuffersEXT",       (void *)(uintptr_t)hook_glDeleteFramebuffers,       DS_GL_OFF(p_glDeleteFramebuffers),       DS_GLH_GAME_ONLY },
    { "glGetIntegerv",              NULL,                            (void *)(uintptr_t)hook_glGetIntegerv,              DS_GDS_OFF(real_glGetIntegerv),          DS_GLH_GAME_ONLY | DS_GLH_IN_GDS },
    { "glDrawBuffer",               NULL,                            (void *)(uintptr_t)hook_glDrawBuffer,               DS_GDS_OFF(real_glDrawBuffer),           DS_GLH_GAME_ONLY | DS_GLH_IN_GDS },
    { "glReadBuffer",               NULL,                            (void *)(uintptr_t)hook_glReadBuffer,               DS_GDS_OFF(real_glReadBuffer),           DS_GLH_GAME_ONLY | DS_GLH_IN_GDS },
};

static void *ds_resolve_gl_proc_common(const char *name, void *real_fn, bool include_game_only)
{
    if (!name || !real_fn) return real_fn;
    for (size_t i = 0; i < sizeof(k_gl_hook_defs) / sizeof(k_gl_hook_defs[0]); i++) {
        const ds_gl_hook_def_t *d = &k_gl_hook_defs[i];
        if ((d->flags & DS_GLH_GAME_ONLY) && !include_game_only) continue;
        if (strcmp(name, d->name) == 0 || (d->alt && strcmp(name, d->alt) == 0)) {
            void **slot = (d->flags & DS_GLH_IN_GDS)
                ? (void **)(void *)((uint8_t *)&g_ds + d->slot_off)
                : ds_gl_slot_ptr(d->slot_off);
            if (!*slot) *slot = real_fn;
            return d->hook;
        }
    }
    return real_fn;
}

void *ds_resolve_wined3d_gl_proc(const char *name, void *real_fn)
{
    return ds_resolve_gl_proc_common(name, real_fn, false);
}

void *ds_resolve_gl_hook_proc(const char *name, void *real_fn)
{
    return ds_resolve_gl_proc_common(name, real_fn, true);
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

static void ds_gl_reset_fbo_state(HGLRC next_ctx)
{
    g_gl.fbo_ctx = next_ctx;
    g_gl.fbo_id = 0;
    g_gl.color_tex = 0;
    g_gl.depth_rb = 0;
    g_gl.fbo_w = 0;
    g_gl.fbo_h = 0;
    g_gl.fbo_redirect_active = false;
    g_gl.game_draw_fbo = 0;
    g_gl.game_read_fbo = 0;
}

BOOL WINAPI hook_wglMakeCurrent(HDC hdc, HGLRC hglrc)
{
    if (!g_ds.real_wglMakeCurrent) return FALSE;
    if (ds_is_internal_call()) {
        return g_ds.real_wglMakeCurrent(hdc, hglrc);
    }
    ds_ensure_runtime_started();

    const void *caller_ret = __builtin_return_address(0);
    bool is_wined3d = ds_is_wined3d_caller(caller_ret);
    bool is_sys = ds_is_system_renderer_caller(caller_ret);
    HWND win = hdc ? WindowFromDC(hdc) : NULL;

    if (win && hglrc != NULL && (!is_sys || is_wined3d)) {
        ds_lock();
        if (is_wined3d) {
            g_ds.wined3d_uses_gl = true;
            g_ds.wined3d_uses_vulkan = false;
        } else {
            g_ds.game_gl_active = true;
        }
        ds_notify_gl_context_active_locked();
        ds_unlock();
    }

    if (win && win != g_ds.hwnd_gl_host && g_ds.hwnd_game == NULL && ds_is_candidate_game_window(win, NULL, NULL)) {
        ds_attach_and_apply_game_window(win, 0, 0);
    }

    HDC target_hdc = hdc ? ds_gl_map_hdc_for_wgl(hdc) : NULL;
    if (target_hdc && target_hdc != hdc && hglrc != NULL) {
        ds_enter_internal();
        int cur_pf = g_ds.real_GetPixelFormat ? g_ds.real_GetPixelFormat(target_hdc) : GetPixelFormat(target_hdc);
        if (cur_pf == 0) {
            ds_lock();
            int saved_pf = g_gl.last_host_pf;
            bool has_pfd = g_gl.has_last_host_pfd;
            PIXELFORMATDESCRIPTOR saved_pfd = g_gl.last_host_pfd;
            ds_unlock();
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
            ds_tracef("wglMakeCurrent: %p->%p win=%p ctx=%p ok=%d is_wined3d=%d",
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

    if (is_wined3d || is_sys) {
        return ok;
    }

    if (win && win != g_ds.hwnd_gl_host && (g_ds.hwnd_game == NULL || g_ds.hwnd_game != win) && ds_is_candidate_game_window(win, NULL, NULL)) {
        ds_attach_and_apply_game_window(win, 0, 0);
    }

    ds_lock();
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
    bool want_fbo = (fs_active || (win_scale > 1)) && !ds_is_modern_tier_locked();
    ds_unlock();

    if (is_game_win) {
        if (g_gl.fbo_ctx != hglrc) {
            ds_gl_reset_fbo_state(hglrc);
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
        ds_gl_reset_fbo_state(NULL);
    }
    if (hglrc && hglrc == g_gl.w3d_hglrc) {
        g_gl.w3d_hglrc = NULL;
        g_gl.w3d_fbo_id = 0;
        g_gl.w3d_color_tex = 0;
        g_gl.w3d_w = 0;
        g_gl.w3d_h = 0;
    }
    if (hglrc && hglrc == g_gl.sharp_ctx) {
        g_gl.sharp_ctx = NULL;
        g_gl.sharp_fbo = 0;
        g_gl.sharp_tex = 0;
        g_gl.sharp_w = 0;
        g_gl.sharp_h = 0;
    }
    memset(g_gl.last_w3d_vp, 0, sizeof(g_gl.last_w3d_vp));
    memset(g_gl.last_w3d_sc, 0, sizeof(g_gl.last_w3d_sc));
    return g_ds.real_wglDeleteContext ? g_ds.real_wglDeleteContext(hglrc) : FALSE;
}

static void ds_gl_rebind_drawable_if_pending(HDC target_hdc)
{
    if (!target_hdc || InterlockedCompareExchange(&g_ds.gl_drawable_rebind_pending, 0, 1) != 1) {
        return;
    }
    ds_gl_ensure_wgl_query_procs();
    ds_gl_ensure_state_procs();
    HGLRC rebind_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
    HDC cur_dc = g_gl.p_wglGetCurrentDC ? g_gl.p_wglGetCurrentDC() : NULL;
    HDC read_dc = g_gl.p_wglGetCurrentReadDCARB ? g_gl.p_wglGetCurrentReadDCARB() : cur_dc;
    if (rebind_ctx != NULL && g_ds.real_wglMakeCurrent && (read_dc == NULL || read_dc == cur_dc)) {
        ds_lock();
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        int32_t bw = g_ds.fullscreen_active ? g_ds.phys_screen_w : 0;
        int32_t bh = g_ds.fullscreen_active ? g_ds.phys_screen_h : 0;
        bool is_w3d = g_ds.wined3d_uses_gl;
        ds_unlock();

        ds_enter_internal();
        GLint saved_vp[4] = { 0, 0, 0, 0 };
        GLint saved_sc[4] = { 0, 0, 0, 0 };
        GLint saved_draw_fbo = 0;
        GLint saved_read_fbo = 0;
        bool has_int_state = (g_gl.p_glGetIntegerv != NULL);
        GLboolean was_scissor = g_gl.p_glIsEnabled ? g_gl.p_glIsEnabled(GL_SCISSOR_TEST) : GL_FALSE;
        if (has_int_state) {
            g_gl.p_glGetIntegerv(GL_VIEWPORT, saved_vp);
            g_gl.p_glGetIntegerv(GL_SCISSOR_BOX, saved_sc);
            g_gl.p_glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &saved_draw_fbo);
            g_gl.p_glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &saved_read_fbo);
            if (is_w3d && bw > 0 && bh > 0 && (vw != bw || vh != bh) &&
                saved_vp[0] == 0 && saved_vp[1] == 0 && saved_vp[2] == bw && saved_vp[3] == bh) {
                if (vw > 0 && vh > 0) {
                    ds_gl_pick_w3d_rect(g_gl.last_w3d_vp, vw, vh, saved_vp);
                    if (saved_sc[0] == 0 && saved_sc[1] == 0 && saved_sc[2] == bw && saved_sc[3] == bh) {
                        ds_gl_pick_w3d_rect(g_gl.last_w3d_sc, vw, vh, saved_sc);
                    }
                }
            }
        }

        g_ds.real_wglMakeCurrent(target_hdc, rebind_ctx);

        /*
         * When `hwnd_gl_host` transitions from hidden (`SW_HIDE`) to visible on
         * macOS CrossOver (`winemac.drv`), attaching the live Cocoa drawable via
         * `real_wglMakeCurrent` resets the OpenGL context's `GL_VIEWPORT` and
         * `GL_SCISSOR_BOX` to the physical drawable size behind `wined3d`'s or
         * the game's dirty-state tracker. Restore the exact pre-rebind state.
         */
        if (has_int_state) {
            if (g_gl.p_glBindFramebuffer) {
                g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)saved_draw_fbo);
                g_gl.p_glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)saved_read_fbo);
            }
            if (g_gl.p_glViewport && saved_vp[2] > 0 && saved_vp[3] > 0) {
                g_gl.p_glViewport(saved_vp[0], saved_vp[1], saved_vp[2], saved_vp[3]);
            }
            if (g_gl.p_glScissor && saved_sc[2] >= 0 && saved_sc[3] >= 0) {
                g_gl.p_glScissor(saved_sc[0], saved_sc[1], saved_sc[2], saved_sc[3]);
            }
            if (was_scissor) {
                if (g_gl.p_glEnable) g_gl.p_glEnable(GL_SCISSOR_TEST);
            } else {
                if (g_gl.p_glDisable) g_gl.p_glDisable(GL_SCISSOR_TEST);
            }
        }
        ds_leave_internal();
    }
}

static BOOL ds_call_real_swap(HDC hdc, bool use_wgl_swap)
{
    return use_wgl_swap
        ? (g_ds.real_wglSwapBuffers ? g_ds.real_wglSwapBuffers(hdc) : FALSE)
        : (g_ds.real_SwapBuffers ? g_ds.real_SwapBuffers(hdc) : FALSE);
}

static bool ds_is_target_gl_win_locked(HWND win, bool allow_null)
{
    if (win == NULL) return allow_null;
    return (win == g_ds.hwnd_game || win == g_ds.hwnd_gl_host ||
            (g_ds.hwnd_game != NULL && IsChild(g_ds.hwnd_game, win)));
}

static BOOL ds_present_gl_and_swap(HDC hdc, bool use_wgl_swap, const void *caller_ret)
{
    if (!hdc || ds_is_internal_call()) {
        return ds_call_real_swap(hdc, use_wgl_swap);
    }
    ds_ensure_runtime_started();

    if (ds_is_wined3d_caller(caller_ret)) {
        HWND win = WindowFromDC(hdc);
        ds_lock();
        g_ds.wined3d_uses_gl = true;
        g_ds.wined3d_uses_vulkan = false;
        g_ds.gl_upscale_active = true;
        ds_notify_gl_context_active_locked();
        ds_unlock();

        if (win && win != g_ds.hwnd_gl_host && g_ds.hwnd_game == NULL && ds_is_candidate_game_window(win, NULL, NULL)) {
            ds_attach_and_apply_game_window(win, 0, 0);
        } else if (win && win == g_ds.hwnd_game) {
            ds_ensure_game_window_bounds(win);
        }

        HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);

        ds_lock();
        bool is_game_win = ds_is_target_gl_win_locked(win, false);
        if (is_game_win) {
            g_gl.last_present_was_gl = true;
        }
        bool fs_active = g_ds.fullscreen_active;
        int32_t win_scale = ds_get_windowed_scale_locked();
        ds_aspect_mode_t aspect = fs_active ? g_ds.aspect_mode : DS_ASPECT_PRESERVE;
        ds_scale_filter_t w3d_filter = g_ds.scale_filter;
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        int32_t dst_x = fs_active ? g_ds.vp.dst_x : 0;
        int32_t dst_y = fs_active ? g_ds.vp.dst_y : 0;
        int32_t dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
        int32_t dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
        int32_t real_h = fs_active ? g_ds.real_screen_h : dh;
        bool want_scale = (fs_active || (win_scale > 1)) && !ds_is_modern_tier_locked();
        ds_unlock();

        if (is_game_win) {
            InterlockedIncrement(&g_ds.gdi_margin_gen);
            ds_set_gl_host_visible(true);
            ds_gl_ensure_wgl_query_procs();
            if (!g_gl.w3d_scaled_in_blit && want_scale && vw > 0 && vh > 0 && dw > 0 && dh > 0 &&
                (vw != dw || vh != dh) && ds_gl_init_procs_once()) {
                HGLRC cur_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
                if (cur_ctx != NULL) {
                    int32_t gl_dst_y = real_h - (dst_y + dh);
                    ds_gl_upscale_wined3d_backbuffer(target_hdc, cur_ctx, vw, vh, dst_x, gl_dst_y, dw, dh, aspect, w3d_filter);
                }
            }
        }
        g_gl.w3d_scaled_in_blit = false;

        ds_enter_internal();
        BOOL w3d_swapped = ds_call_real_swap(target_hdc, use_wgl_swap);
        ds_leave_internal();

        if (is_game_win) {
            ds_gl_rebind_drawable_if_pending(target_hdc);
        }
        return w3d_swapped;
    }

    if (ds_is_system_renderer_caller(caller_ret)) {
        return ds_call_real_swap(hdc, use_wgl_swap);
    }

    HWND win = WindowFromDC(hdc);
    if (win) {
        ds_lock();
        g_ds.game_gl_active = true;
        g_ds.gl_upscale_active = true;
        ds_notify_gl_context_active_locked();
        ds_unlock();
    }
    if (win && win != g_ds.hwnd_gl_host && (g_ds.hwnd_game == NULL || g_ds.hwnd_game != win) && ds_is_candidate_game_window(win, NULL, NULL)) {
        ds_attach_and_apply_game_window(win, 0, 0);
    } else if (win && win == g_ds.hwnd_game) {
        ds_ensure_game_window_bounds(win);
    }

    HDC target_hdc = ds_gl_map_hdc_for_wgl(hdc);

    ds_lock();
    bool is_game_win = ds_is_target_gl_win_locked(win, false);
    bool fs_active = g_ds.fullscreen_active;
    int32_t win_scale = ds_get_windowed_scale_locked();
    ds_aspect_mode_t aspect = fs_active ? g_ds.aspect_mode : DS_ASPECT_PRESERVE;
    ds_scale_filter_t filter_mode = g_ds.scale_filter;
    int32_t vw = g_ds.virt_w;
    int32_t vh = g_ds.virt_h;
    int32_t dst_x = fs_active ? g_ds.vp.dst_x : 0;
    int32_t dst_y = fs_active ? g_ds.vp.dst_y : 0;
    int32_t dst_w = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
    int32_t dst_h = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
    int32_t dw = dst_w;
    int32_t dh = dst_h;
    int32_t backing_w = fs_active ? g_ds.phys_screen_w : (vw * win_scale);
    int32_t backing_h = fs_active ? g_ds.phys_screen_h : (vh * win_scale);
    bool want_fbo = (fs_active || (win_scale > 1)) && !ds_is_modern_tier_locked();
    if (fs_active) {
        ds_viewport_t phys_vp;
        if (ds_gl_compute_phys_viewport(backing_w, backing_h, vw, vh, aspect, &phys_vp)) {
            dst_x = phys_vp.dst_x;
            dst_y = phys_vp.dst_y;
            dst_w = phys_vp.dst_w;
            dst_h = phys_vp.dst_h;
        }
    }
    ds_unlock();

    if (is_game_win && ds_gl_init_procs_once()) {
        HGLRC cur_ctx = g_gl.p_wglGetCurrentContext ? g_gl.p_wglGetCurrentContext() : NULL;
        if (cur_ctx != NULL) {
            if (g_gl.game_hglrc != cur_ctx || g_gl.fbo_ctx != cur_ctx) {
                g_gl.game_hglrc = cur_ctx;
                ds_gl_sync_fbo_for_current_ctx(vw, vh, dw, dh, want_fbo);
            }
            if (cur_ctx == g_gl.game_hglrc) {
                ds_lock();
                g_gl.last_present_was_gl = true;
                ds_unlock();
                InterlockedIncrement(&g_ds.gdi_margin_gen);
                ds_set_gl_host_visible(true);
                if (g_gl.fbo_redirect_active && g_gl.fbo_id != 0 && want_fbo && dw > 0 && dh > 0) {
                    /* Rebind Cocoa drawable BEFORE blitting to FBO 0 while Frame 1 lives safely in `g_gl.fbo_id` */
                    ds_gl_rebind_drawable_if_pending(target_hdc);
                    GLint dx0 = dst_x;
                    GLint dy0 = backing_h - (dst_y + dst_h);
                    GLint dx1 = dst_x + dst_w;
                    GLint dy1 = dy0 + dst_h;
                    GLboolean was_scissor = GL_FALSE, was_srgb = GL_FALSE;
                    ds_gl_push_blit_caps(&was_scissor, &was_srgb);

                    g_gl.p_glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
                    if (g_ds.real_glDrawBuffer) {
                        GLint fbo0_draw = GL_BACK;
                        if (g_gl.p_glGetIntegerv) {
                            g_gl.p_glGetIntegerv(GL_DRAW_BUFFER, &fbo0_draw);
                        }
                        if (fbo0_draw != GL_BACK) {
                            g_ds.real_glDrawBuffer(GL_BACK);
                        }
                    }

                    ds_gl_clear_pillarbox_margins(dx0, dy0, dx1, dy1, backing_w, backing_h);
                    ds_gl_present_blit_to_backbuffer(
                        cur_ctx,
                        g_gl.fbo_id,
                        0,
                        0,
                        g_gl.fbo_w,
                        g_gl.fbo_h,
                        dx0,
                        dy0,
                        dx1,
                        dy1,
                        GL_COLOR_BUFFER_BIT,
                        (aspect == DS_ASPECT_INTEGER) ? GL_NEAREST : GL_LINEAR,
                        aspect,
                        filter_mode
                    );

                    ds_gl_pop_blit_caps(was_scissor, was_srgb);
                }

                ds_enter_internal();
                BOOL swapped = ds_call_real_swap(target_hdc, use_wgl_swap);
                ds_leave_internal();

                ds_gl_rebind_drawable_if_pending(target_hdc);

                /* Prepare FBO (or unbind to 0 if unscaled windowed) for next frame */
                ds_lock();
                fs_active = g_ds.fullscreen_active;
                win_scale = ds_get_windowed_scale_locked();
                vw = g_ds.virt_w;
                vh = g_ds.virt_h;
                dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
                dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
                want_fbo = (fs_active || (win_scale > 1)) && !ds_is_modern_tier_locked();
                ds_unlock();
                ds_gl_sync_fbo_for_current_ctx(vw, vh, dw, dh, want_fbo);
                return swapped;
            }
        }
    }

    return ds_call_real_swap(target_hdc, use_wgl_swap);
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
    InterlockedIncrement(&g_ds.gdi_margin_gen);
    if (!g_gl.fbo_supported || !g_gl.p_wglGetCurrentContext || g_gl.game_hglrc == NULL) {
        return;
    }
    if (g_gl.p_wglGetCurrentContext() == g_gl.game_hglrc) {
        ds_lock();
        bool fs_active = g_ds.fullscreen_active;
        int32_t win_scale = ds_get_windowed_scale_locked();
        int32_t vw = g_ds.virt_w;
        int32_t vh = g_ds.virt_h;
        int32_t dw = fs_active ? g_ds.vp.dst_w : (vw * win_scale);
        int32_t dh = fs_active ? g_ds.vp.dst_h : (vh * win_scale);
        bool want_fbo = (fs_active || (win_scale > 1)) && !ds_is_modern_tier_locked();
        ds_unlock();
        ds_gl_sync_fbo_for_current_ctx(vw, vh, dw, dh, want_fbo);
    }
}

void ds_gl_notify_display_mode_switch(void)
{
    memset(g_gl.last_w3d_vp, 0, sizeof(g_gl.last_w3d_vp));
    memset(g_gl.last_w3d_sc, 0, sizeof(g_gl.last_w3d_sc));
    InterlockedIncrement(&g_ds.gdi_margin_gen);
    InterlockedExchange(&g_gl.mode_trace_budget, 16);
}

/* -------------------------------------------------------------------------
 * Khronos Vulkan 1.0 ABI Swapchain Present Scaler (32-bit Legacy D3D on WineD3D Vulkan)
 *
 * When a 32-bit D3D9/D3D8/DDraw game requests sub-native exclusive fullscreen on
 * WineD3D Vulkan, `wined3d_swapchain_vk_blit` blits `src=(0,0)-(vw,vh)` into
 * `dst=(0,0)-(vw,vh)` of the full-monitor `VkSwapchainKHR`. Intercepting the
 * standard Khronos Vulkan 1.0 `vkCmdBlitImage` targeting tracked swapchain images
 * scales sub-native blits cleanly into the computed aspect viewport while leaving
 * native-resolution blits, internal texture blits, DXVK, and DX11/DX12 untouched.
 * ------------------------------------------------------------------------- */

#define DS_VK_MAX_SWAPCHAINS          4u
#define DS_VK_MAX_SC_IMAGES           8u
#define DS_VK_FILTER_NEAREST          0u
#define DS_VK_FILTER_LINEAR           1u
#define DS_VK_IMAGE_ASPECT_COLOR_BIT  1u
#define DS_VK_PIPELINE_STAGE_TRANSFER 0x1000u
#define DS_VK_ACCESS_TRANSFER_WRITE   0x1000u
#define DS_VK_STYPE_MEMORY_BARRIER    46u

typedef struct {
    uint32_t    sType;
    const void *pNext;
    uint32_t    flags;
    uint64_t    surface;
    uint32_t    minImageCount;
    uint32_t    imageFormat;
    uint32_t    imageColorSpace;
    uint32_t    extent_w;
    uint32_t    extent_h;
} ds_vk_swapchain_ci_t;

#if defined(_WIN64)
_Static_assert(offsetof(ds_vk_swapchain_ci_t, extent_w) == 44, "VkSwapchainCreateInfoKHR x64 extent_w");
_Static_assert(offsetof(ds_vk_swapchain_ci_t, extent_h) == 48, "VkSwapchainCreateInfoKHR x64 extent_h");
#else
_Static_assert(offsetof(ds_vk_swapchain_ci_t, extent_w) == 36, "VkSwapchainCreateInfoKHR x86 extent_w");
_Static_assert(offsetof(ds_vk_swapchain_ci_t, extent_h) == 40, "VkSwapchainCreateInfoKHR x86 extent_h");
#endif

typedef struct {
    uint32_t aspectMask;
    uint32_t mipLevel;
    uint32_t baseArrayLayer;
    uint32_t layerCount;
} ds_vk_subres_layers_t;

typedef struct {
    int32_t x;
    int32_t y;
    int32_t z;
} ds_vk_offset3d_t;

typedef struct {
    ds_vk_subres_layers_t srcSubresource;
    ds_vk_offset3d_t      srcOffsets[2];
    ds_vk_subres_layers_t dstSubresource;
    ds_vk_offset3d_t      dstOffsets[2];
} ds_vk_image_blit_t;

_Static_assert(sizeof(ds_vk_image_blit_t) == 80, "VkImageBlit ABI size");

typedef struct {
    uint32_t aspectMask;
    uint32_t baseMipLevel;
    uint32_t levelCount;
    uint32_t baseArrayLayer;
    uint32_t layerCount;
} ds_vk_subres_range_t;

typedef struct {
    float float32[4];
} ds_vk_clear_color_t;

typedef struct {
    uint32_t    sType;
    const void *pNext;
    uint32_t    srcAccessMask;
    uint32_t    dstAccessMask;
} ds_vk_mem_barrier_t;

typedef void (WINAPI *pfn_vkVoidFunction_t)(void);
typedef pfn_vkVoidFunction_t (WINAPI *pfn_vkGetInstanceProcAddr_t)(void *inst, const char *pName);
typedef pfn_vkVoidFunction_t (WINAPI *pfn_vkGetDeviceProcAddr_t)(void *dev, const char *pName);
typedef int32_t (WINAPI *pfn_vkCreateSwapchainKHR_t)(void *dev, const ds_vk_swapchain_ci_t *ci, const void *alloc, uint64_t *out_sc);
typedef void (WINAPI *pfn_vkDestroySwapchainKHR_t)(void *dev, uint64_t sc, const void *alloc);
typedef int32_t (WINAPI *pfn_vkGetSwapchainImagesKHR_t)(void *dev, uint64_t sc, uint32_t *count, uint64_t *imgs);
typedef void (WINAPI *pfn_vkCmdBlitImage_t)(
    void *cmd, uint64_t src_img, uint32_t src_layout, uint64_t dst_img, uint32_t dst_layout,
    uint32_t region_count, const ds_vk_image_blit_t *regions, uint32_t filter
);
typedef void (WINAPI *pfn_vkCmdClearColorImage_t)(
    void *cmd, uint64_t img, uint32_t layout, const ds_vk_clear_color_t *color,
    uint32_t range_count, const ds_vk_subres_range_t *ranges
);
typedef void (WINAPI *pfn_vkCmdPipelineBarrier_t)(
    void *cmd, uint32_t src_stage, uint32_t dst_stage, uint32_t dep_flags,
    uint32_t mem_cnt, const ds_vk_mem_barrier_t *mem_barriers,
    uint32_t buf_cnt, const void *buf_barriers,
    uint32_t img_cnt, const void *img_barriers
);

typedef struct {
    uint64_t sc;
    int32_t  ext_w;
    int32_t  ext_h;
    uint32_t img_count;
    uint64_t imgs[DS_VK_MAX_SC_IMAGES];
} ds_vk_swapchain_slot_t;

typedef struct {
    pfn_vkGetInstanceProcAddr_t  p_vkGetInstanceProcAddr;
    pfn_vkGetDeviceProcAddr_t    p_vkGetDeviceProcAddr;
    pfn_vkCreateSwapchainKHR_t   p_vkCreateSwapchainKHR;
    pfn_vkDestroySwapchainKHR_t  p_vkDestroySwapchainKHR;
    pfn_vkGetSwapchainImagesKHR_t p_vkGetSwapchainImagesKHR;
    pfn_vkCmdBlitImage_t         p_vkCmdBlitImage;
    pfn_vkCmdClearColorImage_t   p_vkCmdClearColorImage;
    pfn_vkCmdPipelineBarrier_t   p_vkCmdPipelineBarrier;
    ds_vk_swapchain_slot_t       slots[DS_VK_MAX_SWAPCHAINS];
    uint32_t                     next_slot;
    volatile LONG                has_swapchain_imgs;
} ds_vk_state_t;

static ds_vk_state_t g_vk;

static void ds_vk_recompute_has_imgs_locked(void)
{
    LONG any = 0;
    for (uint32_t i = 0; i < DS_VK_MAX_SWAPCHAINS; i++) {
        if (g_vk.slots[i].sc != 0 && g_vk.slots[i].img_count > 0) {
            any = 1;
            break;
        }
    }
    InterlockedExchange(&g_vk.has_swapchain_imgs, any);
}

static ds_vk_swapchain_slot_t *ds_vk_find_slot_locked(uint64_t key, bool by_img)
{
    for (uint32_t i = 0; i < DS_VK_MAX_SWAPCHAINS; i++) {
        ds_vk_swapchain_slot_t *s = &g_vk.slots[i];
        if (!by_img) {
            if (s->sc == key) return s;
        } else if (s->sc != 0) {
            for (uint32_t j = 0; j < s->img_count; j++) {
                if (s->imgs[j] == key) return s;
            }
        }
    }
    return NULL;
}

static int32_t WINAPI hook_vkCreateSwapchainKHR(
    void *dev, const ds_vk_swapchain_ci_t *ci, const void *alloc, uint64_t *out_sc
)
{
    if (!g_vk.p_vkCreateSwapchainKHR) return -13;
    int32_t res = g_vk.p_vkCreateSwapchainKHR(dev, ci, alloc, out_sc);
    if (res == 0 && ci != NULL && out_sc != NULL && *out_sc != 0 && ci->extent_w > 0 && ci->extent_h > 0) {
        uint64_t sc = *out_sc;
        ds_lock();
        ds_vk_swapchain_slot_t *s = ds_vk_find_slot_locked(sc, false);
        if (!s) s = ds_vk_find_slot_locked(0, false);
        if (!s) {
            uint32_t idx = g_vk.next_slot % DS_VK_MAX_SWAPCHAINS;
            g_vk.next_slot = (idx + 1u) % DS_VK_MAX_SWAPCHAINS;
            s = &g_vk.slots[idx];
        }
        memset(s, 0, sizeof(*s));
        s->sc = sc;
        s->ext_w = (int32_t)ci->extent_w;
        s->ext_h = (int32_t)ci->extent_h;
        ds_vk_recompute_has_imgs_locked();
        ds_unlock();
    }
    return res;
}

static int32_t WINAPI hook_vkGetSwapchainImagesKHR(
    void *dev, uint64_t sc, uint32_t *count, uint64_t *imgs
)
{
    if (!g_vk.p_vkGetSwapchainImagesKHR) return -13;
    int32_t res = g_vk.p_vkGetSwapchainImagesKHR(dev, sc, count, imgs);
    if ((res == 0 || res == 5) && sc != 0 && imgs != NULL && count != NULL && *count > 0) {
        uint32_t n = (*count > DS_VK_MAX_SC_IMAGES) ? DS_VK_MAX_SC_IMAGES : *count;
        ds_lock();
        ds_vk_swapchain_slot_t *s = ds_vk_find_slot_locked(sc, false);
        if (s) {
            memcpy(s->imgs, imgs, (size_t)n * sizeof(uint64_t));
            s->img_count = n;
            ds_vk_recompute_has_imgs_locked();
        }
        ds_unlock();
    }
    return res;
}

static void WINAPI hook_vkDestroySwapchainKHR(void *dev, uint64_t sc, const void *alloc)
{
    if (sc != 0) {
        ds_lock();
        ds_vk_swapchain_slot_t *s = ds_vk_find_slot_locked(sc, false);
        if (s) memset(s, 0, sizeof(*s));
        ds_vk_recompute_has_imgs_locked();
        ds_unlock();
    }
    if (g_vk.p_vkDestroySwapchainKHR) {
        g_vk.p_vkDestroySwapchainKHR(dev, sc, alloc);
    }
}

static void WINAPI hook_vkCmdBlitImage(
    void *cmd, uint64_t src_img, uint32_t src_layout, uint64_t dst_img, uint32_t dst_layout,
    uint32_t region_count, const ds_vk_image_blit_t *regions, uint32_t filter
)
{
    if (!g_vk.p_vkCmdBlitImage) return;
    if (g_vk.has_swapchain_imgs == 0 || region_count != 1u || regions == NULL) {
        g_vk.p_vkCmdBlitImage(cmd, src_img, src_layout, dst_img, dst_layout, region_count, regions, filter);
        return;
    }

    int32_t sc_w = 0, sc_h = 0;
    bool should_scale = false;
    ds_aspect_mode_t aspect = DS_ASPECT_PRESERVE;
    ds_viewport_t vp;
    memset(&vp, 0, sizeof(vp));

    int32_t sw = regions[0].srcOffsets[1].x - regions[0].srcOffsets[0].x;
    int32_t sh = regions[0].srcOffsets[1].y - regions[0].srcOffsets[0].y;
    if (sw < 0) sw = -sw;
    if (sh < 0) sh = -sh;

    ds_lock();
    ds_vk_swapchain_slot_t *s = ds_vk_find_slot_locked(dst_img, true);
    if (s && sw > 0 && sh > 0 && s->ext_w > 0 && s->ext_h > 0) {
        sc_w = s->ext_w;
        sc_h = s->ext_h;
        bool active = (
            ds_is_vulkan_d3d9_locked() &&
            !ds_is_passthrough_locked() &&
            !g_ds.user_forced_windowed &&
            (g_ds.fullscreen_active || g_ds.borderless_active)
        );
        if (active && sw >= sc_w && sh >= sc_h) {
            if (g_ds.mode_virtualized) {
                g_ds.mode_virtualized = false;
                g_ds.virt_w = g_ds.real_screen_w;
                g_ds.virt_h = g_ds.real_screen_h;
                ds_refresh_viewport_locked();
                ds_cursor_warp_reset(&g_ds.warp);
            }
        } else if (active && (sw < sc_w || sh < sc_h)) {
            if (g_ds.fullscreen_active && (g_ds.virt_w != sw || g_ds.virt_h != sh || !g_ds.mode_virtualized)) {
                g_ds.virt_w = sw;
                g_ds.virt_h = sh;
                g_ds.mode_virtualized = true;
                ds_refresh_viewport_locked();
            }
            aspect = g_ds.fullscreen_active ? g_ds.aspect_mode : DS_ASPECT_STRETCH;
            should_scale = g_ds.fullscreen_active
                ? ds_gl_compute_phys_viewport(sc_w, sc_h, sw, sh, aspect, &vp)
                : ds_compute_viewport(sc_w, sc_h, 0, sw, sh, aspect, &vp);
        }
    }
    ds_unlock();

    if (!should_scale || vp.dst_w <= 0 || vp.dst_h <= 0) {
        g_vk.p_vkCmdBlitImage(cmd, src_img, src_layout, dst_img, dst_layout, region_count, regions, filter);
        return;
    }

    if ((vp.dst_w < sc_w || vp.dst_h < sc_h) && g_vk.p_vkCmdClearColorImage && g_vk.p_vkCmdPipelineBarrier) {
        ds_vk_clear_color_t blk = { { 0.0f, 0.0f, 0.0f, 1.0f } };
        uint32_t lc = regions[0].dstSubresource.layerCount ? regions[0].dstSubresource.layerCount : 1u;
        ds_vk_subres_range_t rng = {
            DS_VK_IMAGE_ASPECT_COLOR_BIT,
            regions[0].dstSubresource.mipLevel,
            1u,
            regions[0].dstSubresource.baseArrayLayer,
            lc
        };
        g_vk.p_vkCmdClearColorImage(cmd, dst_img, dst_layout, &blk, 1u, &rng);
        ds_vk_mem_barrier_t mb = {
            DS_VK_STYPE_MEMORY_BARRIER,
            NULL,
            DS_VK_ACCESS_TRANSFER_WRITE,
            DS_VK_ACCESS_TRANSFER_WRITE
        };
        g_vk.p_vkCmdPipelineBarrier(
            cmd,
            DS_VK_PIPELINE_STAGE_TRANSFER,
            DS_VK_PIPELINE_STAGE_TRANSFER,
            0u,
            1u, &mb,
            0u, NULL,
            0u, NULL
        );
    }

    ds_vk_image_blit_t patched = regions[0];
    bool flip_x = (regions[0].dstOffsets[0].x > regions[0].dstOffsets[1].x);
    bool flip_y = (regions[0].dstOffsets[0].y > regions[0].dstOffsets[1].y);
    patched.dstOffsets[0].x = flip_x ? (vp.dst_x + vp.dst_w) : vp.dst_x;
    patched.dstOffsets[1].x = flip_x ? vp.dst_x : (vp.dst_x + vp.dst_w);
    patched.dstOffsets[0].y = flip_y ? (vp.dst_y + vp.dst_h) : vp.dst_y;
    patched.dstOffsets[1].y = flip_y ? vp.dst_y : (vp.dst_y + vp.dst_h);
    uint32_t out_filter = (aspect == DS_ASPECT_INTEGER) ? DS_VK_FILTER_NEAREST : DS_VK_FILTER_LINEAR;
    g_vk.p_vkCmdBlitImage(cmd, src_img, src_layout, dst_img, dst_layout, 1u, &patched, out_filter);
}

typedef struct {
    const char *name;
    uint16_t    real_off;
    void       *hook_fn;
} ds_vk_hook_def_t;

static const ds_vk_hook_def_t k_vk_hook_defs[] = {
    { "vkCreateSwapchainKHR",    (uint16_t)offsetof(ds_vk_state_t, p_vkCreateSwapchainKHR),    (void *)(uintptr_t)hook_vkCreateSwapchainKHR },
    { "vkGetSwapchainImagesKHR", (uint16_t)offsetof(ds_vk_state_t, p_vkGetSwapchainImagesKHR), (void *)(uintptr_t)hook_vkGetSwapchainImagesKHR },
    { "vkDestroySwapchainKHR",   (uint16_t)offsetof(ds_vk_state_t, p_vkDestroySwapchainKHR),   (void *)(uintptr_t)hook_vkDestroySwapchainKHR },
    { "vkCmdBlitImage",          (uint16_t)offsetof(ds_vk_state_t, p_vkCmdBlitImage),          (void *)(uintptr_t)hook_vkCmdBlitImage },
};

static pfn_vkVoidFunction_t ds_vk_match_hook_proc(void *dev, void *inst, const char *pName, pfn_vkVoidFunction_t real_fn)
{
    if (!pName || !real_fn) return real_fn;
    for (size_t i = 0; i < sizeof(k_vk_hook_defs) / sizeof(k_vk_hook_defs[0]); i++) {
        if (strcmp(pName, k_vk_hook_defs[i].name) == 0) {
            *(void **)(void *)((uint8_t *)&g_vk + k_vk_hook_defs[i].real_off) = (void *)(uintptr_t)real_fn;
            if (i == 3u) {
                pfn_vkVoidFunction_t clr = NULL, bar = NULL;
                if (dev != NULL && g_vk.p_vkGetDeviceProcAddr) {
                    clr = g_vk.p_vkGetDeviceProcAddr(dev, "vkCmdClearColorImage");
                    bar = g_vk.p_vkGetDeviceProcAddr(dev, "vkCmdPipelineBarrier");
                } else if (inst != NULL && g_vk.p_vkGetInstanceProcAddr) {
                    clr = g_vk.p_vkGetInstanceProcAddr(inst, "vkCmdClearColorImage");
                    bar = g_vk.p_vkGetInstanceProcAddr(inst, "vkCmdPipelineBarrier");
                }
                g_vk.p_vkCmdClearColorImage = (pfn_vkCmdClearColorImage_t)(uintptr_t)clr;
                g_vk.p_vkCmdPipelineBarrier = (pfn_vkCmdPipelineBarrier_t)(uintptr_t)bar;
            }
            return (pfn_vkVoidFunction_t)(uintptr_t)k_vk_hook_defs[i].hook_fn;
        }
    }
    return real_fn;
}

static pfn_vkVoidFunction_t WINAPI hook_vkGetDeviceProcAddr(void *dev, const char *pName)
{
    if (!g_vk.p_vkGetDeviceProcAddr) return NULL;
    pfn_vkVoidFunction_t real_fn = g_vk.p_vkGetDeviceProcAddr(dev, pName);
    return ds_vk_match_hook_proc(dev, NULL, pName, real_fn);
}

static pfn_vkVoidFunction_t WINAPI hook_vkGetInstanceProcAddr(void *inst, const char *pName)
{
    if (!g_vk.p_vkGetInstanceProcAddr) return NULL;
    pfn_vkVoidFunction_t real_fn = g_vk.p_vkGetInstanceProcAddr(inst, pName);
    if (!pName || !real_fn) return real_fn;
    if (strcmp(pName, "vkGetDeviceProcAddr") == 0) {
        g_vk.p_vkGetDeviceProcAddr = (pfn_vkGetDeviceProcAddr_t)(uintptr_t)real_fn;
        return (pfn_vkVoidFunction_t)(uintptr_t)hook_vkGetDeviceProcAddr;
    }
    return ds_vk_match_hook_proc(NULL, inst, pName, real_fn);
}

void *ds_resolve_wined3d_vk_proc(const char *name, void *real_fn)
{
    if (!name || !real_fn) return real_fn;
    if (strcmp(name, "vkGetInstanceProcAddr") == 0) {
        g_vk.p_vkGetInstanceProcAddr = (pfn_vkGetInstanceProcAddr_t)(uintptr_t)real_fn;
        ds_lock();
        if (!g_ds.wined3d_uses_gl) {
            g_ds.wined3d_uses_vulkan = true;
            (void)ds_update_presenter_tier_locked();
        }
        ds_unlock();
        return (void *)(uintptr_t)hook_vkGetInstanceProcAddr;
    }
    return real_fn;
}

void ds_gl_shutdown(void)
{
    g_gl.game_hglrc = NULL;
    g_gl.w3d_hglrc = NULL;
    g_gl.sharp_ctx = NULL;
    g_gl.fbo_redirect_active = false;
    g_gl.last_present_was_gl = false;
    InterlockedExchange(&g_vk.has_swapchain_imgs, 0);
    ds_gl_release_all_host_dcs_for_hwnd(NULL);
}

/* -------------------------------------------------------------------------
 * GDI 2D Stretch Presenter (Legacy 2D menus, Smacker/Bink FMVs, Win9x GDI)
 * ------------------------------------------------------------------------- */

static void ds_clear_gdi_margins(HDC hdcDst, int32_t dx, int32_t dy, int32_t dw, int32_t dh, bool force_clear)
{
    static HWND    s_last_win = NULL;
    static LONG    s_last_gen = -1;
    static int32_t s_last_dx = -1, s_last_dy = -1, s_last_dw = -1, s_last_dh = -1;

    if (!g_ds.fullscreen_active) {
        return;
    }

    HWND win = WindowFromDC(hdcDst);
    LONG cur_gen = g_ds.gdi_margin_gen;
    if (!force_clear && win == s_last_win && cur_gen == s_last_gen &&
        dx == s_last_dx && dy == s_last_dy && dw == s_last_dw && dh == s_last_dh) {
        return;
    }
    s_last_win = win;
    s_last_gen = cur_gen;
    s_last_dx = dx;
    s_last_dy = dy;
    s_last_dw = dw;
    s_last_dh = dh;

    int32_t sw = g_ds.real_screen_w;
    int32_t sh = g_ds.real_screen_h;
    if (sw <= 0 || sh <= 0) return;

    ds_enter_internal();
    /*
     * Clear pillarbox/letterbox margins via an unclipped window cache DC so any game-installed
     * clip region (`SelectClipRgn` / `BeginPaint` `rcPaint`) on `hdcDst` cannot leave stale
     * pixels in the outer bars.
     */
    HDC clear_dc = (win && win != GetDesktopWindow())
        ? GetDCEx(win, NULL, DCX_CACHE | DCX_CLIPSIBLINGS)
        : NULL;
    HDC target_dc = clear_dc ? clear_dc : hdcDst;
    if (dx > 0) {
        PatBlt(target_dc, 0, 0, dx, sh, BLACKNESS);
    }
    if (dx + dw < sw) {
        PatBlt(target_dc, dx + dw, 0, sw - (dx + dw), sh, BLACKNESS);
    }
    if (dy > 0) {
        PatBlt(target_dc, dx, 0, dw, dy, BLACKNESS);
    }
    if (dy + dh < sh) {
        PatBlt(target_dc, dx, dy + dh, dw, sh - (dy + dh), BLACKNESS);
    }
    if (clear_dc) {
        if (g_ds.real_ReleaseDC) {
            g_ds.real_ReleaseDC(win, clear_dc);
        } else {
            ReleaseDC(win, clear_dc);
        }
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
    ds_ensure_runtime_started();

    bool need_reset_gl_host = false;
    ds_lock();
    if (ds_is_modern_tier_locked()) {
        ds_unlock();
        return false;
    }
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
    if (is_game_gdi_target && match) {
        g_ds.ddraw_gdi_active = true;
    }
    if (is_game_gdi_target && (g_gl.last_present_was_gl || g_ds.gl_host_visible)) {
        g_gl.last_present_was_gl = false;
        need_reset_gl_host = true;
    }
    ds_unlock();

    if (need_reset_gl_host) {
        ds_reset_gl_host_for_gdi();
    }
    if (g_ds.trace_file[0] != L'\0' && is_game_gdi_target && InterlockedDecrement(&g_gl.mode_trace_budget) >= 0) {
        ds_tracef("gdi: win=%p m=%d rst=%d %dx%d",
                  win, (int)match, (int)need_reset_gl_host, (int)g_ds.virt_w, (int)g_ds.virt_h);
    }
    return match;
}

int WINAPI hook_GetDeviceCaps(HDC hdc, int index)
{
    if (!ds_is_internal_call() && !ds_is_system_renderer_caller(__builtin_return_address(0))) {
        ds_ensure_runtime_started();
        if (hdc == NULL || GetObjectType(hdc) == OBJ_DC) {
            ds_lock();
            bool passthrough = ds_is_modern_tier_locked();
            bool active = !passthrough && g_ds.fullscreen_active && g_ds.virt_w > 0 && g_ds.virt_h > 0;
            int32_t vw = g_ds.virt_w;
            int32_t vh = g_ds.virt_h;
            int32_t vbpp = g_ds.virt_bpp > 0 ? g_ds.virt_bpp : g_ds.real_bpp;
            int32_t vhz = g_ds.virt_hz > 0 ? g_ds.virt_hz : g_ds.real_hz;
            ds_unlock();

            if (!passthrough) {
                if (active) {
                    if (index == HORZRES || index == DESKTOPHORZRES) return vw;
                    if (index == VERTRES || index == DESKTOPVERTRES) return vh;
                    if (index == BITSPIXEL) {
                        if (ds_prefer_16bpp_ddraw() && vbpp > 16) return 16;
                        if (vbpp >= 8) return vbpp;
                    }
                    if (index == PLANES) return 1;
                    if (index == VREFRESH && vhz > 0) return vhz;
                }
                int real_val = g_ds.real_GetDeviceCaps ? g_ds.real_GetDeviceCaps(hdc, index) : 0;
                if (index == BITSPIXEL) {
                    if (ds_prefer_16bpp_ddraw()) return 16;
                    if (real_val < 8) return (vbpp >= 8) ? vbpp : 32;
                }
                if (index == PLANES && real_val < 1) return 1;
                return real_val;
            }
        }
    }
    return g_ds.real_GetDeviceCaps ? g_ds.real_GetDeviceCaps(hdc, index) : 0;
}

static int ds_gdi_enter_coloroncolor(HDC hdc)
{
    int prev = GetStretchBltMode(hdc);
    if (prev != COLORONCOLOR) {
        SetStretchBltMode(hdc, COLORONCOLOR);
    }
    return prev;
}

static void ds_gdi_leave_coloroncolor(HDC hdc, int prev)
{
    if (prev > 0 && prev != COLORONCOLOR) {
        SetStretchBltMode(hdc, prev);
    }
}

static BOOL ds_gdi_try_scaled_blt(
    HDC hdcDst, int xDst, int yDst, int wDst, int hDst,
    HDC hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc,
    DWORD rop, const void *caller_ret, BOOL *out_res
)
{
    int32_t vw = 0, vh = 0, dx = 0, dy = 0, dw = 0, dh = 0;
    if (hdcSrc != hdcDst && wDst > 0 && hDst > 0 && g_ds.real_StretchBlt &&
        ds_should_scale_gdi_dc(hdcDst, caller_ret, &vw, &vh, &dx, &dy, &dw, &dh)) {
        int32_t px = 0, py = 0, pw = 0, ph = 0;
        if (ds_map_subrect_virt_to_phys(xDst, yDst, wDst, hDst, dx, dy, dw, dh, vw, vh, &px, &py, &pw, &ph)) {
            ds_clear_gdi_margins(hdcDst, dx, dy, dw, dh, (xDst <= 0 && yDst <= 0 && wDst >= vw && hDst >= vh));
            int prev_mode = ds_gdi_enter_coloroncolor(hdcDst);
            *out_res = g_ds.real_StretchBlt(hdcDst, px, py, pw, ph, hdcSrc, xSrc, ySrc, wSrc, hSrc, rop);
            ds_gdi_leave_coloroncolor(hdcDst, prev_mode);
            return TRUE;
        }
    }
    return FALSE;
}

BOOL WINAPI hook_BitBlt(HDC hdcDst, int x, int y, int cx, int cy, HDC hdcSrc, int x1, int y1, DWORD rop)
{
    BOOL res = FALSE;
    if (ds_gdi_try_scaled_blt(hdcDst, x, y, cx, cy, hdcSrc, x1, y1, cx, cy, rop, __builtin_return_address(0), &res)) {
        return res;
    }
    return g_ds.real_BitBlt ? g_ds.real_BitBlt(hdcDst, x, y, cx, cy, hdcSrc, x1, y1, rop) : FALSE;
}

BOOL WINAPI hook_StretchBlt(HDC hdcDst, int xDst, int yDst, int wDst, int hDst, HDC hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, DWORD rop)
{
    BOOL res = FALSE;
    if (ds_gdi_try_scaled_blt(hdcDst, xDst, yDst, wDst, hDst, hdcSrc, xSrc, ySrc, wSrc, hSrc, rop, __builtin_return_address(0), &res)) {
        return res;
    }
    return g_ds.real_StretchBlt ? g_ds.real_StretchBlt(hdcDst, xDst, yDst, wDst, hDst, hdcSrc, xSrc, ySrc, wSrc, hSrc, rop) : FALSE;
}

int WINAPI hook_SetDIBitsToDevice(HDC hdc, int xDest, int yDest, DWORD w, DWORD h, int xSrc, int ySrc, UINT StartScan, UINT cLines, const VOID *lpvBits, const BITMAPINFO *lpbmi, UINT ColorUse)
{
    int32_t vw = 0, vh = 0, dx = 0, dy = 0, dw = 0, dh = 0;
    if (w > 0 && h > 0 && cLines > 0 && lpvBits != NULL && lpbmi != NULL && g_ds.real_StretchDIBits &&
        ds_should_scale_gdi_dc(hdc, __builtin_return_address(0), &vw, &vh, &dx, &dy, &dw, &dh)) {
        DWORD hdr_sz = lpbmi->bmiHeader.biSize;
        if (hdr_sz >= sizeof(BITMAPINFOHEADER) && hdr_sz <= 256) {
            LONG dib_h = lpbmi->bmiHeader.biHeight;
            int64_t abs_dib_h = (dib_h < 0) ? -(int64_t)dib_h : (int64_t)dib_h;
            if (abs_dib_h > 0) {
                int64_t s0 = (int64_t)ySrc > (int64_t)StartScan ? (int64_t)ySrc : (int64_t)StartScan;
                int64_t req_end = (int64_t)ySrc + (int64_t)h;
                int64_t buf_end = (int64_t)StartScan + (int64_t)cLines;
                int64_t s1 = req_end < buf_end ? req_end : buf_end;
                if (s1 > s0) {
                    int32_t vis_h = (int32_t)(s1 - s0);
                    int32_t band_y_dest = (dib_h > 0)
                        ? (int32_t)((int64_t)yDest + (req_end - s1))
                        : (int32_t)((int64_t)yDest + (s0 - (int64_t)ySrc));
                    int32_t adj_y_src = (int32_t)(s0 - (int64_t)StartScan);
                    int32_t px = 0, py = 0, pw = 0, ph = 0;
                    if (ds_map_subrect_virt_to_phys(xDest, band_y_dest, (int32_t)w, vis_h, dx, dy, dw, dh, vw, vh, &px, &py, &pw, &ph)) {
                        const BITMAPINFO *use_bmi = lpbmi;
                        uint8_t bmi_storage[256 + 1024];
                        if (StartScan != 0 || (int64_t)cLines < abs_dib_h) {
                            size_t pal_bytes = 0;
                            const BITMAPINFOHEADER *bh = &lpbmi->bmiHeader;
                            if (bh->biCompression == BI_BITFIELDS && hdr_sz < 108) {
                                pal_bytes = 3 * sizeof(DWORD);
                            } else if (bh->biBitCount > 0 && bh->biBitCount <= 8) {
                                uint32_t max_c = 1u << bh->biBitCount;
                                uint32_t n_cols = (bh->biClrUsed > 0 && bh->biClrUsed <= max_c) ? bh->biClrUsed : max_c;
                                pal_bytes = (size_t)n_cols * ((ColorUse == DIB_PAL_COLORS) ? sizeof(WORD) : sizeof(RGBQUAD));
                            } else if (bh->biClrUsed > 0 && bh->biClrUsed <= 256) {
                                pal_bytes = (size_t)bh->biClrUsed * ((ColorUse == DIB_PAL_COLORS) ? sizeof(WORD) : sizeof(RGBQUAD));
                            }
                            if ((size_t)hdr_sz + pal_bytes <= sizeof(bmi_storage)) {
                                memcpy(bmi_storage, lpbmi, (size_t)hdr_sz + pal_bytes);
                                BITMAPINFO *patched = (BITMAPINFO *)(void *)bmi_storage;
                                patched->bmiHeader.biHeight = (dib_h < 0) ? -(LONG)cLines : (LONG)cLines;
                                patched->bmiHeader.biSizeImage = 0;
                                use_bmi = patched;
                            } else {
                                use_bmi = NULL;
                            }
                        }
                        if (use_bmi != NULL) {
                            ds_clear_gdi_margins(hdc, dx, dy, dw, dh, (xDest <= 0 && band_y_dest <= 0 && (int32_t)w >= vw && vis_h >= vh));
                            int prev_mode = ds_gdi_enter_coloroncolor(hdc);
                            int drawn = g_ds.real_StretchDIBits(
                                hdc, px, py, pw, ph, xSrc, adj_y_src, (int)w, vis_h, lpvBits, use_bmi, ColorUse, SRCCOPY
                            );
                            ds_gdi_leave_coloroncolor(hdc, prev_mode);
                            return (drawn == (int)GDI_ERROR) ? 0 : vis_h;
                        }
                    }
                }
            }
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
            int prev_mode = ds_gdi_enter_coloroncolor(hdc);
            int res = g_ds.real_StretchDIBits(hdc, px, py, pw, ph, xSrc, ySrc, SrcWidth, SrcHeight, lpBits, lpbmi, iUsage, rop);
            ds_gdi_leave_coloroncolor(hdc, prev_mode);
            return res;
        }
    }
    return g_ds.real_StretchDIBits
        ? g_ds.real_StretchDIBits(hdc, xDest, yDest, DestWidth, DestHeight, xSrc, ySrc, SrcWidth, SrcHeight, lpBits, lpbmi, iUsage, rop)
        : 0;
}
