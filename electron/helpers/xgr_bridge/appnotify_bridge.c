/*
 * One Launcher Clean-Room Win64 PSM AppNotify Bridge (`one_appnotify_bridge.dll`)
 *
 * Implements `api-ms-win-core-psm-appnotify-l1-1-0.dll` exports used by GDK
 * `Microsoft.Xbox.Services.*.GDK.C.Thunks.dll`, `libHttpClient*.dll`, and `XCurl.dll`
 * when stock CrossOver/Wine `twinapi.appcore.dll` returns `ERROR_CALL_NOT_IMPLEMENTED` (120).
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <intrin.h>
#include <stdint.h>

#if defined(__GNUC__) || defined(__clang__)
__attribute__((used))
#endif
const char g_onelauncher_appnotify_marker[] = "OneLauncher.AppNotifyBridge.v1";

typedef VOID (NTAPI *PAPPSTATE_CHANGE_ROUTINE)(BOOLEAN Quiesced, PVOID Context);
typedef struct _APPSTATE_REGISTRATION *PAPPSTATE_REGISTRATION;

typedef VOID (NTAPI *PAPPCONSTRAINED_CHANGE_ROUTINE)(BOOLEAN Constrained, PVOID Context);
typedef struct _APPCONSTRAINED_REGISTRATION *PAPPCONSTRAINED_REGISTRATION;

static volatile LONG g_next_reg = 0x0FFFL;

static inline uintptr_t appnotify_next_reg_token(void)
{
    ULONG tok = (ULONG)InterlockedIncrement(&g_next_reg);
    if (tok == 0) {
        tok = (ULONG)InterlockedIncrement(&g_next_reg);
    }
    return (uintptr_t)tok;
}

static inline void appnotify_sync_teb_last_error(void)
{
#if defined(_WIN32) && (defined(__x86_64__) || defined(_M_X64))
    DWORD err = GetLastError();
    __writegsdword(0x68, err);
#elif defined(_WIN32) && (defined(__i386__) || defined(_M_IX86))
    DWORD err = GetLastError();
    __writefsdword(0x34, err);
#endif
}

ULONG WINAPI RegisterAppStateChangeNotification(
    PAPPSTATE_CHANGE_ROUTINE Routine,
    PVOID Context,
    PAPPSTATE_REGISTRATION *Registration
)
{
    (void)Context;
    if (!Routine || !Registration) {
        SetLastError(ERROR_INVALID_PARAMETER);
        appnotify_sync_teb_last_error();
        return ERROR_INVALID_PARAMETER;
    }
    *Registration = (PAPPSTATE_REGISTRATION)appnotify_next_reg_token();
    SetLastError(ERROR_SUCCESS);
    appnotify_sync_teb_last_error();
    return ERROR_SUCCESS;
}

VOID WINAPI UnregisterAppStateChangeNotification(PAPPSTATE_REGISTRATION Registration)
{
    (void)Registration;
    appnotify_sync_teb_last_error();
}

ULONG WINAPI RegisterAppConstrainedChangeNotification(
    PAPPCONSTRAINED_CHANGE_ROUTINE Routine,
    PVOID Context,
    PAPPCONSTRAINED_REGISTRATION *Registration
)
{
    (void)Context;
    if (!Routine || !Registration) {
        SetLastError(ERROR_INVALID_PARAMETER);
        appnotify_sync_teb_last_error();
        return ERROR_INVALID_PARAMETER;
    }
    *Registration = (PAPPCONSTRAINED_REGISTRATION)appnotify_next_reg_token();
    SetLastError(ERROR_SUCCESS);
    appnotify_sync_teb_last_error();
    return ERROR_SUCCESS;
}

VOID WINAPI UnregisterAppConstrainedChangeNotification(PAPPCONSTRAINED_REGISTRATION Registration)
{
    (void)Registration;
    appnotify_sync_teb_last_error();
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    volatile const char *marker_ref = g_onelauncher_appnotify_marker;
    if (!marker_ref || !marker_ref[0]) return FALSE;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
    }
    return TRUE;
}
