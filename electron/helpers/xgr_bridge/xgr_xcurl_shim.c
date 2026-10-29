/*
 * One Launcher XGR Bridge — Wine-Gated WinHTTP & PSM AppNotify IAT Shim
 *
 * Solves macOS Rosetta 2 / CrossOver Wine GDK middleware incompatibilities with zero Wine rebuilds:
 * 1. Wine-only gate (`ntdll!wine_get_version != NULL`): 100% no-op on native Windows (`win32`).
 * 2. `WinHttpSetOption`: swallows unsupported Wine option errors for `140`
 *    (`WINHTTP_OPTION_ASSURED_NON_BLOCKING_CALLBACKS` / `WINHTTP_OPTION_IPV6_FAST_FALLBACK`),
 *    `47` (`WINHTTP_OPTION_CLIENT_CERT_CONTEXT` when `lpBuffer == NULL`), and `133`
 *    (`WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL`).
 * 3. Synchronizes `%gs:0x68` (`TEB->LastErrorValue`) on exit from `WinHttp*` IAT calls.
 * 4. Hooks `api-ms-win-core-psm-appnotify-l1-1-0.dll` and `twinapi.appcore.dll`
 *    `RegisterAppStateChangeNotification` / `RegisterAppConstrainedChangeNotification`
 *    across all loaded and dynamically mapped non-system modules (`XCurl.dll`,
 *    `libHttpClient*.dll`, `Microsoft*Xbox*Services*.dll`, `Party*.dll`, `PlayFab*.dll`, `.exe`).
 */

#include "xgr_internal.h"
#include <tlhelp32.h>

#ifndef WINHTTP_OPTION_CLIENT_CERT_CONTEXT
#define WINHTTP_OPTION_CLIENT_CERT_CONTEXT 47
#endif

#ifndef WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL
#define WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL 133
#endif

#ifndef WINHTTP_OPTION_IPV6_FAST_FALLBACK
#define WINHTTP_OPTION_IPV6_FAST_FALLBACK 140
#endif

typedef void *HINTERNET;

typedef BOOL (WINAPI *PFN_WinHttpSetOption)(HINTERNET, DWORD, LPVOID, DWORD);
typedef BOOL (WINAPI *PFN_WinHttpSendRequest)(HINTERNET, LPCWSTR, DWORD, LPVOID, DWORD, DWORD, DWORD_PTR);
typedef BOOL (WINAPI *PFN_WinHttpReceiveResponse)(HINTERNET, LPVOID);
typedef BOOL (WINAPI *PFN_WinHttpQueryDataAvailable)(HINTERNET, LPDWORD);
typedef BOOL (WINAPI *PFN_WinHttpReadData)(HINTERNET, LPVOID, DWORD, LPDWORD);
typedef BOOL (WINAPI *PFN_WinHttpWriteData)(HINTERNET, LPCVOID, DWORD, LPDWORD);
typedef BOOL (WINAPI *PFN_WinHttpCloseHandle)(HINTERNET);

static PFN_WinHttpSetOption g_real_WinHttpSetOption = NULL;
static PFN_WinHttpSendRequest g_real_WinHttpSendRequest = NULL;
static PFN_WinHttpReceiveResponse g_real_WinHttpReceiveResponse = NULL;
static PFN_WinHttpQueryDataAvailable g_real_WinHttpQueryDataAvailable = NULL;
static PFN_WinHttpReadData g_real_WinHttpReadData = NULL;
static PFN_WinHttpWriteData g_real_WinHttpWriteData = NULL;
static PFN_WinHttpCloseHandle g_real_WinHttpCloseHandle = NULL;

/* ntdll LdrRegisterDllNotification types */
typedef struct _XGR_UNICODE_STRING {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR  Buffer;
} XGR_UNICODE_STRING;

typedef struct _XGR_LDR_DLL_LOADED_DATA {
    ULONG Flags;
    const XGR_UNICODE_STRING *FullDllName;
    const XGR_UNICODE_STRING *BaseDllName;
    PVOID DllBase;
    ULONG SizeOfImage;
} XGR_LDR_DLL_LOADED_DATA;

typedef union _XGR_LDR_DLL_NOTIFICATION_DATA {
    XGR_LDR_DLL_LOADED_DATA Loaded;
} XGR_LDR_DLL_NOTIFICATION_DATA;

typedef VOID (CALLBACK *PFN_LdrDllNotification)(
    ULONG NotificationReason,
    const XGR_LDR_DLL_NOTIFICATION_DATA *NotificationData,
    PVOID Context
);

typedef LONG (NTAPI *PFN_LdrRegisterDllNotification)(
    ULONG Flags,
    PFN_LdrDllNotification NotificationFunction,
    PVOID Context,
    PVOID *Cookie
);

typedef LONG (NTAPI *PFN_LdrUnregisterDllNotification)(PVOID Cookie);

static HMODULE g_bridge_hmod = NULL;
static PVOID g_ldr_cookie = NULL;
static PFN_LdrUnregisterDllNotification g_ldr_unregister = NULL;
static SRWLOCK g_xcurl_shim_lock = SRWLOCK_INIT;
static volatile LONG g_xcurl_hook_state = 0; /* 0 = uninitialized, 1 = installing, 2 = active/completed */
static volatile LONG g_iat_hooks_installed = 0;
static volatile LONGLONG g_shim_next_appstate_reg = 0x0FFFLL;

void xgr_set_bridge_hmodule(HMODULE hmod)
{
    InterlockedExchangePointer((PVOID *)&g_bridge_hmod, (PVOID)hmod);
}

static bool is_running_under_wine(void)
{
    HMODULE hNtdll = GetModuleHandleW(L"ntdll.dll");
    if (!hNtdll) return false;
    return GetProcAddress(hNtdll, "wine_get_version") != NULL;
}

static BOOL WINAPI shim_WinHttpSetOption(HINTERNET hInternet, DWORD dwOption, LPVOID lpBuffer, DWORD dwBufferLength)
{
    if (!g_real_WinHttpSetOption) {
        SetLastError(ERROR_INVALID_FUNCTION);
        xgr_sync_teb_last_error();
        return FALSE;
    }
    BOOL ok = g_real_WinHttpSetOption(hInternet, dwOption, lpBuffer, dwBufferLength);
    if (!ok) {
        if (dwOption == WINHTTP_OPTION_IPV6_FAST_FALLBACK ||
            dwOption == WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL ||
            (dwOption == WINHTTP_OPTION_CLIENT_CERT_CONTEXT && lpBuffer == NULL)) {
            SetLastError(ERROR_SUCCESS);
            xgr_sync_teb_last_error();
            return TRUE;
        }
    }
    xgr_sync_teb_last_error();
    return ok;
}

static BOOL WINAPI shim_WinHttpSendRequest(HINTERNET hRequest, LPCWSTR lpszHeaders, DWORD dwHeadersLength, LPVOID lpOptional, DWORD dwOptionalLength, DWORD dwTotalLength, DWORD_PTR dwContext)
{
    if (!g_real_WinHttpSendRequest) {
        SetLastError(ERROR_INVALID_FUNCTION);
        xgr_sync_teb_last_error();
        return FALSE;
    }
    BOOL ok = g_real_WinHttpSendRequest(hRequest, lpszHeaders, dwHeadersLength, lpOptional, dwOptionalLength, dwTotalLength, dwContext);
    xgr_sync_teb_last_error();
    return ok;
}

static BOOL WINAPI shim_WinHttpReceiveResponse(HINTERNET hRequest, LPVOID lpReserved)
{
    if (!g_real_WinHttpReceiveResponse) {
        SetLastError(ERROR_INVALID_FUNCTION);
        xgr_sync_teb_last_error();
        return FALSE;
    }
    BOOL ok = g_real_WinHttpReceiveResponse(hRequest, lpReserved);
    xgr_sync_teb_last_error();
    return ok;
}

static BOOL WINAPI shim_WinHttpQueryDataAvailable(HINTERNET hRequest, LPDWORD lpdwNumberOfBytesAvailable)
{
    if (!g_real_WinHttpQueryDataAvailable) {
        SetLastError(ERROR_INVALID_FUNCTION);
        xgr_sync_teb_last_error();
        return FALSE;
    }
    BOOL ok = g_real_WinHttpQueryDataAvailable(hRequest, lpdwNumberOfBytesAvailable);
    xgr_sync_teb_last_error();
    return ok;
}

static BOOL WINAPI shim_WinHttpReadData(HINTERNET hRequest, LPVOID lpBuffer, DWORD dwNumberOfBytesToRead, LPDWORD lpdwNumberOfBytesRead)
{
    if (!g_real_WinHttpReadData) {
        SetLastError(ERROR_INVALID_FUNCTION);
        xgr_sync_teb_last_error();
        return FALSE;
    }
    BOOL ok = g_real_WinHttpReadData(hRequest, lpBuffer, dwNumberOfBytesToRead, lpdwNumberOfBytesRead);
    xgr_sync_teb_last_error();
    return ok;
}

static BOOL WINAPI shim_WinHttpWriteData(HINTERNET hRequest, LPCVOID lpBuffer, DWORD dwNumberOfBytesToWrite, LPDWORD lpdwNumberOfBytesWritten)
{
    if (!g_real_WinHttpWriteData) {
        SetLastError(ERROR_INVALID_FUNCTION);
        xgr_sync_teb_last_error();
        return FALSE;
    }
    BOOL ok = g_real_WinHttpWriteData(hRequest, lpBuffer, dwNumberOfBytesToWrite, lpdwNumberOfBytesWritten);
    xgr_sync_teb_last_error();
    return ok;
}

static BOOL WINAPI shim_WinHttpCloseHandle(HINTERNET hInternet)
{
    if (!g_real_WinHttpCloseHandle) {
        SetLastError(ERROR_INVALID_FUNCTION);
        xgr_sync_teb_last_error();
        return FALSE;
    }
    BOOL ok = g_real_WinHttpCloseHandle(hInternet);
    xgr_sync_teb_last_error();
    return ok;
}

static ULONG WINAPI shim_RegisterAppStateChangeNotification(PVOID routine, PVOID context, PVOID *registration)
{
    (void)context;
    if (!routine || !registration) {
        SetLastError(ERROR_INVALID_PARAMETER);
        xgr_sync_teb_last_error();
        return ERROR_INVALID_PARAMETER;
    }
    *registration = (PVOID)(uintptr_t)InterlockedIncrement64(&g_shim_next_appstate_reg);
    SetLastError(ERROR_SUCCESS);
    xgr_sync_teb_last_error();
    return ERROR_SUCCESS;
}

static VOID WINAPI shim_UnregisterAppStateChangeNotification(PVOID registration)
{
    (void)registration;
    xgr_sync_teb_last_error();
}

static ULONG WINAPI shim_RegisterAppConstrainedChangeNotification(PVOID routine, PVOID context, PVOID *registration)
{
    (void)context;
    if (!routine || !registration) {
        SetLastError(ERROR_INVALID_PARAMETER);
        xgr_sync_teb_last_error();
        return ERROR_INVALID_PARAMETER;
    }
    *registration = (PVOID)(uintptr_t)InterlockedIncrement64(&g_shim_next_appstate_reg);
    SetLastError(ERROR_SUCCESS);
    xgr_sync_teb_last_error();
    return ERROR_SUCCESS;
}

static VOID WINAPI shim_UnregisterAppConstrainedChangeNotification(PVOID registration)
{
    (void)registration;
    xgr_sync_teb_last_error();
}

static void replace_iat_slot(IMAGE_THUNK_DATA *thunk, void *new_fn, void **orig_slot)
{
    if (orig_slot && *orig_slot == NULL && (void *)(uintptr_t)thunk->u1.Function != new_fn) {
        *orig_slot = (void *)(uintptr_t)thunk->u1.Function;
    }
    if ((void *)(uintptr_t)thunk->u1.Function == new_fn) {
        return;
    }
    DWORD old_prot = 0;
    if (VirtualProtect(&thunk->u1.Function, sizeof(uintptr_t), PAGE_READWRITE, &old_prot)) {
        thunk->u1.Function = (ULONG_PTR)(uintptr_t)new_fn;
        VirtualProtect(&thunk->u1.Function, sizeof(uintptr_t), old_prot, &old_prot);
        InterlockedExchange(&g_iat_hooks_installed, 1);
    }
}

static void patch_module_iat(HMODULE hMod)
{
    HMODULE selfMod = (HMODULE)InterlockedCompareExchangePointer((PVOID *)&g_bridge_hmod, NULL, NULL);
    if (!hMod || hMod == selfMod) return;

    uint8_t *base = (uint8_t *)hMod;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;

    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;

    IMAGE_DATA_DIRECTORY imp_dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!imp_dir.VirtualAddress || !imp_dir.Size) return;

    IMAGE_IMPORT_DESCRIPTOR *desc = (IMAGE_IMPORT_DESCRIPTOR *)(base + imp_dir.VirtualAddress);
    for (; desc->Name != 0; desc++) {
        const char *dll_name = (const char *)(base + desc->Name);
        bool is_winhttp = (_stricmp(dll_name, "winhttp.dll") == 0);
        bool is_appnotify = (
            _stricmp(dll_name, "api-ms-win-core-psm-appnotify-l1-1-0.dll") == 0 ||
            _stricmp(dll_name, "twinapi.appcore.dll") == 0
        );
        if (!is_winhttp && !is_appnotify) continue;
        if (!desc->OriginalFirstThunk || !desc->FirstThunk) continue;

        IMAGE_THUNK_DATA *orig_thunk = (IMAGE_THUNK_DATA *)(base + desc->OriginalFirstThunk);
        IMAGE_THUNK_DATA *iat_thunk = (IMAGE_THUNK_DATA *)(base + desc->FirstThunk);

        for (; orig_thunk->u1.AddressOfData != 0; orig_thunk++, iat_thunk++) {
            if (IMAGE_SNAP_BY_ORDINAL(orig_thunk->u1.Ordinal)) continue;
            IMAGE_IMPORT_BY_NAME *imp_name = (IMAGE_IMPORT_BY_NAME *)(base + orig_thunk->u1.AddressOfData);
            const char *fn = (const char *)imp_name->Name;

            if (is_winhttp) {
                if (strcmp(fn, "WinHttpSetOption") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_WinHttpSetOption, (void **)&g_real_WinHttpSetOption);
                else if (strcmp(fn, "WinHttpSendRequest") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_WinHttpSendRequest, (void **)&g_real_WinHttpSendRequest);
                else if (strcmp(fn, "WinHttpReceiveResponse") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_WinHttpReceiveResponse, (void **)&g_real_WinHttpReceiveResponse);
                else if (strcmp(fn, "WinHttpQueryDataAvailable") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_WinHttpQueryDataAvailable, (void **)&g_real_WinHttpQueryDataAvailable);
                else if (strcmp(fn, "WinHttpReadData") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_WinHttpReadData, (void **)&g_real_WinHttpReadData);
                else if (strcmp(fn, "WinHttpWriteData") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_WinHttpWriteData, (void **)&g_real_WinHttpWriteData);
                else if (strcmp(fn, "WinHttpCloseHandle") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_WinHttpCloseHandle, (void **)&g_real_WinHttpCloseHandle);
            } else if (is_appnotify) {
                if (strcmp(fn, "RegisterAppStateChangeNotification") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_RegisterAppStateChangeNotification, NULL);
                else if (strcmp(fn, "UnregisterAppStateChangeNotification") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_UnregisterAppStateChangeNotification, NULL);
                else if (strcmp(fn, "RegisterAppConstrainedChangeNotification") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_RegisterAppConstrainedChangeNotification, NULL);
                else if (strcmp(fn, "UnregisterAppConstrainedChangeNotification") == 0)
                    replace_iat_slot(iat_thunk, (void *)shim_UnregisterAppConstrainedChangeNotification, NULL);
            }
        }
    }
}

static bool is_excluded_system_or_bridge_module(const wchar_t *full_path, size_t full_chars, const wchar_t *base_name, size_t base_chars)
{
    wchar_t base_buf[128];
    if (base_name && base_chars > 0) {
        size_t n = (base_chars >= 128) ? 127 : base_chars;
        memcpy(base_buf, base_name, n * sizeof(wchar_t));
        base_buf[n] = L'\0';
        if (_wcsicmp(base_buf, L"xgameruntime.dll") == 0 ||
            _wcsicmp(base_buf, L"one_xgameruntime_bridge.dll") == 0 ||
            _wcsicmp(base_buf, L"one_appnotify_bridge.dll") == 0 ||
            _wcsicmp(base_buf, L"api-ms-win-core-psm-appnotify-l1-1-0.dll") == 0 ||
            _wcsicmp(base_buf, L"winhttp.dll") == 0 ||
            _wcsicmp(base_buf, L"twinapi.appcore.dll") == 0 ||
            _wcsicmp(base_buf, L"ntdll.dll") == 0 ||
            _wcsicmp(base_buf, L"kernel32.dll") == 0 ||
            _wcsicmp(base_buf, L"kernelbase.dll") == 0) {
            return true;
        }
    }

    if (full_path && full_chars > 0) {
        wchar_t lower[1024];
        size_t n = (full_chars >= 1024) ? 1023 : full_chars;
        for (size_t i = 0; i < n; i++) {
            wchar_t ch = full_path[i];
            if (ch == L'/') ch = L'\\';
            else if (ch >= L'A' && ch <= L'Z') ch = (wchar_t)(ch - L'A' + L'a');
            lower[i] = ch;
        }
        lower[n] = L'\0';
        if (wcsstr(lower, L"\\windows\\system32\\") != NULL ||
            wcsstr(lower, L"\\windows\\syswow64\\") != NULL) {
            return true;
        }
    }

    return false;
}

static void patch_loaded_non_system_modules_locked(void)
{
    HMODULE selfMod = (HMODULE)InterlockedCompareExchangePointer((PVOID *)&g_bridge_hmod, NULL, NULL);
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snap != INVALID_HANDLE_VALUE) {
        MODULEENTRY32W me;
        memset(&me, 0, sizeof(me));
        me.dwSize = sizeof(me);
        if (Module32FirstW(snap, &me)) {
            do {
                if (!me.hModule || me.hModule == selfMod) continue;
                if (!is_excluded_system_or_bridge_module(
                        me.szExePath, wcslen(me.szExePath),
                        me.szModule, wcslen(me.szModule))) {
                    patch_module_iat(me.hModule);
                }
            } while (Module32NextW(snap, &me));
        }
        CloseHandle(snap);
        return;
    }

    /* Fallback if toolhelp snapshot is unavailable */
    HMODULE hMain = GetModuleHandleW(NULL);
    if (hMain && hMain != selfMod) patch_module_iat(hMain);
    HMODULE hXcurl = GetModuleHandleW(L"XCurl.dll");
    if (hXcurl) patch_module_iat(hXcurl);
    HMODULE hHttp = GetModuleHandleW(L"libHttpClient.GDK.dll");
    if (hHttp) patch_module_iat(hHttp);
}

static VOID CALLBACK ldr_dll_notification_cb(
    ULONG reason,
    const XGR_LDR_DLL_NOTIFICATION_DATA *data,
    PVOID ctx
)
{
    (void)ctx;
    /* LDR_DLL_NOTIFICATION_REASON_LOADED == 1 */
    if (reason == 1 && data && data->Loaded.DllBase) {
        HMODULE hMod = (HMODULE)data->Loaded.DllBase;
        HMODULE selfMod = (HMODULE)InterlockedCompareExchangePointer((PVOID *)&g_bridge_hmod, NULL, NULL);
        if (hMod == selfMod) return;

        const wchar_t *full_buf = data->Loaded.FullDllName ? data->Loaded.FullDllName->Buffer : NULL;
        size_t full_chars = data->Loaded.FullDllName ? (data->Loaded.FullDllName->Length / sizeof(wchar_t)) : 0;
        const wchar_t *base_buf = data->Loaded.BaseDllName ? data->Loaded.BaseDllName->Buffer : NULL;
        size_t base_chars = data->Loaded.BaseDllName ? (data->Loaded.BaseDllName->Length / sizeof(wchar_t)) : 0;

        if (!is_excluded_system_or_bridge_module(full_buf, full_chars, base_buf, base_chars)) {
            patch_module_iat(hMod);
        }
    }
}

void xgr_install_xcurl_shim(void)
{
    AcquireSRWLockExclusive(&g_xcurl_shim_lock);
    if (InterlockedCompareExchange(&g_xcurl_hook_state, 0, 0) == 2) {
        ReleaseSRWLockExclusive(&g_xcurl_shim_lock);
        return;
    }
    InterlockedExchange(&g_xcurl_hook_state, 1);

    /* Wine-Only Gate: on native Windows, leave real winhttp.dll & twinapi.appcore.dll untouched */
    if (!is_running_under_wine()) {
        InterlockedExchange(&g_xcurl_hook_state, 2);
        ReleaseSRWLockExclusive(&g_xcurl_shim_lock);
        return;
    }

    patch_loaded_non_system_modules_locked();

    /* Register dynamic load notification for late LoadLibrary calls */
    HMODULE hNtdll = GetModuleHandleW(L"ntdll.dll");
    if (hNtdll && !g_ldr_cookie) {
        PFN_LdrRegisterDllNotification pReg =
            (PFN_LdrRegisterDllNotification)(void *)GetProcAddress(hNtdll, "LdrRegisterDllNotification");
        g_ldr_unregister =
            (PFN_LdrUnregisterDllNotification)(void *)GetProcAddress(hNtdll, "LdrUnregisterDllNotification");
        if (pReg) {
            pReg(0, ldr_dll_notification_cb, NULL, &g_ldr_cookie);
        }
    }

    /* Always transition to 2 even if g_ldr_cookie == NULL so QueryApiImpl never re-walks on every call */
    InterlockedExchange(&g_xcurl_hook_state, 2);
    ReleaseSRWLockExclusive(&g_xcurl_shim_lock);
}

void xgr_ensure_xcurl_shim(void)
{
    if (InterlockedCompareExchange(&g_xcurl_hook_state, 0, 0) == 2) {
        return;
    }
    xgr_install_xcurl_shim();
}

bool xgr_is_xcurl_shim_active(void)
{
    if (InterlockedCompareExchange(&g_iat_hooks_installed, 0, 0) != 0) {
        return true;
    }
    AcquireSRWLockShared(&g_xcurl_shim_lock);
    bool active = (g_ldr_cookie != NULL);
    ReleaseSRWLockShared(&g_xcurl_shim_lock);
    return active;
}

void xgr_uninstall_xcurl_shim(void)
{
    AcquireSRWLockExclusive(&g_xcurl_shim_lock);
    PVOID cookie = g_ldr_cookie;
    PFN_LdrUnregisterDllNotification unreg = g_ldr_unregister;
    g_ldr_cookie = NULL;
    InterlockedExchange(&g_xcurl_hook_state, 0);
    ReleaseSRWLockExclusive(&g_xcurl_shim_lock);

    if (cookie && unreg) {
        unreg(cookie);
    }
}
