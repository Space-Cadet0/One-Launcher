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
/* Lock hierarchy:
 *   g_xcurl_shim_lock: serializes install/uninstall state (NEVER held across LdrRegister/Unregister
 *                      or CreateToolhelp32Snapshot, and NEVER acquired from ldr_dll_notification_cb).
 *   g_iat_patch_lock:  leaf lock serializing VirtualProtect + atomic IAT swap only
 *                      (NEVER calls GetModuleHandleExW / loader-lock APIs while held). */
static SRWLOCK g_xcurl_shim_lock = SRWLOCK_INIT;
static SRWLOCK g_iat_patch_lock = SRWLOCK_INIT;
static volatile LONG g_xcurl_hook_state = 0; /* 0 = uninitialized, 1 = installing, 2 = active/completed */
static volatile LONG g_iat_hooks_installed = 0;
static volatile LONG g_is_wine = 0;
static volatile LONG g_shim_next_appstate_reg = 0x0FFFL;

static inline PVOID shim_next_appstate_token(void)
{
    ULONG tok = (ULONG)InterlockedIncrement(&g_shim_next_appstate_reg);
    if (tok == 0) {
        tok = (ULONG)InterlockedIncrement(&g_shim_next_appstate_reg);
    }
    return (PVOID)(uintptr_t)tok;
}

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
    *registration = shim_next_appstate_token();
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
    *registration = shim_next_appstate_token();
    SetLastError(ERROR_SUCCESS);
    xgr_sync_teb_last_error();
    return ERROR_SUCCESS;
}

static VOID WINAPI shim_UnregisterAppConstrainedChangeNotification(PVOID registration)
{
    (void)registration;
    xgr_sync_teb_last_error();
}

static INIT_ONCE g_pin_bridge_once = INIT_ONCE_STATIC_INIT;

static BOOL CALLBACK pin_bridge_module_once_cb(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once;
    (void)param;
    (void)ctx;
#ifdef _WIN32
    HMODULE pinned = NULL;
    (void)GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        (LPCWSTR)(uintptr_t)pin_bridge_module_once_cb,
        &pinned
    );
#endif
    return TRUE;
}

static inline void ensure_bridge_module_pinned(void)
{
    InitOnceExecuteOnce(&g_pin_bridge_once, pin_bridge_module_once_cb, NULL, NULL);
}

static bool rva_in_image(uint32_t rva, size_t size, uint32_t image_size)
{
    if (image_size == 0 || rva >= image_size) return false;
    return size <= (size_t)(image_size - rva);
}

static bool cstr_in_image(const uint8_t *base, uint32_t rva, uint32_t image_size, size_t max_len)
{
    if (!base || rva >= image_size) return false;
    size_t avail = (size_t)(image_size - rva);
    if (avail > max_len) avail = max_len;
    const char *s = (const char *)(base + rva);
    return memchr(s, '\0', avail) != NULL;
}

static void replace_iat_slot(IMAGE_THUNK_DATA *thunk, void *new_fn, PVOID volatile *orig_slot)
{
    AcquireSRWLockExclusive(&g_iat_patch_lock);
    void *cur_fn = (void *)(uintptr_t)thunk->u1.Function;
    if (orig_slot && cur_fn != new_fn) {
        (void)InterlockedCompareExchangePointer(orig_slot, cur_fn, NULL);
    }
    if (cur_fn != new_fn) {
        DWORD old_prot = 0;
        if (VirtualProtect(&thunk->u1.Function, sizeof(uintptr_t), PAGE_READWRITE, &old_prot)) {
            (void)InterlockedExchangePointer((PVOID volatile *)&thunk->u1.Function, new_fn);
            DWORD restore_prot = 0;
            VirtualProtect(&thunk->u1.Function, sizeof(uintptr_t), old_prot, &restore_prot);
            InterlockedExchange(&g_iat_hooks_installed, 1);
        }
    }
    ReleaseSRWLockExclusive(&g_iat_patch_lock);
}

static void patch_module_iat(HMODULE hMod, bool allow_pin_bridge)
{
    HMODULE selfMod = (HMODULE)InterlockedCompareExchangePointer((PVOID *)&g_bridge_hmod, NULL, NULL);
    if (!hMod || hMod == selfMod) return;

    if (allow_pin_bridge) {
        /* Pin our bridge module BEFORE acquiring g_iat_patch_lock (GetModuleHandleExW takes loader lock). */
        ensure_bridge_module_pinned();
    }

    uint8_t *base = (uint8_t *)hMod;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    if (dos->e_lfanew < (LONG)sizeof(IMAGE_DOS_HEADER) || (uint32_t)dos->e_lfanew > 0x10000000u) return;

    uint32_t nt_rva = (uint32_t)dos->e_lfanew;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + nt_rva);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;
    if (nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR_MAGIC) return;

    uint32_t image_size = nt->OptionalHeader.SizeOfImage;
    if (image_size < nt_rva + (uint32_t)sizeof(IMAGE_NT_HEADERS)) return;
    if (nt->OptionalHeader.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_IMPORT) return;

    IMAGE_DATA_DIRECTORY imp_dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!imp_dir.VirtualAddress || imp_dir.Size < sizeof(IMAGE_IMPORT_DESCRIPTOR)) return;
    if (!rva_in_image(imp_dir.VirtualAddress, imp_dir.Size, image_size)) return;

    bool wine = (InterlockedCompareExchange(&g_is_wine, 0, 0) != 0);
    uint32_t imp_end = imp_dir.VirtualAddress + imp_dir.Size;
    for (uint32_t desc_rva = imp_dir.VirtualAddress;
         desc_rva + (uint32_t)sizeof(IMAGE_IMPORT_DESCRIPTOR) <= imp_end;
         desc_rva += (uint32_t)sizeof(IMAGE_IMPORT_DESCRIPTOR)) {
        IMAGE_IMPORT_DESCRIPTOR *desc = (IMAGE_IMPORT_DESCRIPTOR *)(base + desc_rva);
        if (desc->Name == 0) break;
        if (!cstr_in_image(base, desc->Name, image_size, 260)) continue;

        const char *dll_name = (const char *)(base + desc->Name);
        bool is_winhttp = wine && (_stricmp(dll_name, "winhttp.dll") == 0);
        bool is_appnotify = wine && (
            _stricmp(dll_name, "api-ms-win-core-psm-appnotify-l1-1-0.dll") == 0 ||
            _stricmp(dll_name, "twinapi.appcore.dll") == 0
        );
        bool is_playfab_gamesave = (_stricmp(dll_name, "PlayFabGameSave.dll") == 0);
        if (!is_winhttp && !is_appnotify && !is_playfab_gamesave) continue;
        if (!desc->OriginalFirstThunk || !desc->FirstThunk) continue;

        uint32_t orig_rva = desc->OriginalFirstThunk;
        uint32_t iat_rva = desc->FirstThunk;
        while (rva_in_image(orig_rva, sizeof(IMAGE_THUNK_DATA), image_size) &&
               rva_in_image(iat_rva, sizeof(IMAGE_THUNK_DATA), image_size)) {
            IMAGE_THUNK_DATA *orig_thunk = (IMAGE_THUNK_DATA *)(base + orig_rva);
            IMAGE_THUNK_DATA *iat_thunk = (IMAGE_THUNK_DATA *)(base + iat_rva);
            if (orig_thunk->u1.AddressOfData == 0) break;

            if (!IMAGE_SNAP_BY_ORDINAL(orig_thunk->u1.Ordinal)) {
                ULONG_PTR name_rva_ptr = orig_thunk->u1.AddressOfData;
                if (name_rva_ptr > 0 && name_rva_ptr < (ULONG_PTR)image_size) {
                    uint32_t name_rva = (uint32_t)name_rva_ptr;
                    if (rva_in_image(name_rva, sizeof(WORD) + 1, image_size) &&
                        cstr_in_image(base, name_rva + (uint32_t)sizeof(WORD), image_size, 256)) {
                        IMAGE_IMPORT_BY_NAME *imp_name = (IMAGE_IMPORT_BY_NAME *)(base + name_rva);
                        const char *fn = (const char *)imp_name->Name;

                        if (is_winhttp) {
                            if (strcmp(fn, "WinHttpSetOption") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_WinHttpSetOption, (PVOID volatile *)&g_real_WinHttpSetOption);
                            else if (strcmp(fn, "WinHttpSendRequest") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_WinHttpSendRequest, (PVOID volatile *)&g_real_WinHttpSendRequest);
                            else if (strcmp(fn, "WinHttpReceiveResponse") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_WinHttpReceiveResponse, (PVOID volatile *)&g_real_WinHttpReceiveResponse);
                            else if (strcmp(fn, "WinHttpQueryDataAvailable") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_WinHttpQueryDataAvailable, (PVOID volatile *)&g_real_WinHttpQueryDataAvailable);
                            else if (strcmp(fn, "WinHttpReadData") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_WinHttpReadData, (PVOID volatile *)&g_real_WinHttpReadData);
                            else if (strcmp(fn, "WinHttpWriteData") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_WinHttpWriteData, (PVOID volatile *)&g_real_WinHttpWriteData);
                            else if (strcmp(fn, "WinHttpCloseHandle") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_WinHttpCloseHandle, (PVOID volatile *)&g_real_WinHttpCloseHandle);
                        } else if (is_appnotify) {
                            if (strcmp(fn, "RegisterAppStateChangeNotification") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_RegisterAppStateChangeNotification, NULL);
                            else if (strcmp(fn, "UnregisterAppStateChangeNotification") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_UnregisterAppStateChangeNotification, NULL);
                            else if (strcmp(fn, "RegisterAppConstrainedChangeNotification") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_RegisterAppConstrainedChangeNotification, NULL);
                            else if (strcmp(fn, "UnregisterAppConstrainedChangeNotification") == 0)
                                replace_iat_slot(iat_thunk, (void *)shim_UnregisterAppConstrainedChangeNotification, NULL);
                        } else if (is_playfab_gamesave) {
                            void *orig_proc = (void *)(uintptr_t)iat_thunk->u1.Function;
                            void *replacement = xgr_playfab_resolve_iat_replacement(fn, orig_proc);
                            if (replacement) {
                                replace_iat_slot(iat_thunk, replacement, NULL);
                            }
                        }
                    }
                }
            }
            orig_rva += (uint32_t)sizeof(IMAGE_THUNK_DATA);
            iat_rva += (uint32_t)sizeof(IMAGE_THUNK_DATA);
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
            _wcsicmp(base_buf, L"one_xgameruntime_bridge_x86.dll") == 0 ||
            _wcsicmp(base_buf, L"one_appnotify_bridge.dll") == 0 ||
            _wcsicmp(base_buf, L"one_appnotify_bridge_x86.dll") == 0 ||
            _wcsicmp(base_buf, L"playfabgamesave.dll") == 0 ||
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
            wcsstr(lower, L"\\windows\\syswow64\\") != NULL ||
            wcsstr(lower, L"\\windows\\winsxs\\") != NULL) {
            return true;
        }
    }

    return false;
}

static void pin_and_patch_module(HMODULE candidate)
{
    if (!candidate) return;
    HMODULE pinned = NULL;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, (LPCWSTR)(uintptr_t)candidate, &pinned) && pinned) {
        patch_module_iat(pinned, true);
        FreeLibrary(pinned);
    }
}

static void patch_loaded_non_system_modules(void)
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
                    pin_and_patch_module(me.hModule);
                }
            } while (Module32NextW(snap, &me));
        }
        CloseHandle(snap);
        return;
    }

    /* Fallback if toolhelp snapshot is unavailable */
    HMODULE hMain = GetModuleHandleW(NULL);
    if (hMain && hMain != selfMod) pin_and_patch_module(hMain);
    HMODULE hXcurl = GetModuleHandleW(L"XCurl.dll");
    if (hXcurl) pin_and_patch_module(hXcurl);
    HMODULE hHttp = GetModuleHandleW(L"libHttpClient.GDK.dll");
    if (hHttp) pin_and_patch_module(hHttp);
}

static VOID CALLBACK ldr_dll_notification_cb(
    ULONG reason,
    const XGR_LDR_DLL_NOTIFICATION_DATA *data,
    PVOID ctx
)
{
    (void)ctx;
    /* LDR_DLL_NOTIFICATION_REASON_LOADED == 1 (runs under OS Loader Lock: NEVER take g_xcurl_shim_lock
     * or call GetModuleHandleExW here; bridge module was already pinned before registering callback). */
    if (reason == 1 && data && data->Loaded.DllBase) {
        HMODULE hMod = (HMODULE)data->Loaded.DllBase;
        HMODULE selfMod = (HMODULE)InterlockedCompareExchangePointer((PVOID *)&g_bridge_hmod, NULL, NULL);
        if (hMod == selfMod) return;

        const wchar_t *full_buf = data->Loaded.FullDllName ? data->Loaded.FullDllName->Buffer : NULL;
        size_t full_chars = data->Loaded.FullDllName ? (data->Loaded.FullDllName->Length / sizeof(wchar_t)) : 0;
        const wchar_t *base_buf = data->Loaded.BaseDllName ? data->Loaded.BaseDllName->Buffer : NULL;
        size_t base_chars = data->Loaded.BaseDllName ? (data->Loaded.BaseDllName->Length / sizeof(wchar_t)) : 0;

        if (!is_excluded_system_or_bridge_module(full_buf, full_chars, base_buf, base_chars)) {
            patch_module_iat(hMod, false);
        }
    }
}

void xgr_install_xcurl_shim(void)
{
    AcquireSRWLockExclusive(&g_xcurl_shim_lock);
    if (InterlockedCompareExchange(&g_xcurl_hook_state, 0, 0) != 0) {
        ReleaseSRWLockExclusive(&g_xcurl_shim_lock);
        return;
    }
    InterlockedExchange(&g_xcurl_hook_state, 1);
    ReleaseSRWLockExclusive(&g_xcurl_shim_lock);

    /* WinHTTP & AppNotify IAT hooks are Wine-gated via g_is_wine inside patch_module_iat;
     * PlayFabGameSave.dll in-proc IAT hooks run on both Wine and GamingServices-less win32. */
    InterlockedExchange(&g_is_wine, is_running_under_wine() ? 1 : 0);

    /* Pin bridge module and walk loaded modules OUTSIDE g_xcurl_shim_lock so loader lock
     * ordering can never invert with ldr_dll_notification_cb. */
    ensure_bridge_module_pinned();
    patch_loaded_non_system_modules();

    /* Register dynamic load notification for late LoadLibrary calls (outside g_xcurl_shim_lock) */
    PVOID new_cookie = NULL;
    PFN_LdrUnregisterDllNotification unreg_fn = NULL;
    HMODULE hNtdll = GetModuleHandleW(L"ntdll.dll");
    if (hNtdll) {
        PFN_LdrRegisterDllNotification pReg =
            (PFN_LdrRegisterDllNotification)(void *)GetProcAddress(hNtdll, "LdrRegisterDllNotification");
        unreg_fn =
            (PFN_LdrUnregisterDllNotification)(void *)GetProcAddress(hNtdll, "LdrUnregisterDllNotification");
        if (pReg) {
            pReg(0, ldr_dll_notification_cb, NULL, &new_cookie);
        }
    }

    PVOID duplicate_cookie = NULL;
    AcquireSRWLockExclusive(&g_xcurl_shim_lock);
    if (InterlockedCompareExchange(&g_xcurl_hook_state, 0, 0) == 1) {
        if (!g_ldr_cookie && new_cookie) {
            g_ldr_cookie = new_cookie;
            g_ldr_unregister = unreg_fn;
        } else if (new_cookie) {
            duplicate_cookie = new_cookie;
        }
        /* Always transition to 2 even if g_ldr_cookie == NULL so QueryApiImpl never re-walks on every call */
        InterlockedExchange(&g_xcurl_hook_state, 2);
    } else if (new_cookie) {
        /* Uninstalled while installing */
        duplicate_cookie = new_cookie;
    }
    ReleaseSRWLockExclusive(&g_xcurl_shim_lock);

    if (duplicate_cookie && unreg_fn) {
        unreg_fn(duplicate_cookie);
    }
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
