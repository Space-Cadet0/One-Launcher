/*
 * One Launcher Shared Clean-Room Process Denylist (`common_process_denylist.h`)
 *
 * Single source of truth for non-game Wine/Windows system daemons, storefront
 * helpers, crash reporters, redistributable installers, and chaining launchers
 * shared across:
 *   - `electron/helpers/one_metal_preload.c`
 *   - `electron/helpers/one_coop_activate.c`
 *   - `electron/helpers/display_scaler/display_scaler_dll.c`
 *   - `electron/helpers/display_scaler/display_launcher.c`
 *
 * Uses compact double-NUL-terminated ASCII multi-sz string literals so Win32
 * PE32/PE64 binaries incur zero relocation overhead in `.rdata`.
 */

#ifndef ONE_LAUNCHER_COMMON_PROCESS_DENYLIST_H
#define ONE_LAUNCHER_COMMON_PROCESS_DENYLIST_H

#include <stdbool.h>
#include <stddef.h>

/* Core Wine/Windows non-GUI system daemons & One Launcher helper launchers */
#define ONE_DENYLIST_WINE_SYSTEM_MSZ \
    "services.exe\0"                 \
    "plugplay.exe\0"                 \
    "rpcss.exe\0"                    \
    "winedevice.exe\0"               \
    "explorer.exe\0"                 \
    "wineboot.exe\0"                 \
    "conhost.exe\0"                  \
    "svchost.exe\0"                  \
    "tabtip.exe\0"                   \
    "reg.exe\0"                      \
    "regedit.exe\0"                  \
    "regsvr32.exe\0"                 \
    "msiexec.exe\0"                  \
    "winecfg.exe\0"                  \
    "winedbg.exe\0"                  \
    "winemenubuilder.exe\0"          \
    "one_display_launcher_x86.exe\0" \
    "one_display_launcher_x64.exe\0" \
    "one_xgr_win_launcher.exe\0"     \
    "one_xgr_win_launcher_x86.exe\0"

/* Shell / script wrappers (chaining passthrough in scaler DLL; ignored elsewhere) */
#define ONE_DENYLIST_SHELL_MSZ \
    "cmd.exe\0"                \
    "powershell.exe\0"         \
    "rundll32.exe\0"

/* Background storefront daemons, web helpers & crash handlers */
#define ONE_DENYLIST_STOREFRONT_DAEMONS_MSZ \
    "steamwebhelper.exe\0"                  \
    "steamservice.exe\0"                    \
    "steamerrorreporter.exe\0"              \
    "steamerrorreporter64.exe\0"            \
    "gameoverlayui.exe\0"                   \
    "epicwebhelper.exe\0"                   \
    "gog galaxy notifications renderer.exe\0" \
    "eabackgroundservice.exe\0"             \
    "rockstarservice.exe\0"                 \
    "qtwebengineprocess.exe\0"              \
    "crashreportclient.exe\0"               \
    "crashhandler.exe\0"                    \
    "crashhandler64.exe\0"                  \
    "unitycrashhandler32.exe\0"             \
    "unitycrashhandler64.exe\0"

/* GOG Galaxy client & chaining helper processes */
#define ONE_DENYLIST_GALAXY_CHAIN_MSZ \
    "galaxyclient.exe\0"              \
    "galaxyclient helper.exe\0"       \
    "galaxyclienthelper.exe\0"        \
    "galaxycommunication.exe\0"       \
    "goglauncher.exe\0"

/* Storefront client launchers */
#define ONE_DENYLIST_STOREFRONT_CLIENTS_MSZ \
    "steam.exe\0"                           \
    "epicgameslauncher.exe\0"               \
    "eadesktop.exe\0"                       \
    "upc.exe\0"                             \
    "ubisoftconnect.exe\0"                  \
    "ubisoftgamelauncher.exe\0"             \
    "rockstarlauncher.exe\0"

/* Redistributable / anti-cheat setup installers */
#define ONE_DENYLIST_INSTALLERS_MSZ \
    "dxsetup.exe\0"                 \
    "vcredist_x86.exe\0"            \
    "vcredist_x64.exe\0"            \
    "vc_redist.x86.exe\0"           \
    "vc_redist.x64.exe\0"           \
    "easyanticheat_eos_setup.exe\0" \
    "battleye_launcher.exe\0"

/* Extensionless Unix/macOS Wine daemon tokens */
#define ONE_DENYLIST_UNIX_WINE_MSZ \
    "wineserver\0"                 \
    "reg\0"                        \
    "wineboot\0"

static inline bool one_denylist_ascii_ieq(const char *a, const char *b)
{
    if (!a || !b) return false;
    while (*a && *b) {
        unsigned char ca = (unsigned char)*a++;
        unsigned char cb = (unsigned char)*b++;
        if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca + ('a' - 'A'));
        if (cb >= 'A' && cb <= 'Z') cb = (unsigned char)(cb + ('a' - 'A'));
        if (ca != cb) return false;
    }
    return (*a == '\0' && *b == '\0');
}

static inline bool one_denylist_match_ascii_msz(const char *basename, const char *msz)
{
    if (!basename || !basename[0] || !msz) return false;
    for (const char *p = msz; *p != '\0'; ) {
        if (one_denylist_ascii_ieq(basename, p)) {
            return true;
        }
        while (*p != '\0') p++;
        p++;
    }
    return false;
}

#if defined(_WIN32)
static inline bool one_denylist_wcs_ieq_ascii(const WCHAR *w, const char *a)
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

static inline bool one_denylist_match_wcs_msz(const WCHAR *basename, const char *msz)
{
    if (!basename || !basename[0] || !msz) return false;
    for (const char *p = msz; *p != '\0'; ) {
        if (one_denylist_wcs_ieq_ascii(basename, p)) {
            return true;
        }
        while (*p != '\0') p++;
        p++;
    }
    return false;
}
#endif

#endif /* ONE_LAUNCHER_COMMON_PROCESS_DENYLIST_H */
