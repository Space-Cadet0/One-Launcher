/*
 * One Launcher Clean-Room Win32/Win64 Display Scaler Preloader & Session Watcher
 * (`one_display_launcher_x86.exe` / `one_display_launcher_x64.exe`)
 *
 * Modes:
 *   1. Direct Preload + Job Supervision:
 *      one_display_launcher_{x86,x64}.exe --dll-x86 <p> --dll-x64 <p>
 *        [--extra-dll-x86 <p>] [--extra-dll-x64 <p>] -- <targetExe> [args...]
 *   2. Live Process Injection:
 *      one_display_launcher_{x86,x64}.exe --inject-pid <pid> --dll <dllPath>
 *   3. Install-Directory Session Watcher:
 *      one_display_launcher_{x86,x64}.exe --watch-dir <winInstallDir>
 *        --dll-x86 <p> --dll-x64 <p> [--timeout-ms <ms>]
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include "display_scaler.h"

#ifndef JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
#define JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO 4
#endif

#ifndef PROCESS_QUERY_LIMITED_INFORMATION
#define PROCESS_QUERY_LIMITED_INFORMATION 0x1000
#endif

#if defined(__GNUC__) || defined(__clang__)
__attribute__((used))
#endif
const char g_onelauncher_display_launcher_marker[] = DS_MARKER_LAUNCHER;

enum {
    DS_LAUNCH_ERR_INVALID_ARGS   = 9101,
    DS_LAUNCH_ERR_CREATE_PROCESS = 9102,
    DS_LAUNCH_ERR_APC_INJECT     = 9103,
    DS_LAUNCH_ERR_RESUME_THREAD  = 9104,
    DS_LAUNCH_ERR_REMOTE_INJECT  = 9105,
    DS_LAUNCH_ERR_WATCH_TIMEOUT  = 9106
};

#if defined(_WIN64)
#define DS_SELF_MACHINE 0x8664u
#else
#define DS_SELF_MACHINE 0x014cu
#endif

static const WCHAR *skip_ws(const WCHAR *p)
{
    while (p && (*p == L' ' || *p == L'\t')) p++;
    return p;
}

static const WCHAR *skip_program_name(const WCHAR *cmd)
{
    if (!cmd) return L"";
    cmd = skip_ws(cmd);
    if (*cmd == L'"') {
        cmd++;
        while (*cmd && *cmd != L'"') cmd++;
        if (*cmd == L'"') cmd++;
        return cmd;
    }
    while (*cmd && *cmd != L' ' && *cmd != L'\t') cmd++;
    return cmd;
}

static WCHAR *parse_next_arg_alloc(const WCHAR **cursor)
{
    const WCHAR *p = skip_ws(*cursor);
    if (!p || *p == L'\0') {
        *cursor = p;
        return NULL;
    }

    size_t max_chars = wcslen(p) + 1;
    WCHAR *out = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, max_chars * sizeof(WCHAR));
    if (!out) return NULL;

    size_t dst = 0;
    bool in_quotes = false;

    while (*p != L'\0') {
        if (!in_quotes && (*p == L' ' || *p == L'\t')) break;

        size_t backslashes = 0;
        while (*p == L'\\') {
            backslashes++;
            p++;
        }

        if (*p == L'"') {
            size_t pairs = backslashes / 2;
            for (size_t i = 0; i < pairs; i++) out[dst++] = L'\\';
            if ((backslashes % 2) == 0) {
                p++;
                if (in_quotes && *p == L'"') {
                    out[dst++] = L'"';
                    p++;
                } else {
                    in_quotes = !in_quotes;
                }
            } else {
                out[dst++] = L'"';
                p++;
            }
            continue;
        }

        for (size_t i = 0; i < backslashes; i++) out[dst++] = L'\\';
        if (*p == L'\0' || (!in_quotes && (*p == L' ' || *p == L'\t'))) break;
        out[dst++] = *p++;
    }

    out[dst] = L'\0';
    *cursor = p;
    return out;
}

static WCHAR *dup_wstr_heap(const WCHAR *src)
{
    if (!src) return NULL;
    size_t bytes = (wcslen(src) + 1) * sizeof(WCHAR);
    WCHAR *copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, bytes);
    if (copy) memcpy(copy, src, bytes);
    return copy;
}

static const WCHAR *basename_w(const WCHAR *path)
{
    if (!path) return L"";
    const WCHAR *last = path;
    for (const WCHAR *p = path; *p != L'\0'; p++) {
        if (*p == L'\\' || *p == L'/') last = p + 1;
    }
    return last;
}

static bool is_excluded_helper_exe(const WCHAR *full_path)
{
    const WCHAR *base = basename_w(full_path);
    static const WCHAR *const k_skip[] = {
        L"explorer.exe", L"services.exe", L"winedevice.exe", L"plugplay.exe",
        L"svchost.exe", L"rpcss.exe", L"conhost.exe", L"cmd.exe", L"reg.exe",
        L"regedit.exe", L"winecfg.exe", L"winedbg.exe", L"msiexec.exe",
        L"rundll32.exe", L"wineboot.exe", L"winemenubuilder.exe",
        L"dxsetup.exe", L"vcredist_x86.exe", L"vcredist_x64.exe",
        L"steam.exe", L"steamwebhelper.exe", L"steamservice.exe",
        L"steamerrorreporter.exe", L"steamerrorreporter64.exe", L"gameoverlayui.exe",
        L"galaxyclient.exe", L"galaxyclienthelper.exe", L"galaxycommunication.exe",
        L"epicgameslauncher.exe", L"epicwebhelper.exe", L"crashreportclient.exe",
        L"one_display_launcher_x86.exe", L"one_display_launcher_x64.exe",
        L"one_xgr_win_launcher.exe", L"one_xgr_win_launcher_x86.exe"
    };
    for (size_t i = 0; i < sizeof(k_skip) / sizeof(k_skip[0]); i++) {
        if (_wcsicmp(base, k_skip[i]) == 0) return true;
    }
    return false;
}

static uint16_t read_pe_machine_w(const WCHAR *exe_path)
{
    if (!exe_path || !exe_path[0]) return 0;

    WCHAR resolved[MAX_PATH];
    const WCHAR *open_path = exe_path;
    if (GetFileAttributesW(exe_path) == INVALID_FILE_ATTRIBUTES) {
        if (SearchPathW(NULL, exe_path, L".exe", MAX_PATH, resolved, NULL) > 0) {
            open_path = resolved;
        }
    }

    HANDLE hf = CreateFileW(
        open_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL
    );
    if (hf == INVALID_HANDLE_VALUE) return 0;

    uint8_t dos[64];
    DWORD nr = 0;
    uint16_t machine = 0;
    if (ReadFile(hf, dos, sizeof(dos), &nr, NULL) && nr == sizeof(dos) && dos[0] == 'M' && dos[1] == 'Z') {
        uint32_t lfanew = 0;
        memcpy(&lfanew, dos + 0x3c, sizeof(uint32_t));
        if (SetFilePointer(hf, (LONG)lfanew, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER) {
            uint8_t pe[6];
            if (ReadFile(hf, pe, sizeof(pe), &nr, NULL) && nr == sizeof(pe) &&
                pe[0] == 'P' && pe[1] == 'E' && pe[2] == 0 && pe[3] == 0) {
                memcpy(&machine, pe + 4, sizeof(uint16_t));
            }
        }
    }
    CloseHandle(hf);
    return machine;
}

static uint32_t find_pe_export_rva_w(const WCHAR *dll_path, const char *export_name)
{
    if (!dll_path || !export_name) return 0;
    HANDLE hf = CreateFileW(
        dll_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL
    );
    if (hf == INVALID_HANDLE_VALUE) return 0;

    DWORD fsize = GetFileSize(hf, NULL);
    if (fsize == INVALID_FILE_SIZE || fsize < 512 || fsize > 4 * 1024 * 1024) {
        CloseHandle(hf);
        return 0;
    }

    uint8_t *buf = (uint8_t *)HeapAlloc(GetProcessHeap(), 0, fsize);
    if (!buf) {
        CloseHandle(hf);
        return 0;
    }

    DWORD nr = 0;
    uint32_t found_rva = 0;
    if (ReadFile(hf, buf, fsize, &nr, NULL) && nr == fsize && buf[0] == 'M' && buf[1] == 'Z') {
        uint32_t pe_off = 0;
        memcpy(&pe_off, buf + 0x3c, 4);
        if (pe_off + 24 < fsize && memcmp(buf + pe_off, "PE\0\0", 4) == 0) {
            uint16_t nsec = 0, opt_sz = 0, magic = 0;
            memcpy(&nsec, buf + pe_off + 6, 2);
            memcpy(&opt_sz, buf + pe_off + 20, 2);
            uint32_t opt_off = pe_off + 24;
            if (opt_off + opt_sz <= fsize && opt_sz >= 96) {
                memcpy(&magic, buf + opt_off, 2);
                uint32_t dd_off = (magic == 0x010bu) ? (opt_off + 96u) : ((magic == 0x020bu) ? (opt_off + 112u) : 0u);
                uint32_t sec_off = opt_off + opt_sz;
                if (dd_off != 0 && dd_off + 8 <= fsize && sec_off + (uint32_t)nsec * 40u <= fsize) {
                    uint32_t exp_rva = 0;
                    memcpy(&exp_rva, buf + dd_off, 4);
                    /* Convert RVA helper via section table */
                    #define DS_RVA_TO_OFF(rva_val, out_off) do { \
                        (out_off) = 0; \
                        for (uint16_t _si = 0; _si < nsec; _si++) { \
                            uint32_t _sh = sec_off + (uint32_t)_si * 40u; \
                            uint32_t _vs = 0, _va = 0, _rs = 0, _ro = 0; \
                            memcpy(&_vs, buf + _sh + 8, 4); \
                            memcpy(&_va, buf + _sh + 12, 4); \
                            memcpy(&_rs, buf + _sh + 16, 4); \
                            memcpy(&_ro, buf + _sh + 20, 4); \
                            uint32_t _sp = (_vs > _rs) ? _vs : _rs; \
                            if ((rva_val) >= _va && (rva_val) < _va + _sp && ((rva_val) - _va) < _rs) { \
                                (out_off) = _ro + ((rva_val) - _va); \
                                break; \
                            } \
                        } \
                    } while (0)

                    uint32_t exp_off = 0;
                    DS_RVA_TO_OFF(exp_rva, exp_off);
                    if (exp_off != 0 && exp_off + 40 <= fsize) {
                        uint32_t num_names = 0, funcs_rva = 0, names_rva = 0, ords_rva = 0;
                        memcpy(&num_names, buf + exp_off + 24, 4);
                        memcpy(&funcs_rva, buf + exp_off + 28, 4);
                        memcpy(&names_rva, buf + exp_off + 32, 4);
                        memcpy(&ords_rva,  buf + exp_off + 36, 4);
                        uint32_t funcs_off = 0, names_off = 0, ords_off = 0;
                        DS_RVA_TO_OFF(funcs_rva, funcs_off);
                        DS_RVA_TO_OFF(names_rva, names_off);
                        DS_RVA_TO_OFF(ords_rva, ords_off);
                        if (funcs_off && names_off && ords_off &&
                            names_off + num_names * 4 <= fsize &&
                            ords_off + num_names * 2 <= fsize) {
                            for (uint32_t ni = 0; ni < num_names; ni++) {
                                uint32_t nm_rva = 0, nm_off = 0;
                                memcpy(&nm_rva, buf + names_off + ni * 4, 4);
                                DS_RVA_TO_OFF(nm_rva, nm_off);
                                if (nm_off && nm_off < fsize && strcmp((const char *)(buf + nm_off), export_name) == 0) {
                                    uint16_t ord_idx = 0;
                                    memcpy(&ord_idx, buf + ords_off + ni * 2, 2);
                                    if (funcs_off + ((uint32_t)ord_idx + 1u) * 4u <= fsize) {
                                        memcpy(&found_rva, buf + funcs_off + (uint32_t)ord_idx * 4u, 4);
                                    }
                                    break;
                                }
                            }
                        }
                    }
                    #undef DS_RVA_TO_OFF
                }
            }
        }
    }

    HeapFree(GetProcessHeap(), 0, buf);
    CloseHandle(hf);
    return found_rva;
}

static bool queue_apc_dll_load(HANDLE hProcess, HANDLE hThread, FARPROC pLoadLibraryW, const WCHAR *dll_path)
{
    if (!dll_path || !dll_path[0] || !pLoadLibraryW) return false;
    SIZE_T bytes = (wcslen(dll_path) + 1) * sizeof(WCHAR);
    LPVOID remote = VirtualAllocEx(hProcess, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) return false;
    SIZE_T written = 0;
    if (!WriteProcessMemory(hProcess, remote, dll_path, bytes, &written) || written != bytes) {
        VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
        return false;
    }
    if (QueueUserAPC((PAPCFUNC)(uintptr_t)pLoadLibraryW, hThread, (ULONG_PTR)remote) == 0) {
        VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
        return false;
    }
    return true;
}

static BYTE *find_remote_module_base_w(DWORD pid, const WCHAR *dll_basename)
{
    if (pid == 0 || !dll_basename || !dll_basename[0]) return NULL;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid);
    if (snap == INVALID_HANDLE_VALUE) return NULL;

    BYTE *found = NULL;
    MODULEENTRY32W me;
    memset(&me, 0, sizeof(me));
    me.dwSize = sizeof(me);
    if (Module32FirstW(snap, &me)) {
        do {
            if (_wcsicmp(me.szModule, dll_basename) == 0 ||
                _wcsicmp(basename_w(me.szExePath), dll_basename) == 0) {
                found = me.modBaseAddr;
                break;
            }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return found;
}

static bool inject_dll_into_pid_same_arch(DWORD pid, const WCHAR *dll_path)
{
    if (pid == 0 || !dll_path || !dll_path[0]) return false;
    const WCHAR *base = basename_w(dll_path);

    HANDLE hp = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
        FALSE,
        pid
    );
    if (!hp) return false;

    BYTE *mod_base = find_remote_module_base_w(pid, base);
    if (!mod_base) {
        HMODULE hK32 = GetModuleHandleW(L"kernel32.dll");
        FARPROC pLLW = hK32 ? GetProcAddress(hK32, "LoadLibraryW") : NULL;
        if (!pLLW) {
            CloseHandle(hp);
            return false;
        }

        SIZE_T bytes = (wcslen(dll_path) + 1) * sizeof(WCHAR);
        LPVOID remote = VirtualAllocEx(hp, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!remote) {
            CloseHandle(hp);
            return false;
        }

        SIZE_T written = 0;
        if (!WriteProcessMemory(hp, remote, dll_path, bytes, &written) || written != bytes) {
            VirtualFreeEx(hp, remote, 0, MEM_RELEASE);
            CloseHandle(hp);
            return false;
        }

        HANDLE ht = CreateRemoteThread(hp, NULL, 0, (LPTHREAD_START_ROUTINE)(uintptr_t)pLLW, remote, 0, NULL);
        if (!ht) {
            VirtualFreeEx(hp, remote, 0, MEM_RELEASE);
            CloseHandle(hp);
            return false;
        }

        WaitForSingleObject(ht, 10000);
        CloseHandle(ht);
        VirtualFreeEx(hp, remote, 0, MEM_RELEASE);
        mod_base = find_remote_module_base_w(pid, base);
    }

    if (mod_base) {
        uint32_t scan_rva = find_pe_export_rva_w(dll_path, "OneLauncherDisplayScalerTriggerScan");
        if (scan_rva != 0) {
            LPTHREAD_START_ROUTINE pScan = (LPTHREAD_START_ROUTINE)(uintptr_t)(mod_base + scan_rva);
            HANDLE ht2 = CreateRemoteThread(hp, NULL, 0, pScan, NULL, 0, NULL);
            if (ht2) {
                WaitForSingleObject(ht2, 3000);
                CloseHandle(ht2);
            }
        }
    }

    CloseHandle(hp);
    return (mod_base != NULL);
}

static bool resolve_sibling_launcher_exe(uint16_t target_machine, WCHAR *out_buf, size_t cap)
{
    if (!out_buf || cap == 0) return false;
    out_buf[0] = L'\0';

    const WCHAR *env_name = (target_machine == 0x014cu)
        ? L"ONE_LAUNCHER_LAUNCHER_EXE_X86"
        : L"ONE_LAUNCHER_LAUNCHER_EXE_X64";
    DWORD n = GetEnvironmentVariableW(env_name, out_buf, (DWORD)cap);
    if (n > 0 && n < (DWORD)cap && GetFileAttributesW(out_buf) != INVALID_FILE_ATTRIBUTES) {
        return true;
    }

    WCHAR self_path[MAX_PATH];
    if (GetModuleFileNameW(NULL, self_path, MAX_PATH) == 0) return false;
    size_t len = wcslen(self_path);
    const WCHAR *want_suffix = (target_machine == 0x014cu) ? L"_x86.exe" : L"_x64.exe";
    if (len > 8 && (_wcsicmp(self_path + len - 8, L"_x86.exe") == 0 || _wcsicmp(self_path + len - 8, L"_x64.exe") == 0)) {
        if (len < cap) {
            memcpy(out_buf, self_path, (len - 8) * sizeof(WCHAR));
            memcpy(out_buf + (len - 8), want_suffix, 9 * sizeof(WCHAR));
            if (GetFileAttributesW(out_buf) != INVALID_FILE_ATTRIBUTES) {
                return true;
            }
        }
    }
    out_buf[0] = L'\0';
    return false;
}

static void export_propagation_env(const WCHAR *dll_x86, const WCHAR *dll_x64)
{
    if (dll_x86 && dll_x86[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_SCALER_DLL_X86", dll_x86);
    if (dll_x64 && dll_x64[0]) SetEnvironmentVariableW(L"ONE_LAUNCHER_SCALER_DLL_X64", dll_x64);

    WCHAR self_path[MAX_PATH];
    if (GetModuleFileNameW(NULL, self_path, MAX_PATH) > 0) {
#if defined(_WIN64)
        SetEnvironmentVariableW(L"ONE_LAUNCHER_LAUNCHER_EXE_X64", self_path);
        WCHAR sib[MAX_PATH];
        if (resolve_sibling_launcher_exe(0x014cu, sib, MAX_PATH)) {
            SetEnvironmentVariableW(L"ONE_LAUNCHER_LAUNCHER_EXE_X86", sib);
        }
#else
        SetEnvironmentVariableW(L"ONE_LAUNCHER_LAUNCHER_EXE_X86", self_path);
        WCHAR sib[MAX_PATH];
        if (resolve_sibling_launcher_exe(0x8664u, sib, MAX_PATH)) {
            SetEnvironmentVariableW(L"ONE_LAUNCHER_LAUNCHER_EXE_X64", sib);
        }
#endif
    }
}

static bool inject_pid_dispatch(DWORD pid, const WCHAR *explicit_dll, const WCHAR *dll_x86, const WCHAR *dll_x64)
{
    WCHAR proc_img[MAX_PATH];
    proc_img[0] = L'\0';
    HANDLE hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hp) {
        DWORD sz = MAX_PATH;
        QueryFullProcessImageNameW(hp, 0, proc_img, &sz);
        CloseHandle(hp);
    }

    uint16_t target_machine = read_pe_machine_w(proc_img);
    if (target_machine == 0 && explicit_dll && explicit_dll[0]) {
        target_machine = read_pe_machine_w(explicit_dll);
    }
    if (target_machine == 0) {
        target_machine = DS_SELF_MACHINE;
    }

    const WCHAR *chosen_dll = explicit_dll;
    if (!chosen_dll || !chosen_dll[0]) {
        chosen_dll = (target_machine == 0x014cu) ? dll_x86 : dll_x64;
    }
    if (!chosen_dll || !chosen_dll[0]) return false;

    if (target_machine == DS_SELF_MACHINE) {
        return inject_dll_into_pid_same_arch(pid, chosen_dll);
    }

    WCHAR sib_exe[MAX_PATH];
    if (!resolve_sibling_launcher_exe(target_machine, sib_exe, MAX_PATH)) {
        return false;
    }

    WCHAR cmd[MAX_PATH * 3];
    _snwprintf(cmd, (sizeof(cmd) / sizeof(WCHAR)) - 1, L"\"%ls\" --inject-pid %lu --dll \"%ls\"", sib_exe, (unsigned long)pid, chosen_dll);
    cmd[(sizeof(cmd) / sizeof(WCHAR)) - 1] = L'\0';

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);
    if (!CreateProcessW(sib_exe, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        return false;
    }
    WaitForSingleObject(pi.hProcess, 12000);
    DWORD exit_code = 1;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (exit_code == 0);
}

static void normalize_dir_prefix_w(const WCHAR *src, WCHAR *out_buf, size_t cap)
{
    if (!out_buf || cap == 0) return;
    out_buf[0] = L'\0';
    if (!src || !src[0]) return;

    size_t j = 0;
    for (size_t i = 0; src[i] != L'\0' && j + 2 < cap; i++) {
        WCHAR ch = src[i];
        if (ch == L'/') ch = L'\\';
        else if (ch >= L'A' && ch <= L'Z') ch = (WCHAR)(ch - L'A' + L'a');
        out_buf[j++] = ch;
    }
    while (j > 3 && out_buf[j - 1] == L'\\') j--;
    if (j > 0 && out_buf[j - 1] != L'\\') {
        out_buf[j++] = L'\\';
    }
    out_buf[j] = L'\0';
}

static int run_watch_dir_mode(const WCHAR *watch_dir, const WCHAR *dll_x86, const WCHAR *dll_x64, DWORD timeout_ms)
{
    WCHAR norm_dir[MAX_PATH];
    normalize_dir_prefix_w(watch_dir, norm_dir, MAX_PATH);
    size_t dir_len = wcslen(norm_dir);
    if (dir_len == 0) return DS_LAUNCH_ERR_INVALID_ARGS;

    DWORD self_pid = GetCurrentProcessId();
    ULONGLONG start_ms = GetTickCount64();
    DWORD max_wait = (timeout_ms > 0) ? timeout_ms : 90000u;

    for (;;) {
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W pe;
            memset(&pe, 0, sizeof(pe));
            pe.dwSize = sizeof(pe);
            if (Process32FirstW(snap, &pe)) {
                do {
                    if (pe.th32ProcessID == 0 || pe.th32ProcessID == self_pid) continue;
                    if (is_excluded_helper_exe(pe.szExeFile)) continue;

                    HANDLE hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pe.th32ProcessID);
                    if (!hp) continue;

                    WCHAR img[MAX_PATH];
                    img[0] = L'\0';
                    DWORD sz = MAX_PATH;
                    BOOL got = QueryFullProcessImageNameW(hp, 0, img, &sz);
                    CloseHandle(hp);
                    if (!got || img[0] == L'\0' || is_excluded_helper_exe(img)) continue;

                    WCHAR norm_img[MAX_PATH];
                    size_t k = 0;
                    for (; img[k] != L'\0' && k + 1 < MAX_PATH; k++) {
                        WCHAR c = img[k];
                        if (c == L'/') c = L'\\';
                        else if (c >= L'A' && c <= L'Z') c = (WCHAR)(c - L'A' + L'a');
                        norm_img[k] = c;
                    }
                    norm_img[k] = L'\0';

                    if (k > dir_len && memcmp(norm_img, norm_dir, dir_len * sizeof(WCHAR)) == 0) {
                        if (inject_pid_dispatch(pe.th32ProcessID, NULL, dll_x86, dll_x64)) {
                            CloseHandle(snap);
                            return 0;
                        }
                    }
                } while (Process32NextW(snap, &pe));
            }
            CloseHandle(snap);
        }

        if ((GetTickCount64() - start_ms) >= (ULONGLONG)max_wait) {
            return DS_LAUNCH_ERR_WATCH_TIMEOUT;
        }
        Sleep(50);
    }
}

static bool is_excluded_pid(DWORD pid)
{
    if (pid == 0) return true;
    HANDLE hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hp) {
        WCHAR img[MAX_PATH];
        img[0] = L'\0';
        DWORD sz = MAX_PATH;
        BOOL got = QueryFullProcessImageNameW(hp, 0, img, &sz);
        CloseHandle(hp);
        if (got && img[0] != L'\0') {
            return is_excluded_helper_exe(img);
        }
    }

    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe;
        memset(&pe, 0, sizeof(pe));
        pe.dwSize = sizeof(pe);
        bool excluded = false;
        if (Process32FirstW(snap, &pe)) {
            do {
                if (pe.th32ProcessID == pid) {
                    excluded = is_excluded_helper_exe(pe.szExeFile);
                    break;
                }
            } while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);
        return excluded;
    }
    return false;
}

static bool job_has_live_descendants(HANDLE job, DWORD exited_root_pid, HANDLE *inout_descendant)
{
    if (!job) return false;
    DWORD self_pid = GetCurrentProcessId();

    if (inout_descendant && *inout_descendant != NULL) {
        if (WaitForSingleObject(*inout_descendant, 0) == WAIT_TIMEOUT) {
            return true;
        }
        CloseHandle(*inout_descendant);
        *inout_descendant = NULL;
    }

    HANDLE heap = GetProcessHeap();
    size_t pid_cap = 64;
    for (int attempt = 0; attempt < 8; attempt++) {
        size_t buf_bytes = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + pid_cap * sizeof(ULONG_PTR);
        JOBOBJECT_BASIC_PROCESS_ID_LIST *list =
            (JOBOBJECT_BASIC_PROCESS_ID_LIST *)HeapAlloc(heap, HEAP_ZERO_MEMORY, buf_bytes);
        if (!list) break;

        DWORD ret_len = 0;
        BOOL ok = QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, (DWORD)buf_bytes, &ret_len);
        DWORD q_err = ok ? ERROR_SUCCESS : GetLastError();

        if (!ok && q_err == ERROR_MORE_DATA) {
            size_t needed = (size_t)list->NumberOfAssignedProcesses;
            HeapFree(heap, 0, list);
            pid_cap = (needed >= pid_cap) ? (needed + 64) : (pid_cap * 2);
            continue;
        }
        if (!ok) {
            HeapFree(heap, 0, list);
            break;
        }

        bool any_alive = false;
        for (DWORD i = 0; i < list->NumberOfProcessIdsInList; i++) {
            DWORD pid = (DWORD)list->ProcessIdList[i];
            if (pid == 0 || pid == exited_root_pid || pid == self_pid) continue;
            if (is_excluded_pid(pid)) continue;
            HANDLE hp = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if (!hp) {
                if (GetLastError() == ERROR_ACCESS_DENIED) any_alive = true;
                continue;
            }
            if (WaitForSingleObject(hp, 0) == WAIT_TIMEOUT) {
                any_alive = true;
                if (inout_descendant) {
                    if (*inout_descendant != NULL) CloseHandle(*inout_descendant);
                    *inout_descendant = hp;
                    hp = NULL;
                }
                if (hp) CloseHandle(hp);
                break;
            }
            CloseHandle(hp);
        }
        HeapFree(heap, 0, list);
        return any_alive;
    }

    return false;
}

static bool match_opt_val(const WCHAR *tok, const WCHAR *opt_name, const WCHAR **cursor, WCHAR **out_val)
{
    size_t n = wcslen(opt_name);
    if (wcscmp(tok, opt_name) == 0) {
        if (*out_val) HeapFree(GetProcessHeap(), 0, *out_val);
        *out_val = parse_next_arg_alloc(cursor);
        return true;
    }
    if (wcsncmp(tok, opt_name, n) == 0 && tok[n] == L'=') {
        if (*out_val) HeapFree(GetProcessHeap(), 0, *out_val);
        *out_val = dup_wstr_heap(tok + n + 1);
        return true;
    }
    return false;
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nShowCmd)
{
    (void)hInstance;
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nShowCmd;

    volatile const char *marker_ref = g_onelauncher_display_launcher_marker;
    if (!marker_ref || !marker_ref[0]) {
        ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);
    }

    HANDLE heap = GetProcessHeap();
    const WCHAR *full_args_tail = skip_ws(skip_program_name(GetCommandLineW()));
    const WCHAR *cursor = full_args_tail;

    WCHAR *dll_x86 = NULL;
    WCHAR *dll_x64 = NULL;
    WCHAR *dll_single = NULL;
    WCHAR *extra_x86[8] = { 0 };
    WCHAR *extra_x64[8] = { 0 };
    size_t extra_x86_count = 0;
    size_t extra_x64_count = 0;
    WCHAR *inject_pid_str = NULL;
    WCHAR *inject_tid_str = NULL;
    WCHAR *watch_dir = NULL;
    WCHAR *timeout_str = NULL;
    const WCHAR *target_cmdline_tail = NULL;

    for (;;) {
        cursor = skip_ws(cursor);
        if (!cursor || *cursor == L'\0') break;

        WCHAR *tok = parse_next_arg_alloc(&cursor);
        if (!tok) break;

        if (wcscmp(tok, L"--") == 0) {
            HeapFree(heap, 0, tok);
            target_cmdline_tail = skip_ws(cursor);
            break;
        }

        WCHAR *tmp_extra = NULL;
        if (match_opt_val(tok, L"--dll-x86", &cursor, &dll_x86) ||
            match_opt_val(tok, L"--dll-x64", &cursor, &dll_x64) ||
            match_opt_val(tok, L"--dll", &cursor, &dll_single) ||
            match_opt_val(tok, L"--inject-pid", &cursor, &inject_pid_str) ||
            match_opt_val(tok, L"--tid", &cursor, &inject_tid_str) ||
            match_opt_val(tok, L"--watch-dir", &cursor, &watch_dir) ||
            match_opt_val(tok, L"--watch-bottle-session", &cursor, &watch_dir) ||
            match_opt_val(tok, L"--timeout-ms", &cursor, &timeout_str)) {
            HeapFree(heap, 0, tok);
            continue;
        }
        if (match_opt_val(tok, L"--extra-dll-x86", &cursor, &tmp_extra)) {
            HeapFree(heap, 0, tok);
            if (tmp_extra && extra_x86_count < 8) extra_x86[extra_x86_count++] = tmp_extra;
            else if (tmp_extra) HeapFree(heap, 0, tmp_extra);
            continue;
        }
        if (match_opt_val(tok, L"--extra-dll-x64", &cursor, &tmp_extra)) {
            HeapFree(heap, 0, tok);
            if (tmp_extra && extra_x64_count < 8) extra_x64[extra_x64_count++] = tmp_extra;
            else if (tmp_extra) HeapFree(heap, 0, tmp_extra);
            continue;
        }

        HeapFree(heap, 0, tok);
        ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);
    }

    /* Auto-discover sibling DLLs from own directory when omitted on CLI */
    {
        WCHAR self_exe[MAX_PATH] = { 0 };
        if (GetModuleFileNameW(NULL, self_exe, MAX_PATH - 1) > 0) {
            WCHAR *last_sep = NULL;
            for (WCHAR *p = self_exe; *p; p++) {
                if (*p == L'\\' || *p == L'/') last_sep = p;
            }
            if (last_sep) {
                *last_sep = L'\0';
                if (!dll_x86 || !dll_x86[0]) {
                    WCHAR cand[MAX_PATH];
                    _snwprintf(cand, MAX_PATH - 1, L"%ls\\one_display_scaler_x86.dll", self_exe);
                    cand[MAX_PATH - 1] = L'\0';
                    if (GetFileAttributesW(cand) != INVALID_FILE_ATTRIBUTES) {
                        if (dll_x86) HeapFree(heap, 0, dll_x86);
                        dll_x86 = dup_wstr_heap(cand);
                    }
                }
                if (!dll_x64 || !dll_x64[0]) {
                    WCHAR cand[MAX_PATH];
                    _snwprintf(cand, MAX_PATH - 1, L"%ls\\one_display_scaler_x64.dll", self_exe);
                    cand[MAX_PATH - 1] = L'\0';
                    if (GetFileAttributesW(cand) != INVALID_FILE_ATTRIBUTES) {
                        if (dll_x64) HeapFree(heap, 0, dll_x64);
                        dll_x64 = dup_wstr_heap(cand);
                    }
                }
            }
        }
    }

    export_propagation_env(dll_x86, dll_x64);

    /* Mode 2: --inject-pid <pid> [--tid <tid>] --dll <dllPath> */
    if (inject_pid_str && inject_pid_str[0] != L'\0') {
        DWORD pid = (DWORD)wcstoul(inject_pid_str, NULL, 10);
        DWORD tid = (inject_tid_str && inject_tid_str[0] != L'\0') ? (DWORD)wcstoul(inject_tid_str, NULL, 10) : 0;
        if (pid == 0) ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);
        if (tid != 0) {
            /*
             * Suspended child APC injection (`--tid != 0`):
             * NEVER fall through to `CreateRemoteThread` (`inject_pid_dispatch`) on a
             * `CREATE_SUSPENDED` process whose `LdrInitializeThunk` has not yet run.
             */
            WCHAR proc_img[MAX_PATH] = { 0 };
            HANDLE hp_q = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if (hp_q) {
                DWORD sz = MAX_PATH;
                QueryFullProcessImageNameW(hp_q, 0, proc_img, &sz);
                CloseHandle(hp_q);
            }
            uint16_t child_mach = read_pe_machine_w(proc_img);
            if (child_mach == 0 && dll_single && dll_single[0]) {
                child_mach = read_pe_machine_w(dll_single);
            }
            if (child_mach == 0) {
                child_mach = DS_SELF_MACHINE;
            }
            const WCHAR *chosen_dll = (dll_single && dll_single[0])
                ? dll_single
                : ((child_mach == 0x014cu) ? dll_x86 : dll_x64);
            if (!chosen_dll || !chosen_dll[0]) {
                ExitProcess(DS_LAUNCH_ERR_APC_INJECT);
            }
            if (child_mach != DS_SELF_MACHINE) {
                WCHAR sib_exe[MAX_PATH];
                if (!resolve_sibling_launcher_exe(child_mach, sib_exe, MAX_PATH)) {
                    ExitProcess(DS_LAUNCH_ERR_APC_INJECT);
                }
                WCHAR cmd[MAX_PATH * 3];
                _snwprintf(
                    cmd,
                    (sizeof(cmd) / sizeof(WCHAR)) - 1,
                    L"\"%ls\" --inject-pid %lu --tid %lu --dll \"%ls\"",
                    sib_exe,
                    (unsigned long)pid,
                    (unsigned long)tid,
                    chosen_dll
                );
                cmd[(sizeof(cmd) / sizeof(WCHAR)) - 1] = L'\0';
                STARTUPINFOW si_apc;
                PROCESS_INFORMATION pi_apc;
                memset(&si_apc, 0, sizeof(si_apc));
                memset(&pi_apc, 0, sizeof(pi_apc));
                si_apc.cb = sizeof(si_apc);
                if (!CreateProcessW(sib_exe, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si_apc, &pi_apc)) {
                    ExitProcess(DS_LAUNCH_ERR_APC_INJECT);
                }
                WaitForSingleObject(pi_apc.hProcess, 5000);
                DWORD apc_exit = 1;
                GetExitCodeProcess(pi_apc.hProcess, &apc_exit);
                CloseHandle(pi_apc.hThread);
                CloseHandle(pi_apc.hProcess);
                ExitProcess(apc_exit == 0 ? 0u : DS_LAUNCH_ERR_APC_INJECT);
            }

            HANDLE hp = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_WRITE, FALSE, pid);
            HANDLE ht = OpenThread(THREAD_SET_CONTEXT, FALSE, tid);
            HMODULE hK32 = GetModuleHandleW(L"kernel32.dll");
            FARPROC pLLW = hK32 ? GetProcAddress(hK32, "LoadLibraryW") : NULL;
            bool apc_ok = (hp && ht && pLLW) ? queue_apc_dll_load(hp, ht, pLLW, chosen_dll) : false;
            if (ht) CloseHandle(ht);
            if (hp) CloseHandle(hp);
            ExitProcess(apc_ok ? 0u : DS_LAUNCH_ERR_APC_INJECT);
        }
        bool ok = inject_pid_dispatch(pid, dll_single, dll_x86, dll_x64);
        ExitProcess(ok ? 0u : DS_LAUNCH_ERR_REMOTE_INJECT);
    }

    /* Mode 3: --watch-dir <winInstallDir> --dll-x86 <path> --dll-x64 <path> [--timeout-ms <ms>] */
    if (watch_dir && watch_dir[0] != L'\0') {
        DWORD timeout_ms = 90000u;
        if (timeout_str && timeout_str[0] != L'\0') {
            unsigned long parsed = wcstoul(timeout_str, NULL, 10);
            if (parsed > 0) timeout_ms = (DWORD)parsed;
        }
        int rc = run_watch_dir_mode(watch_dir, dll_x86, dll_x64, timeout_ms);
        ExitProcess((UINT)rc);
    }

    /* Mode 1: Direct Suspended-APC Launch + Job Object Supervision */
    if (!target_cmdline_tail || target_cmdline_tail[0] == L'\0') {
        ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);
    }

    const WCHAR *exe_cursor = target_cmdline_tail;
    WCHAR *target_exe_path = parse_next_arg_alloc(&exe_cursor);
    if (!target_exe_path || target_exe_path[0] == L'\0') {
        ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);
    }

    uint16_t target_machine = read_pe_machine_w(target_exe_path);
    if (target_machine == 0) target_machine = DS_SELF_MACHINE;

    /* Opposite bitness: chain transparently to matching sibling launcher with Job supervision */
    if (target_machine != DS_SELF_MACHINE) {
        WCHAR sib_exe[MAX_PATH];
        if (!resolve_sibling_launcher_exe(target_machine, sib_exe, MAX_PATH)) {
            ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);
        }

        size_t sib_cmd_chars = wcslen(sib_exe) + wcslen(full_args_tail) + 8;
        WCHAR *sib_cmd = (WCHAR *)HeapAlloc(heap, HEAP_ZERO_MEMORY, sib_cmd_chars * sizeof(WCHAR));
        if (!sib_cmd) ExitProcess(DS_LAUNCH_ERR_CREATE_PROCESS);
        _snwprintf(sib_cmd, sib_cmd_chars - 1, L"\"%ls\" %ls", sib_exe, full_args_tail);

        STARTUPINFOW s_si;
        PROCESS_INFORMATION s_pi;
        memset(&s_si, 0, sizeof(s_si));
        memset(&s_pi, 0, sizeof(s_pi));
        s_si.cb = sizeof(s_si);

        BOOL chained = CreateProcessW(
            sib_exe, sib_cmd, NULL, NULL, FALSE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, NULL, NULL, &s_si, &s_pi
        );
        HeapFree(heap, 0, sib_cmd);
        if (!chained) {
            DWORD err = GetLastError();
            ExitProcess(err != 0 ? (UINT)err : DS_LAUNCH_ERR_CREATE_PROCESS);
        }

        HANDLE sib_job = CreateJobObjectW(NULL, NULL);
        if (sib_job) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli_s;
            memset(&jeli_s, 0, sizeof(jeli_s));
            jeli_s.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            if (!SetInformationJobObject(sib_job, JobObjectExtendedLimitInformation, &jeli_s, sizeof(jeli_s)) ||
                !AssignProcessToJobObject(sib_job, s_pi.hProcess)) {
                CloseHandle(sib_job);
                sib_job = NULL;
            }
        }
        if (ResumeThread(s_pi.hThread) == (DWORD)-1) {
            TerminateProcess(s_pi.hProcess, DS_LAUNCH_ERR_RESUME_THREAD);
            CloseHandle(s_pi.hThread);
            CloseHandle(s_pi.hProcess);
            if (sib_job) CloseHandle(sib_job);
            ExitProcess(DS_LAUNCH_ERR_RESUME_THREAD);
        }

        WaitForSingleObject(s_pi.hProcess, INFINITE);
        DWORD sib_exit = 0;
        if (!GetExitCodeProcess(s_pi.hProcess, &sib_exit)) sib_exit = 1;
        CloseHandle(s_pi.hThread);
        CloseHandle(s_pi.hProcess);
        if (sib_job) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli_clear;
            memset(&jeli_clear, 0, sizeof(jeli_clear));
            jeli_clear.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(sib_job, JobObjectExtendedLimitInformation, &jeli_clear, sizeof(jeli_clear));
            CloseHandle(sib_job);
        }
        ExitProcess((UINT)sib_exit);
    }

    const WCHAR *primary_dll = (DS_SELF_MACHINE == 0x014cu) ? dll_x86 : dll_x64;
    if (!primary_dll || !primary_dll[0]) primary_dll = dll_single;
    if (!primary_dll || !primary_dll[0]) {
        ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);
    }

    WCHAR *mutable_cmdline = dup_wstr_heap(target_cmdline_tail);
    if (!mutable_cmdline) ExitProcess(DS_LAUNCH_ERR_INVALID_ARGS);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);

    BOOL created = CreateProcessW(
        target_exe_path,
        mutable_cmdline,
        NULL,
        NULL,
        FALSE,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        NULL,
        NULL,
        &si,
        &pi
    );
    HeapFree(heap, 0, target_exe_path);
    HeapFree(heap, 0, mutable_cmdline);

    if (!created) {
        DWORD err = GetLastError();
        ExitProcess(err != 0 ? (UINT)err : DS_LAUNCH_ERR_CREATE_PROCESS);
    }

    HANDLE job = CreateJobObjectW(NULL, NULL);
    HANDLE job_iocp = NULL;
    bool job_iocp_associated = false;
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
        memset(&jeli, 0, sizeof(jeli));
        jeli.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
            CloseHandle(job);
            job = NULL;
        } else {
            job_iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
            if (job_iocp) {
                JOBOBJECT_ASSOCIATE_COMPLETION_PORT jacp;
                memset(&jacp, 0, sizeof(jacp));
                jacp.CompletionKey = (PVOID)job;
                jacp.CompletionPort = job_iocp;
                if (SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &jacp, sizeof(jacp))) {
                    job_iocp_associated = true;
                } else {
                    CloseHandle(job_iocp);
                    job_iocp = NULL;
                }
            }
            if (!AssignProcessToJobObject(job, pi.hProcess)) {
                if (job_iocp) {
                    CloseHandle(job_iocp);
                    job_iocp = NULL;
                }
                job_iocp_associated = false;
                CloseHandle(job);
                job = NULL;
            }
        }
    }

    HMODULE hK32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC pLLW = hK32 ? GetProcAddress(hK32, "LoadLibraryW") : NULL;

    WCHAR **extras = (DS_SELF_MACHINE == 0x014cu) ? extra_x86 : extra_x64;
    size_t extra_cnt = (DS_SELF_MACHINE == 0x014cu) ? extra_x86_count : extra_x64_count;
    bool all_queued = (pLLW != NULL);
    for (size_t i = 0; i < extra_cnt && all_queued; i++) {
        if (extras[i] && extras[i][0]) {
            all_queued = queue_apc_dll_load(pi.hProcess, pi.hThread, pLLW, extras[i]);
        }
    }
    if (all_queued) {
        all_queued = queue_apc_dll_load(pi.hProcess, pi.hThread, pLLW, primary_dll);
    }

    if (!all_queued) {
        TerminateProcess(pi.hProcess, DS_LAUNCH_ERR_APC_INJECT);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (job_iocp) CloseHandle(job_iocp);
        if (job) CloseHandle(job);
        ExitProcess(DS_LAUNCH_ERR_APC_INJECT);
    }

    if (ResumeThread(pi.hThread) == (DWORD)-1) {
        TerminateProcess(pi.hProcess, DS_LAUNCH_ERR_RESUME_THREAD);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (job_iocp) CloseHandle(job_iocp);
        if (job) CloseHandle(job);
        ExitProcess(DS_LAUNCH_ERR_RESUME_THREAD);
    }

    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD child_exit = 0;
    if (!GetExitCodeProcess(pi.hProcess, &child_exit)) child_exit = 1;

    DWORD root_pid = pi.dwProcessId;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    if (job) {
        HANDLE descendant_proc = NULL;
        if (job_has_live_descendants(job, root_pid, &descendant_proc)) {
            while (job_has_live_descendants(job, root_pid, &descendant_proc)) {
                if (job_iocp_associated && job_iocp) {
                    DWORD msg_id = 0;
                    ULONG_PTR comp_key = 0;
                    LPOVERLAPPED overlapped = NULL;
                    BOOL gq_ok = GetQueuedCompletionStatus(job_iocp, &msg_id, &comp_key, &overlapped, 200);
                    if (gq_ok) {
                        if (comp_key == (ULONG_PTR)job &&
                            msg_id == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO &&
                            !job_has_live_descendants(job, root_pid, &descendant_proc)) {
                            break;
                        }
                    } else if (GetLastError() != WAIT_TIMEOUT) {
                        job_iocp_associated = false;
                    }
                } else {
                    Sleep(200);
                }
            }
            if (child_exit == 0 && descendant_proc != NULL) {
                DWORD desc_exit = 0;
                if (GetExitCodeProcess(descendant_proc, &desc_exit) && desc_exit != STILL_ACTIVE) {
                    child_exit = desc_exit;
                }
            }
        }
        if (descendant_proc) CloseHandle(descendant_proc);
        /* Disarm KILL_ON_JOB_CLOSE on normal exit so shared Wine system daemons stay healthy */
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli_clear;
        memset(&jeli_clear, 0, sizeof(jeli_clear));
        jeli_clear.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli_clear, sizeof(jeli_clear));
        if (job_iocp) CloseHandle(job_iocp);
        CloseHandle(job);
    }

    ExitProcess((UINT)child_exit);
    return (int)child_exit;
}
