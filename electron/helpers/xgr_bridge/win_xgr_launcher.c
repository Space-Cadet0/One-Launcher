/*
 * One Launcher Clean-Room Win32/Win64 Suspended-APC GDK Runtime Preloader
 * (`one_xgr_win_launcher.exe` / `one_xgr_win_launcher_x86.exe`)
 *
 * Launches a clientless Windows Xbox GDK game executable in `CREATE_SUSPENDED` mode,
 * queues an early user-mode APC (`kernel32!LoadLibraryW`) on the primary thread to
 * map One Launcher's architecture-matched `Xgameruntime.dll`
 * (`one_xgameruntime_bridge.dll` on x64 or `one_xgameruntime_bridge_x86.dll` on x86)
 * into `PEB->Ldr.InLoadOrderModuleList` BEFORE `LdrInitializeThunk` runs static
 * constructors or `WinMain`, then resumes the process and supervises the entire
 * Job Object process tree until all descendant processes exit.
 *
 * Why this is required on clientless Windows (`GamingServices` absent):
 * Retail `XGameRuntime.Thunks.dll` / `XGamingRuntimeThunks.dll` load `Xgameruntime.dll`
 * via `LoadLibraryExW(L"Xgameruntime.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32)` (`0x800`),
 * which deliberately ignores the game's application directory (`<exeDir>\Xgameruntime.dll`).
 * However, the Windows loader (`LdrLoadDll`) checks `InLoadOrderModuleList` by base DLL
 * name BEFORE searching `C:\Windows\System32`, so pre-mapping `<stageDir>\Xgameruntime.dll`
 * via APC satisfies `LOAD_LIBRARY_SEARCH_SYSTEM32` with zero writes to `System32` and
 * zero UAC elevation.
 *
 * Usage:
 *   one_xgr_win_launcher.exe --dll <pathToXgameruntimeDll> -- <targetExe> [targetArgs...]
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>

#ifndef JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
#define JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO 4
#endif

#ifndef PROCESS_QUERY_LIMITED_INFORMATION
#define PROCESS_QUERY_LIMITED_INFORMATION 0x1000
#endif

/* Embedded PE binary marker verified by `scripts/build-xbox-bridge.cjs` */
#if defined(__GNUC__) || defined(__clang__)
__attribute__((used))
#endif
const char g_onelauncher_win_launcher_marker[] = "OneLauncher.XGRWinLauncher.v1";

enum {
    XGR_LAUNCH_ERR_INVALID_ARGS   = 9001,
    XGR_LAUNCH_ERR_CREATE_PROCESS = 9002,
    XGR_LAUNCH_ERR_APC_INJECT     = 9003,
    XGR_LAUNCH_ERR_RESUME_THREAD  = 9004
};

static const WCHAR *skip_ws(const WCHAR *p) {
    while (p && (*p == L' ' || *p == L'\t')) {
        p++;
    }
    return p;
}

/* Skip argv[0] according to Win32 GetCommandLineW() rules */
static const WCHAR *skip_program_name(const WCHAR *cmd) {
    if (!cmd) return L"";
    cmd = skip_ws(cmd);
    if (*cmd == L'"') {
        cmd++;
        while (*cmd && *cmd != L'"') {
            cmd++;
        }
        if (*cmd == L'"') {
            cmd++;
        }
        return cmd;
    }
    while (*cmd && *cmd != L' ' && *cmd != L'\t') {
        cmd++;
    }
    return cmd;
}

/*
 * Parse a single Win32 command-line argument (handling quotes and backslash-escaped
 * quotes per CommandLineToArgvW rules), returning a newly HeapAlloc'd wide string
 * and advancing `* cursor` past the token.
 */
static WCHAR *parse_next_arg_alloc(const WCHAR **cursor) {
    const WCHAR *p = skip_ws(*cursor);
    if (!p || *p == L'\0') {
        *cursor = p;
        return NULL;
    }

    size_t max_chars = wcslen(p) + 1;
    WCHAR *out = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, max_chars * sizeof(WCHAR));
    if (!out) {
        return NULL;
    }

    size_t dst = 0;
    bool in_quotes = false;

    while (*p != L'\0') {
        if (!in_quotes && (*p == L' ' || *p == L'\t')) {
            break;
        }

        size_t backslashes = 0;
        while (*p == L'\\') {
            backslashes++;
            p++;
        }

        if (*p == L'"') {
            size_t pairs = backslashes / 2;
            for (size_t i = 0; i < pairs; i++) {
                out[dst++] = L'\\';
            }
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

        for (size_t i = 0; i < backslashes; i++) {
            out[dst++] = L'\\';
        }

        if (*p == L'\0' || (!in_quotes && (*p == L' ' || *p == L'\t'))) {
            break;
        }

        out[dst++] = *p++;
    }

    out[dst] = L'\0';
    *cursor = p;
    return out;
}

static WCHAR *dup_wstr_heap(const WCHAR *src) {
    if (!src) return NULL;
    size_t bytes = (wcslen(src) + 1) * sizeof(WCHAR);
    WCHAR *copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, bytes);
    if (copy) {
        memcpy(copy, src, bytes);
    }
    return copy;
}

/*
 * Queries whether the Job Object still contains any live descendant processes
 * after the root process (`exited_root_pid`) has exited. Uses dynamically grown
 * `JobObjectBasicProcessIdList` buffers (handling `ERROR_MORE_DATA`) and caches
 * a handle to a live descendant process so its exit code can be propagated cleanly.
 */
static bool job_has_live_descendants(HANDLE job, DWORD exited_root_pid, HANDLE *inout_descendant) {
    if (!job) return false;

    if (inout_descendant && *inout_descendant != NULL) {
        if (WaitForSingleObject(*inout_descendant, 0) == WAIT_TIMEOUT) {
            return true;
        }
    }

    HANDLE heap = GetProcessHeap();
    size_t pid_cap = 64;
    for (int attempt = 0; attempt < 8; attempt++) {
        size_t buf_bytes = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + pid_cap * sizeof(ULONG_PTR);
        JOBOBJECT_BASIC_PROCESS_ID_LIST *list =
            (JOBOBJECT_BASIC_PROCESS_ID_LIST *)HeapAlloc(heap, HEAP_ZERO_MEMORY, buf_bytes);
        if (!list) {
            break;
        }

        DWORD ret_len = 0;
        BOOL ok = QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            list,
            (DWORD)buf_bytes,
            &ret_len);
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
        DWORD count = list->NumberOfProcessIdsInList;
        for (DWORD i = 0; i < count; i++) {
            DWORD pid = (DWORD)list->ProcessIdList[i];
            if (pid == 0 || pid == exited_root_pid) {
                continue;
            }
            HANDLE hp = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if (!hp) {
                if (GetLastError() == ERROR_ACCESS_DENIED) {
                    any_alive = true;
                }
                continue;
            }
            if (WaitForSingleObject(hp, 0) == WAIT_TIMEOUT) {
                any_alive = true;
                if (inout_descendant) {
                    if (*inout_descendant != NULL) {
                        CloseHandle(*inout_descendant);
                    }
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

    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
    memset(&acct, 0, sizeof(acct));
    if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &acct, sizeof(acct), NULL)) {
        return acct.ActiveProcesses > 0;
    }
    return false;
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nShowCmd) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nShowCmd;

    volatile const char *marker_ref = g_onelauncher_win_launcher_marker;
    if (!marker_ref || !marker_ref[0]) {
        ExitProcess(XGR_LAUNCH_ERR_INVALID_ARGS);
    }

    HANDLE heap = GetProcessHeap();
    const WCHAR *cursor = skip_program_name(GetCommandLineW());
    WCHAR *dll_path = NULL;
    const WCHAR *target_cmdline_tail = NULL;

    for (;;) {
        cursor = skip_ws(cursor);
        if (!cursor || *cursor == L'\0') {
            break;
        }

        const WCHAR *before_tok = cursor;
        WCHAR *tok = parse_next_arg_alloc(&cursor);
        if (!tok) {
            break;
        }

        if (wcscmp(tok, L"--") == 0) {
            HeapFree(heap, 0, tok);
            target_cmdline_tail = skip_ws(cursor);
            break;
        }

        if (wcscmp(tok, L"--dll") == 0) {
            HeapFree(heap, 0, tok);
            if (dll_path) {
                HeapFree(heap, 0, dll_path);
            }
            dll_path = parse_next_arg_alloc(&cursor);
            continue;
        }

        if (wcsncmp(tok, L"--dll=", 6) == 0) {
            if (dll_path) {
                HeapFree(heap, 0, dll_path);
            }
            dll_path = dup_wstr_heap(tok + 6);
            HeapFree(heap, 0, tok);
            continue;
        }

        /* Unknown flag or missing `--` separator */
        (void)before_tok;
        HeapFree(heap, 0, tok);
        if (dll_path) HeapFree(heap, 0, dll_path);
        ExitProcess(XGR_LAUNCH_ERR_INVALID_ARGS);
    }

    if (!dll_path || dll_path[0] == L'\0' || !target_cmdline_tail || target_cmdline_tail[0] == L'\0') {
        if (dll_path) HeapFree(heap, 0, dll_path);
        ExitProcess(XGR_LAUNCH_ERR_INVALID_ARGS);
    }

    const WCHAR *exe_cursor = target_cmdline_tail;
    WCHAR *target_exe_path = parse_next_arg_alloc(&exe_cursor);
    WCHAR *mutable_cmdline = dup_wstr_heap(target_cmdline_tail);
    if (!target_exe_path || target_exe_path[0] == L'\0' || !mutable_cmdline) {
        if (target_exe_path) HeapFree(heap, 0, target_exe_path);
        if (mutable_cmdline) HeapFree(heap, 0, mutable_cmdline);
        HeapFree(heap, 0, dll_path);
        ExitProcess(XGR_LAUNCH_ERR_INVALID_ARGS);
    }

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
        &pi);

    HeapFree(heap, 0, target_exe_path);
    HeapFree(heap, 0, mutable_cmdline);

    if (!created) {
        DWORD err = GetLastError();
        HeapFree(heap, 0, dll_path);
        ExitProcess(err != 0 ? (UINT)err : XGR_LAUNCH_ERR_CREATE_PROCESS);
    }

    /*
     * Job Object + IOCP process-tree supervision:
     * 1. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ensures terminating this launcher (e.g., user
     *    clicks Stop in One Launcher) cleanly terminates all child/descendant processes.
     * 2. Associating an I/O Completion Port BEFORE assigning `pi.hProcess` guarantees kernel
     *    delivery of `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` at 0% CPU when a detached bootstrapper
     *    exits `0` after spawning the actual game process!
     */
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
                if (SetInformationJobObject(
                        job,
                        JobObjectAssociateCompletionPortInformation,
                        &jacp,
                        sizeof(jacp))) {
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

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC p_load_library_w = k32 ? GetProcAddress(k32, "LoadLibraryW") : NULL;
    SIZE_T dll_bytes = (wcslen(dll_path) + 1) * sizeof(WCHAR);
    LPVOID remote_buf = p_load_library_w
        ? VirtualAllocEx(pi.hProcess, NULL, dll_bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
        : NULL;

    SIZE_T bytes_written = 0;
    bool injected = false;
    if (remote_buf &&
        WriteProcessMemory(pi.hProcess, remote_buf, dll_path, dll_bytes, &bytes_written) &&
        bytes_written == dll_bytes) {
        PAPCFUNC apc_fn = (PAPCFUNC)(ULONG_PTR)p_load_library_w;
        if (QueueUserAPC(apc_fn, pi.hThread, (ULONG_PTR)remote_buf) != 0) {
            injected = true;
        }
    }

    HeapFree(heap, 0, dll_path);

    if (!injected) {
        TerminateProcess(pi.hProcess, XGR_LAUNCH_ERR_APC_INJECT);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (job_iocp) CloseHandle(job_iocp);
        if (job) CloseHandle(job);
        ExitProcess(XGR_LAUNCH_ERR_APC_INJECT);
    }

    if (ResumeThread(pi.hThread) == (DWORD)-1) {
        TerminateProcess(pi.hProcess, XGR_LAUNCH_ERR_RESUME_THREAD);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (job_iocp) CloseHandle(job_iocp);
        if (job) CloseHandle(job);
        ExitProcess(XGR_LAUNCH_ERR_RESUME_THREAD);
    }

    (void)WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD child_exit = 0;
    if (!GetExitCodeProcess(pi.hProcess, &child_exit)) {
        child_exit = 1;
    }

    DWORD root_pid = pi.dwProcessId;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    /*
     * Do NOT immediately close `job` (which carries `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
     * if a bootstrapper exited after spawning a live descendant game process inside `job`.
     * Wait at 0% CPU via `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` on `job_iocp` (with safe
     * fallback to `JobObjectBasicProcessIdList` polling) until all descendants exit!
     */
    if (job) {
        HANDLE descendant_proc = NULL;
        if (job_has_live_descendants(job, root_pid, &descendant_proc)) {
            bool had_descendant = true;
            while (job_has_live_descendants(job, root_pid, &descendant_proc)) {
                if (job_iocp_associated && job_iocp) {
                    DWORD msg_id = 0;
                    ULONG_PTR comp_key = 0;
                    LPOVERLAPPED overlapped = NULL;
                    BOOL gq_ok = GetQueuedCompletionStatus(
                        job_iocp,
                        &msg_id,
                        &comp_key,
                        &overlapped,
                        1000);
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
                    Sleep(250);
                }
            }
            if (had_descendant && child_exit == 0) {
                if (descendant_proc != NULL) {
                    DWORD desc_exit = 0;
                    if (GetExitCodeProcess(descendant_proc, &desc_exit) && desc_exit != STILL_ACTIVE) {
                        child_exit = desc_exit;
                    }
                }
            }
        }
        if (descendant_proc != NULL) {
            CloseHandle(descendant_proc);
        }
        if (job_iocp) {
            CloseHandle(job_iocp);
        }
        CloseHandle(job);
    }

    ExitProcess((UINT)child_exit);
    return (int)child_exit;
}
