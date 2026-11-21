/*
 * One Launcher XGR Bridge — IXThreadingImpl (`XAsync` State Machine & `XTaskQueue`)
 * Exact Win64 ABI vtable matching `xasyncprovider.idl` (31 slots).
 */

#include "xgr_internal.h"

struct monitor_entry {
    XTaskQueueRegistrationToken token;
    void *context;
    XTaskQueueMonitorCallback *callback;
};

struct waiter_entry {
    struct waiter_entry *next;
    uint64_t token;
    HANDLE wait_object;
    XTaskQueueHandle queue;
    XTaskQueuePort port;
    void *context;
    XTaskQueueCallback *callback;
    volatile LONG closed;
    volatile LONG callback_tid;
};

struct queued_task {
    struct queued_task *next;
    XTaskQueueHandle queue;
    XTaskQueuePort port_type;
    XTaskQueuePortHandle port;
    XTaskQueueCallback *callback;
    void *context;
    ULONGLONG due_tick;
};

struct XTaskQueuePortObject {
    const void *lpVtbl;
    volatile LONG ref;
    volatile LONG owner_refs;
    XTaskQueueDispatchMode mode;
    XTaskQueuePort port_type;
    CRITICAL_SECTION cs;
    CONDITION_VARIABLE cv;
    struct queued_task *head;
    struct queued_task *tail;
    volatile LONG queued_count;
    volatile LONG terminating;
    HANDLE terminated_event;
    HANDLE worker_thread;
    volatile LONG worker_tid;
};

struct XTaskQueueObject {
    const void *lpVtbl;
    volatile LONG ref;
    XTaskQueuePortHandle work;
    XTaskQueuePortHandle completion;
    bool composite;
    volatile LONG terminated;
    CRITICAL_SECTION mon_cs;
    struct monitor_entry *monitors;
    uint32_t monitor_len;
    uint32_t monitor_cap;
    uint64_t next_token;
    struct waiter_entry *waiters;
    XTaskQueueTerminatedCallback *term_cb;
    void *term_ctx;
};

#define XGR_COMPLETED_RING_SIZE 512
#if UINTPTR_MAX > 0xFFFFFFFFu
#define XGR_ASYNC_MAGIC_LIVE    ((uintptr_t)0x4F4E45584153594EULL)
#define XGR_ASYNC_MAGIC_DONE    ((uintptr_t)0x4F4E4558444F4E45ULL)
#else
#define XGR_ASYNC_MAGIC_LIVE    ((uintptr_t)0x4F4E4153u)
#define XGR_ASYNC_MAGIC_DONE    ((uintptr_t)0x4F4E444Eu)
#endif

struct xgr_async_state {
    XAsyncProviderData data; /* MUST remain first member (offset 0) */
    XAsyncProvider *provider;
    const void *identity;
    XTaskQueueHandle effective_queue;
    HANDLE ready_event;
    CRITICAL_SECTION state_cs;
    volatile HRESULT status;
    volatile LONG ref_count;
    volatile LONG cleanup_ran;
    volatile LONG result_claimed;
    int32_t ring_slot;
    bool in_active_list;
    uint64_t cookie;
    struct xgr_async_state *active_prev;
    struct xgr_async_state *active_next;
};

struct xgr_async_block_wire {
    struct xgr_async_state *state;
    uintptr_t magic;
    uintptr_t cookie;
    HRESULT cached_hr;
#if UINTPTR_MAX > 0xFFFFFFFFu
    uint32_t reserved;
#endif
};

_Static_assert(offsetof(struct xgr_async_state, data) == 0, "XAsyncProviderData must remain at offset 0");
_Static_assert(sizeof(struct xgr_async_block_wire) <= sizeof(((XAsyncBlock *)0)->internal), "XAsyncBlock.internal size check");

static INIT_ONCE g_async_ring_once = INIT_ONCE_STATIC_INIT;
static volatile LONG g_async_ring_ready = 0;
static CRITICAL_SECTION g_async_ring_cs;
_Alignas(8) static volatile LONGLONG g_next_async_cookie = 1;
static struct xgr_async_state *g_active_head = NULL;
static struct xgr_async_state *g_completed_ring[XGR_COMPLETED_RING_SIZE];

static INIT_ONCE g_tls_once = INIT_ONCE_STATIC_INIT;
static DWORD g_time_sensitive_tls = TLS_OUT_OF_INDEXES;
static SRWLOCK g_proc_queue_lock = SRWLOCK_INIT;
static XTaskQueueHandle g_proc_queue = NULL;
static bool g_proc_queue_created = false;

static BOOL CALLBACK init_tls_once(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once; (void)param; (void)ctx;
    g_time_sensitive_tls = TlsAlloc();
    return TRUE;
}

static inline DWORD get_time_sensitive_tls(void)
{
    InitOnceExecuteOnce(&g_tls_once, init_tls_once, NULL, NULL);
    return g_time_sensitive_tls;
}

static void notify_monitors(XTaskQueueHandle queue, XTaskQueuePort port_type)
{
    if (!queue) return;
    EnterCriticalSection(&queue->mon_cs);
    uint32_t n = queue->monitor_len;
    struct monitor_entry stack_copy[16];
    struct monitor_entry *copy = (n <= 16) ? stack_copy : (struct monitor_entry *)malloc(n * sizeof(*copy));
    if (copy && n > 0) {
        memcpy(copy, queue->monitors, n * sizeof(*copy));
    }
    LeaveCriticalSection(&queue->mon_cs);

    if (copy) {
        for (uint32_t i = 0; i < n; i++) {
            if (copy[i].callback) copy[i].callback(copy[i].context, queue, port_type);
        }
        if (copy != stack_copy) free(copy);
    }
}

static void port_release(XTaskQueuePortHandle port);

static void port_addref(XTaskQueuePortHandle port)
{
    if (port) InterlockedIncrement(&port->ref);
}

static void port_owner_addref(XTaskQueuePortHandle port)
{
    if (port) {
        InterlockedIncrement(&port->ref);
        InterlockedIncrement(&port->owner_refs);
    }
}

static inline bool port_is_terminating(XTaskQueuePortHandle port)
{
    return InterlockedCompareExchange(&port->terminating, 0, 0) != 0;
}

static void port_complete_one_task(XTaskQueuePortHandle port)
{
    EnterCriticalSection(&port->cs);
    LONG rem = InterlockedDecrement(&port->queued_count);
    if (rem == 0 && InterlockedCompareExchange(&port->terminating, 0, 0) != 0 && port->terminated_event) {
        SetEvent(port->terminated_event);
        WakeAllConditionVariable(&port->cv);
    }
    LeaveCriticalSection(&port->cs);
}

static DWORD WINAPI serialized_port_worker(LPVOID arg)
{
    XTaskQueuePortHandle port = (XTaskQueuePortHandle)arg;
    InterlockedExchange(&port->worker_tid, (LONG)GetCurrentThreadId());
    for (;;) {
        struct queued_task *ready = NULL;
        bool is_canceled = false;

        EnterCriticalSection(&port->cs);
        while (!port_is_terminating(port)) {
            ULONGLONG now = GetTickCount64();
            struct queued_task *prev = NULL, *cur = port->head;
            DWORD min_wait = INFINITE;

            while (cur) {
                if (cur->due_tick <= now) {
                    ready = cur;
                    if (prev) prev->next = cur->next;
                    else port->head = cur->next;
                    if (port->tail == cur) port->tail = prev;
                    break;
                } else {
                    ULONGLONG diff = cur->due_tick - now;
                    DWORD wait_ms = (diff > 0x7fffffffULL) ? 0x7fffffffU : (DWORD)diff;
                    if (wait_ms < min_wait) min_wait = wait_ms;
                }
                prev = cur;
                cur = cur->next;
            }

            if (ready) break;
            SleepConditionVariableCS(&port->cv, &port->cs, min_wait);
        }

        if (!ready && port_is_terminating(port)) {
            if (port->head) {
                ready = port->head;
                port->head = ready->next;
                if (!port->head) port->tail = NULL;
                is_canceled = true;
            } else {
                if (InterlockedCompareExchange(&port->queued_count, 0, 0) == 0 && port->terminated_event) {
                    SetEvent(port->terminated_event);
                }
                LeaveCriticalSection(&port->cs);
                break;
            }
        }
        LeaveCriticalSection(&port->cs);

        if (ready) {
            if (ready->callback) ready->callback(ready->context, is_canceled);
            port_complete_one_task(port);
            port_release(port);
            free(ready);
        }
    }
    /* Release dedicated worker-lifetime reference strictly after exiting the loop */
    port_release(port);
    return 0;
}

static VOID CALLBACK tp_work_item_cb(PTP_CALLBACK_INSTANCE inst, PVOID ctx, PTP_WORK work)
{
    (void)inst;
    struct queued_task *task = (struct queued_task *)ctx;
    XTaskQueuePortHandle port = task->port;
    ULONGLONG now = GetTickCount64();
    if (task->due_tick > now && !port_is_terminating(port)) {
        EnterCriticalSection(&port->cs);
        while (!port_is_terminating(port)) {
            now = GetTickCount64();
            if (now >= task->due_tick) break;
            ULONGLONG diff = task->due_tick - now;
            DWORD wait_ms = (diff > 0x7fffffffULL) ? 0x7fffffffU : (DWORD)diff;
            SleepConditionVariableCS(&port->cv, &port->cs, wait_ms);
        }
        LeaveCriticalSection(&port->cs);
    }
    bool canceled = port_is_terminating(port);
    if (task->callback) task->callback(task->context, canceled);
    port_complete_one_task(port);
    port_release(port);
    free(task);
    CloseThreadpoolWork(work);
}

static HRESULT create_port_obj(XTaskQueueDispatchMode mode, XTaskQueuePort port_type, XTaskQueuePortHandle *out)
{
    XTaskQueuePortHandle p = (XTaskQueuePortHandle)calloc(1, sizeof(*p));
    if (!p) return E_OUTOFMEMORY;
    p->ref = 1;
    p->owner_refs = 1;
    p->mode = mode;
    p->port_type = port_type;
    InitializeCriticalSection(&p->cs);
    InitializeConditionVariable(&p->cv);
    p->terminated_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!p->terminated_event) {
        DeleteCriticalSection(&p->cs);
        free(p);
        return E_OUTOFMEMORY;
    }
    if (mode == XTaskQueueDispatchMode_SerializedThreadPool || mode == XTaskQueueDispatchMode_Immediate) {
        /* Hold a dedicated worker-lifetime reference until serialized_port_worker exits its loop */
        p->ref = 2;
        DWORD tid = 0;
        p->worker_thread = CreateThread(NULL, 0, serialized_port_worker, p, 0, &tid);
        if (p->worker_thread) {
            if (tid != 0) {
                InterlockedCompareExchange(&p->worker_tid, (LONG)tid, 0);
            }
        } else {
            CloseHandle(p->terminated_event);
            DeleteCriticalSection(&p->cs);
            free(p);
            return E_OUTOFMEMORY;
        }
    }
    *out = p;
    return S_OK;
}

static void port_release(XTaskQueuePortHandle port)
{
    if (!port) return;
    if (InterlockedDecrement(&port->ref) == 0) {
        if (port->worker_thread) {
            DWORD cur_tid = GetCurrentThreadId();
            DWORD w_tid = (DWORD)InterlockedCompareExchange(&port->worker_tid, 0, 0);
            if (w_tid != 0 && cur_tid == w_tid) {
                /* Self-release at worker tail: detach handle without self-joining */
                CloseHandle(port->worker_thread);
                port->worker_thread = NULL;
            } else {
                DWORD wr = WaitForSingleObject(port->worker_thread, 2000);
                if (wr != WAIT_OBJECT_0) {
                    /* Worker still running in OS teardown: never free(port) after a timed-out join */
                    return;
                }
                CloseHandle(port->worker_thread);
                port->worker_thread = NULL;
            }
        }
        if (port->terminated_event) CloseHandle(port->terminated_event);
        DeleteCriticalSection(&port->cs);
        free(port);
    }
}

static void port_owner_release(XTaskQueuePortHandle port)
{
    if (!port) return;
    if (InterlockedDecrement(&port->owner_refs) == 0) {
        struct queued_task *manual_drain = NULL;
        EnterCriticalSection(&port->cs);
        InterlockedExchange(&port->terminating, 1);
        if (port->mode == XTaskQueueDispatchMode_Manual && port->head) {
            /* Drain all un-dispatched tasks on Manual port so neither tasks nor port leak! */
            manual_drain = port->head;
            port->head = NULL;
            port->tail = NULL;
        }
        if (InterlockedCompareExchange(&port->queued_count, 0, 0) == 0 && port->terminated_event) {
            SetEvent(port->terminated_event);
        }
        WakeAllConditionVariable(&port->cv);
        LeaveCriticalSection(&port->cs);

        while (manual_drain) {
            struct queued_task *next = manual_drain->next;
            if (manual_drain->callback) {
                manual_drain->callback(manual_drain->context, true);
            }
            port_complete_one_task(port);
            port_release(port);
            free(manual_drain);
            manual_drain = next;
        }

        if (port->worker_thread) {
            DWORD cur_tid = GetCurrentThreadId();
            DWORD w_tid = (DWORD)InterlockedCompareExchange(&port->worker_tid, 0, 0);
            if (w_tid == 0 || cur_tid != w_tid) {
                /* External caller: wait boundedly while holding owner's port->ref */
                (void)WaitForSingleObject(port->worker_thread, 2000);
            }
        }
    }
    port_release(port);
}

void xgr_task_queue_close(XTaskQueueHandle queue)
{
    if (!queue) return;
    if (InterlockedDecrement(&queue->ref) == 0) {
        EnterCriticalSection(&queue->mon_cs);
        struct waiter_entry *w = queue->waiters;
        queue->waiters = NULL;
        LeaveCriticalSection(&queue->mon_cs);
        DWORD cur_tid = GetCurrentThreadId();
        while (w) {
            struct waiter_entry *next = w->next;
            InterlockedExchange(&w->closed, 1);
            if (w->wait_object) {
                DWORD cb_tid = (DWORD)InterlockedCompareExchange(&w->callback_tid, 0, 0);
                HANDLE completion_ev = (cb_tid == cur_tid) ? NULL : INVALID_HANDLE_VALUE;
                UnregisterWaitEx(w->wait_object, completion_ev);
            }
            free(w);
            w = next;
        }
        port_owner_release(queue->work);
        port_owner_release(queue->completion);
        DeleteCriticalSection(&queue->mon_cs);
        free(queue->monitors);
        free(queue);
    }
}

HRESULT xgr_task_queue_duplicate(XTaskQueueHandle queue, XTaskQueueHandle *out_dup)
{
    if (!queue || !out_dup) return E_INVALIDARG;
    InterlockedIncrement(&queue->ref);
    *out_dup = queue;
    return S_OK;
}

static HRESULT create_queue_internal(XTaskQueueDispatchMode workMode, XTaskQueueDispatchMode compMode, XTaskQueueHandle *out)
{
    if (!out) return E_POINTER;
    XTaskQueueHandle q = (XTaskQueueHandle)calloc(1, sizeof(*q));
    if (!q) return E_OUTOFMEMORY;
    q->ref = 1;
    q->next_token = 1;
    InitializeCriticalSection(&q->mon_cs);
    HRESULT hr = create_port_obj(workMode, XTaskQueuePort_Work, &q->work);
    if (FAILED(hr)) {
        xgr_task_queue_close(q);
        return hr;
    }
    hr = create_port_obj(compMode, XTaskQueuePort_Completion, &q->completion);
    if (FAILED(hr)) {
        xgr_task_queue_close(q);
        return hr;
    }
    *out = q;
    return S_OK;
}

bool xgr_task_queue_get_process(XTaskQueueHandle *out_queue)
{
    if (!out_queue) return false;
    AcquireSRWLockExclusive(&g_proc_queue_lock);
    if (!g_proc_queue && !g_proc_queue_created) {
        g_proc_queue_created = true;
        if (FAILED(create_queue_internal(XTaskQueueDispatchMode_ThreadPool, XTaskQueueDispatchMode_ThreadPool, &g_proc_queue))) {
            g_proc_queue = NULL;
        }
    }
    XTaskQueueHandle q = g_proc_queue;
    if (q) InterlockedIncrement(&q->ref);
    ReleaseSRWLockExclusive(&g_proc_queue_lock);
    *out_queue = q;
    return q != NULL;
}

HRESULT xgr_task_queue_submit_delayed(XTaskQueueHandle queue, XTaskQueuePort port_type, uint32_t delayMs, void *ctx, XTaskQueueCallback *cb)
{
    if (!cb) return E_INVALIDARG;
    bool temp_ref = false;
    if (!queue) {
        if (!xgr_task_queue_get_process(&queue)) return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
        temp_ref = true;
    }
    if (queue->terminated) {
        if (temp_ref) xgr_task_queue_close(queue);
        return E_ABORT;
    }

    XTaskQueuePortHandle port = (port_type == XTaskQueuePort_Work) ? queue->work :
                                (port_type == XTaskQueuePort_Completion) ? queue->completion : NULL;
    if (!port) {
        if (temp_ref) xgr_task_queue_close(queue);
        return E_INVALIDARG;
    }

    EnterCriticalSection(&port->cs);
    if (port_is_terminating(port)) {
        LeaveCriticalSection(&port->cs);
        if (temp_ref) xgr_task_queue_close(queue);
        return E_ABORT;
    }
    InterlockedIncrement(&port->queued_count);
    port_addref(port);
    LeaveCriticalSection(&port->cs);

    if (port->mode == XTaskQueueDispatchMode_Immediate && delayMs == 0) {
        notify_monitors(queue, port_type);
        cb(ctx, false);
        port_complete_one_task(port);
        port_release(port);
        if (temp_ref) xgr_task_queue_close(queue);
        return S_OK;
    }

    struct queued_task *task = (struct queued_task *)calloc(1, sizeof(*task));
    if (!task) {
        port_complete_one_task(port);
        port_release(port);
        if (temp_ref) xgr_task_queue_close(queue);
        return E_OUTOFMEMORY;
    }
    task->queue = queue;
    task->port_type = port_type;
    task->port = port;
    task->callback = cb;
    task->context = ctx;
    task->due_tick = GetTickCount64() + (ULONGLONG)delayMs;

    if (port->mode == XTaskQueueDispatchMode_ThreadPool) {
        notify_monitors(queue, port_type);
        PTP_WORK work = CreateThreadpoolWork(tp_work_item_cb, task, NULL);
        if (!work) {
            free(task);
            port_complete_one_task(port);
            port_release(port);
            if (temp_ref) xgr_task_queue_close(queue);
            return E_OUTOFMEMORY;
        }
        SubmitThreadpoolWork(work);
    } else {
        EnterCriticalSection(&port->cs);
        if (port->tail) port->tail->next = task;
        else port->head = task;
        port->tail = task;
        WakeConditionVariable(&port->cv);
        LeaveCriticalSection(&port->cs);
        notify_monitors(queue, port_type);
    }

    if (temp_ref) xgr_task_queue_close(queue);
    return S_OK;
}

/* -------------------------------------------------------------------------
 * XAsync State Machine (Ref-Counted + 512-Slot Bounded Completed Ring)
 * ------------------------------------------------------------------------- */

static BOOL CALLBACK init_async_ring_once(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    (void)once; (void)param; (void)ctx;
    InitializeCriticalSection(&g_async_ring_cs);
    memset(g_completed_ring, 0, sizeof(g_completed_ring));
    g_active_head = NULL;
    InterlockedExchange(&g_async_ring_ready, 1);
    return TRUE;
}

static inline void ensure_async_ring_init(void)
{
    InitOnceExecuteOnce(&g_async_ring_once, init_async_ring_once, NULL, NULL);
}

static void addref_async_state(struct xgr_async_state *st)
{
    if (st) InterlockedIncrement(&st->ref_count);
}

static void release_async_state(struct xgr_async_state *st)
{
    if (!st) return;
    if (InterlockedDecrement(&st->ref_count) == 0) {
        if (st->effective_queue) {
            xgr_task_queue_close(st->effective_queue);
            st->effective_queue = NULL;
        }
        if (st->ready_event) {
            CloseHandle(st->ready_event);
            st->ready_event = NULL;
        }
        DeleteCriticalSection(&st->state_cs);
        free(st);
    }
}

static void cleanup_async_state_once(struct xgr_async_state *st)
{
    if (!st) return;
    EnterCriticalSection(&st->state_cs);
    if (InterlockedExchange(&st->cleanup_ran, 1) == 0) {
        if (st->provider) {
            st->provider(XAsyncOp_Cleanup, &st->data);
        }
        st->data.context = NULL;
    }
    LeaveCriticalSection(&st->state_cs);
}

static void active_list_insert_locked(struct xgr_async_state *st)
{
    if (!st || st->in_active_list) return;
    st->active_prev = NULL;
    st->active_next = g_active_head;
    if (g_active_head) g_active_head->active_prev = st;
    g_active_head = st;
    st->in_active_list = true;
}

static bool active_list_remove_locked(struct xgr_async_state *st)
{
    if (!st || !st->in_active_list) return false;
    if (st->active_prev) st->active_prev->active_next = st->active_next;
    else g_active_head = st->active_next;
    if (st->active_next) st->active_next->active_prev = st->active_prev;
    st->active_prev = NULL;
    st->active_next = NULL;
    st->in_active_list = false;
    return true;
}

static inline void write_wire_live(XAsyncBlock *ab, struct xgr_async_state *st)
{
    struct xgr_async_block_wire w;
    memset(&w, 0, sizeof(w));
    if (st) {
        w.state = st;
        w.magic = XGR_ASYNC_MAGIC_LIVE;
        w.cookie = (uintptr_t)st->cookie;
        w.cached_hr = E_PENDING;
    }
    memset(ab->internal, 0, sizeof(ab->internal));
    memcpy(ab->internal, &w, sizeof(w));
}

static inline void write_wire_retired(XAsyncBlock *ab, HRESULT final_hr)
{
    struct xgr_async_block_wire w;
    memset(&w, 0, sizeof(w));
    w.state = NULL;
    w.magic = XGR_ASYNC_MAGIC_DONE;
    w.cookie = 0;
    w.cached_hr = final_hr;
    memset(ab->internal, 0, sizeof(ab->internal));
    memcpy(ab->internal, &w, sizeof(w));
}

/* Safely resolves XAsyncBlock -> ref-counted xgr_async_state without UAF */
static struct xgr_async_state *acquire_async_state(XAsyncBlock *ab, bool *out_is_retired, HRESULT *out_retired_hr)
{
    if (out_is_retired) *out_is_retired = false;
    if (out_retired_hr) *out_retired_hr = E_INVALIDARG;
    if (!ab) return NULL;

    ensure_async_ring_init();

    struct xgr_async_block_wire w;
    memcpy(&w, ab->internal, sizeof(w));

    if (w.magic == XGR_ASYNC_MAGIC_DONE) {
        if (out_is_retired) *out_is_retired = true;
        if (out_retired_hr) *out_retired_hr = w.cached_hr;
        return NULL;
    }
    if (w.magic != XGR_ASYNC_MAGIC_LIVE || !w.state || w.cookie == 0) {
        return NULL;
    }

    struct xgr_async_state *found = NULL;
    EnterCriticalSection(&g_async_ring_cs);

    uint32_t slot = (uint32_t)(w.cookie & (XGR_COMPLETED_RING_SIZE - 1));
    if (g_completed_ring[slot] == w.state && (uintptr_t)g_completed_ring[slot]->cookie == w.cookie) {
        found = g_completed_ring[slot];
    } else {
        for (struct xgr_async_state *cur = g_active_head; cur; cur = cur->active_next) {
            if (cur == w.state && (uintptr_t)cur->cookie == w.cookie) {
                found = cur;
                break;
            }
        }
    }

    if (found) {
        addref_async_state(found);
    }
    LeaveCriticalSection(&g_async_ring_cs);
    return found;
}

void *xgr_async_try_acquire_state(XAsyncBlock *async, void **out_context)
{
    if (out_context) *out_context = NULL;
    struct xgr_async_state *st = acquire_async_state(async, NULL, NULL);
    if (!st) return NULL;
    if (out_context) *out_context = st->data.context;
    return st;
}

void xgr_async_release_state(void *state_ref)
{
    release_async_state((struct xgr_async_state *)state_ref);
}

static void park_completed_state(struct xgr_async_state *st)
{
    struct xgr_async_state *evicted = NULL;
    bool drop_active = false;

    EnterCriticalSection(&g_async_ring_cs);
    drop_active = active_list_remove_locked(st);
    if (st->ring_slot < 0) {
        int32_t slot = (int32_t)(st->cookie & (XGR_COMPLETED_RING_SIZE - 1));
        evicted = g_completed_ring[slot];
        if (evicted) {
            evicted->ring_slot = -1;
        }
        addref_async_state(st);
        st->ring_slot = slot;
        g_completed_ring[slot] = st;
    }
    LeaveCriticalSection(&g_async_ring_cs);

    if (drop_active) {
        release_async_state(st);
    }
    if (evicted) {
        cleanup_async_state_once(evicted);
        release_async_state(evicted);
    }
}

static void retire_state_from_ring(struct xgr_async_state *st)
{
    bool drop_ring = false;
    bool drop_active = false;

    EnterCriticalSection(&g_async_ring_cs);
    if (st->ring_slot >= 0 && st->ring_slot < XGR_COMPLETED_RING_SIZE &&
        g_completed_ring[st->ring_slot] == st) {
        g_completed_ring[st->ring_slot] = NULL;
        st->ring_slot = -1;
        drop_ring = true;
    }
    drop_active = active_list_remove_locked(st);
    LeaveCriticalSection(&g_async_ring_cs);

    if (drop_ring) release_async_state(st);
    if (drop_active) release_async_state(st);
}

void xgr_threading_shutdown(void)
{
    /* Close process queue first so queued async callbacks finish/cancel before draining active states */
    AcquireSRWLockExclusive(&g_proc_queue_lock);
    XTaskQueueHandle pq = g_proc_queue;
    g_proc_queue = NULL;
    g_proc_queue_created = false;
    ReleaseSRWLockExclusive(&g_proc_queue_lock);
    if (pq) {
        xgr_task_queue_close(pq);
    }

    if (InterlockedCompareExchange(&g_async_ring_ready, 0, 0) != 0) {
        struct xgr_async_state *to_free[XGR_COMPLETED_RING_SIZE];
        size_t n = 0;
        struct xgr_async_state *active_drain = NULL;

        EnterCriticalSection(&g_async_ring_cs);
        for (int i = 0; i < XGR_COMPLETED_RING_SIZE; i++) {
            if (g_completed_ring[i]) {
                g_completed_ring[i]->ring_slot = -1;
                to_free[n++] = g_completed_ring[i];
                g_completed_ring[i] = NULL;
            }
        }
        while (g_active_head) {
            struct xgr_async_state *st = g_active_head;
            active_list_remove_locked(st);
            st->active_next = active_drain;
            active_drain = st;
        }
        LeaveCriticalSection(&g_async_ring_cs);

        for (size_t i = 0; i < n; i++) {
            cleanup_async_state_once(to_free[i]);
            release_async_state(to_free[i]);
        }
        while (active_drain) {
            struct xgr_async_state *next = active_drain->active_next;
            active_drain->active_next = NULL;
            active_drain->status = E_ABORT;
            if (active_drain->ready_event) SetEvent(active_drain->ready_event);
            cleanup_async_state_once(active_drain);
            release_async_state(active_drain);
            active_drain = next;
        }
    }
    /* Keep g_time_sensitive_tls process-scoped; never reset g_tls_once or TlsFree mid-process */
}

void xgr_threading_process_detach_cleanup(void)
{
    if (g_time_sensitive_tls != TLS_OUT_OF_INDEXES) {
        TlsFree(g_time_sensitive_tls);
        g_time_sensitive_tls = TLS_OUT_OF_INDEXES;
    }
}

static void CALLBACK async_work_runner(void *ctx, bool canceled)
{
    struct xgr_async_state *st = (struct xgr_async_state *)ctx;
    if (!st) return;
    if (canceled) {
        EnterCriticalSection(&st->state_cs);
        if (st->provider && InterlockedCompareExchange(&st->cleanup_ran, 0, 0) == 0) {
            st->provider(XAsyncOp_Cancel, &st->data);
        }
        st->status = E_ABORT;
        LeaveCriticalSection(&st->state_cs);
        park_completed_state(st);
        SetEvent(st->ready_event);
        cleanup_async_state_once(st);
    } else if (st->provider) {
        st->provider(XAsyncOp_DoWork, &st->data);
    }
    release_async_state(st);
}

static void CALLBACK async_completion_runner(void *ctx, bool canceled)
{
    struct xgr_async_state *st = (struct xgr_async_state *)ctx;
    if (!st) return;

    XAsyncBlock *ab = st->data.async;
    XAsyncCompletionRoutine *user_cb = (!canceled && ab) ? ab->callback : NULL;

    if (canceled) {
        EnterCriticalSection(&st->state_cs);
        if (st->provider && InterlockedCompareExchange(&st->cleanup_ran, 0, 0) == 0) {
            st->provider(XAsyncOp_Cancel, &st->data);
        }
        st->status = E_ABORT;
        LeaveCriticalSection(&st->state_cs);
    }

    park_completed_state(st);
    SetEvent(st->ready_event);

    if (user_cb) {
        /* Note: user_cb may call XAsyncGetResult(ab) and free(ab) before returning! */
        user_cb(ab);
    }
    if (canceled || FAILED(st->status)) {
        cleanup_async_state_once(st);
    }
    release_async_state(st);
}

HRESULT xgr_async_begin(XAsyncBlock *async, void *context, const void *identity, const char *identityName, XAsyncProvider *provider)
{
    (void)identityName;
    if (!async || !provider) return xgr_return_hr(E_INVALIDARG);

    ensure_async_ring_init();

    struct xgr_async_state *st = (struct xgr_async_state *)calloc(1, sizeof(*st));
    if (!st) return xgr_return_hr(E_OUTOFMEMORY);

    InitializeCriticalSection(&st->state_cs);
    st->status = E_PENDING;
    st->provider = provider;
    st->identity = identity;
    st->ref_count = 1; /* Owned by g_active_head until completion */
    st->cleanup_ran = 0;
    st->result_claimed = 0;
    st->ring_slot = -1;
    st->in_active_list = false;
    st->cookie = (uint64_t)InterlockedIncrement64(&g_next_async_cookie);
    if ((uintptr_t)st->cookie == 0) {
        st->cookie = (uint64_t)InterlockedIncrement64(&g_next_async_cookie);
    }
    st->data.async = async;
    st->data.context = context;
    st->ready_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!st->ready_event) {
        DeleteCriticalSection(&st->state_cs);
        free(st);
        return xgr_return_hr(E_OUTOFMEMORY);
    }

    if (async->queue) {
        if (FAILED(xgr_task_queue_duplicate(async->queue, &st->effective_queue))) {
            CloseHandle(st->ready_event);
            DeleteCriticalSection(&st->state_cs);
            free(st);
            return xgr_return_hr(E_INVALIDARG);
        }
    } else {
        if (!xgr_task_queue_get_process(&st->effective_queue)) {
            CloseHandle(st->ready_event);
            DeleteCriticalSection(&st->state_cs);
            free(st);
            return xgr_return_hr(E_INVALIDARG);
        }
    }

    EnterCriticalSection(&g_async_ring_cs);
    active_list_insert_locked(st);
    LeaveCriticalSection(&g_async_ring_cs);

    write_wire_live(async, st);

    addref_async_state(st); /* Guard st across Begin in case Begin completes synchronously */
    HRESULT hr = provider(XAsyncOp_Begin, &st->data);
    if (FAILED(hr)) {
        write_wire_live(async, NULL);
        retire_state_from_ring(st);
    }
    release_async_state(st);
    return xgr_return_hr(hr);
}

HRESULT xgr_async_schedule(XAsyncBlock *async, uint32_t delayMs)
{
    if (!async) return xgr_return_hr(E_INVALIDARG);
    struct xgr_async_state *st = acquire_async_state(async, NULL, NULL);
    if (!st) return xgr_return_hr(E_INVALIDARG);

    addref_async_state(st); /* Owned by async_work_runner */
    HRESULT hr = xgr_task_queue_submit_delayed(st->effective_queue, XTaskQueuePort_Work, delayMs, st, async_work_runner);
    if (FAILED(hr)) {
        release_async_state(st);
    }
    release_async_state(st);
    return xgr_return_hr(hr);
}

static VOID CALLBACK async_bg_tp_cb(PTP_CALLBACK_INSTANCE inst, PVOID ctx)
{
    (void)inst;
    async_work_runner(ctx, false);
}

static DWORD WINAPI async_bg_workitem_cb(LPVOID ctx)
{
    async_work_runner(ctx, false);
    return 0;
}

HRESULT xgr_async_schedule_background(XAsyncBlock *async)
{
    if (!async) return xgr_return_hr(E_INVALIDARG);
    struct xgr_async_state *st = acquire_async_state(async, NULL, NULL);
    if (!st) return xgr_return_hr(E_INVALIDARG);

    addref_async_state(st); /* Owned by async_work_runner */
    BOOL queued = TrySubmitThreadpoolCallback(async_bg_tp_cb, st, NULL);
    if (!queued) {
        queued = QueueUserWorkItem(async_bg_workitem_cb, st, WT_EXECUTEDEFAULT);
    }
    if (!queued) {
        release_async_state(st);
        release_async_state(st);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    release_async_state(st);
    return xgr_return_hr(S_OK);
}

void xgr_async_complete(XAsyncBlock *async, HRESULT result, size_t requiredBufferSize)
{
    struct xgr_async_state *st = acquire_async_state(async, NULL, NULL);
    if (!st) return;

    st->data.bufferSize = SUCCEEDED(result) ? requiredBufferSize : 0;
    st->status = result;

    if (async->callback) {
        addref_async_state(st); /* Owned by async_completion_runner */
        if (SUCCEEDED(xgr_task_queue_submit_delayed(st->effective_queue, XTaskQueuePort_Completion, 0, st, async_completion_runner))) {
            release_async_state(st);
            xgr_sync_teb_last_error();
            return;
        }
        release_async_state(st);
    }

    park_completed_state(st);
    SetEvent(st->ready_event);
    if (FAILED(result)) {
        cleanup_async_state_once(st);
    }
    release_async_state(st);
    xgr_sync_teb_last_error();
}

HRESULT xgr_async_get_status(XAsyncBlock *async, bool wait)
{
    bool is_retired = false;
    HRESULT retired_hr = E_INVALIDARG;
    struct xgr_async_state *st = acquire_async_state(async, &is_retired, &retired_hr);
    if (is_retired) {
        return xgr_return_hr(retired_hr);
    }
    if (!st || !st->ready_event) {
        if (st) release_async_state(st);
        return xgr_return_hr(E_INVALIDARG);
    }
    DWORD res = WaitForSingleObject(st->ready_event, wait ? INFINITE : 0);
    HRESULT hr = (res == WAIT_TIMEOUT) ? E_PENDING : st->status;
    release_async_state(st);
    return xgr_return_hr(hr);
}

HRESULT xgr_async_get_result_size(XAsyncBlock *async, size_t *bufferSize)
{
    if (!async || !bufferSize) return xgr_return_hr(E_INVALIDARG);
    bool is_retired = false;
    HRESULT retired_hr = E_INVALIDARG;
    struct xgr_async_state *st = acquire_async_state(async, &is_retired, &retired_hr);
    if (is_retired) {
        *bufferSize = 0;
        return xgr_return_hr(FAILED(retired_hr) ? retired_hr : E_INVALIDARG);
    }
    if (!st || !st->ready_event) {
        if (st) release_async_state(st);
        return xgr_return_hr(E_INVALIDARG);
    }
    if (WaitForSingleObject(st->ready_event, 0) == WAIT_TIMEOUT) {
        release_async_state(st);
        return xgr_return_hr(E_PENDING);
    }
    HRESULT status = st->status;
    if (FAILED(status)) {
        *bufferSize = 0;
        release_async_state(st);
        return xgr_return_hr(status);
    }
    *bufferSize = st->data.bufferSize;
    release_async_state(st);
    return xgr_return_hr(S_OK);
}

HRESULT xgr_async_get_result(XAsyncBlock *async, const void *identity, size_t bufferSize, void *buffer, size_t *bufferUsed)
{
    if (!async) return xgr_return_hr(E_INVALIDARG);

    bool is_retired = false;
    HRESULT retired_hr = E_INVALIDARG;
    struct xgr_async_state *st = acquire_async_state(async, &is_retired, &retired_hr);
    if (is_retired) {
        if (bufferUsed) *bufferUsed = 0;
        if (FAILED(retired_hr)) return xgr_return_hr(retired_hr);
        return xgr_return_hr((bufferSize == 0 && buffer == NULL) ? retired_hr : E_INVALIDARG);
    }
    if (!st || !st->ready_event) {
        if (st) release_async_state(st);
        return xgr_return_hr(E_INVALIDARG);
    }
    if (st->identity && identity && st->identity != identity) {
        release_async_state(st);
        return xgr_return_hr(E_INVALIDARG);
    }
    if (WaitForSingleObject(st->ready_event, 0) == WAIT_TIMEOUT) {
        release_async_state(st);
        return xgr_return_hr(E_PENDING);
    }

    if (InterlockedCompareExchange(&st->result_claimed, 1, 0) != 0) {
        if (bufferUsed) *bufferUsed = 0;
        release_async_state(st);
        return xgr_return_hr(E_INVALIDARG);
    }

    HRESULT status = st->status;
    if (FAILED(status)) {
        if (bufferUsed) *bufferUsed = 0;
        write_wire_retired(async, status);
        retire_state_from_ring(st);
        cleanup_async_state_once(st);
        release_async_state(st);
        return xgr_return_hr(status);
    }

    size_t req_size = st->data.bufferSize;
    if (bufferSize < req_size) {
        InterlockedExchange(&st->result_claimed, 0);
        release_async_state(st);
        return xgr_return_hr(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER));
    }

    /* Pass a thread-local XAsyncProviderData with caller's actual buffer/bufferSize under state_cs */
    EnterCriticalSection(&st->state_cs);
    XAsyncProviderData call_data = st->data;
    call_data.buffer = buffer;
    call_data.bufferSize = bufferSize;
    HRESULT hr = (req_size > 0 && st->provider && InterlockedCompareExchange(&st->cleanup_ran, 0, 0) == 0)
        ? st->provider(XAsyncOp_GetResult, &call_data)
        : S_OK;
    LeaveCriticalSection(&st->state_cs);

    if (hr == HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER) || hr == E_GS_PROVIDED_BUFFER_TOO_SMALL) {
        if (bufferUsed) *bufferUsed = 0;
        InterlockedExchange(&st->result_claimed, 0);
        release_async_state(st);
        return xgr_return_hr(hr);
    }

    if (bufferUsed) *bufferUsed = SUCCEEDED(hr) ? req_size : 0;

    write_wire_retired(async, hr);
    retire_state_from_ring(st);
    cleanup_async_state_once(st);
    release_async_state(st);
    return xgr_return_hr(hr);
}

static HRESULT CALLBACK generic_run_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    if (op == XAsyncOp_Begin) {
        return xgr_async_schedule(data->async, 0);
    }
    if (op == XAsyncOp_DoWork) {
        XAsyncWork *work = (XAsyncWork *)data->context;
        HRESULT hr = work ? work(data->async) : E_INVALIDARG;
        xgr_async_complete(data->async, hr, 0);
    }
    return S_OK;
}

/* -------------------------------------------------------------------------
 * IXThreadingImpl Vtable Methods (Exact 31-Slot Layout)
 * ------------------------------------------------------------------------- */

typedef struct IXThreadingImplVtbl IXThreadingImplVtbl;

typedef struct IXThreadingImplObj {
    const IXThreadingImplVtbl *lpVtbl;
} IXThreadingImplObj;

static HRESULT WINAPI th_QueryInterface(void *iface, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (!riid) {
        *ppv = NULL;
        return E_INVALIDARG;
    }
    if (IsEqualGUID(riid, &IID_IUnknown) || IsEqualGUID(riid, &IID_IXThreadingImpl)) {
        *ppv = iface;
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG WINAPI th_AddRef(void *iface) { (void)iface; return 2; }
static ULONG WINAPI th_Release(void *iface) { (void)iface; return 1; }

static HRESULT WINAPI th_XAsyncGetStatus(void *iface, XAsyncBlock *ab, BOOLEAN wait)
{
    (void)iface;
    return xgr_async_get_status(ab, wait != 0);
}

static HRESULT WINAPI th_XAsyncGetResultSize(void *iface, XAsyncBlock *ab, size_t *sz)
{
    (void)iface;
    return xgr_async_get_result_size(ab, sz);
}

static void WINAPI th_XAsyncCancel(void *iface, XAsyncBlock *ab)
{
    (void)iface;
    struct xgr_async_state *st = acquire_async_state(ab, NULL, NULL);
    if (st) {
        EnterCriticalSection(&st->state_cs);
        if (st->provider && InterlockedCompareExchange(&st->cleanup_ran, 0, 0) == 0) {
            st->provider(XAsyncOp_Cancel, &st->data);
        }
        LeaveCriticalSection(&st->state_cs);
        release_async_state(st);
    }
    xgr_sync_teb_last_error();
}

static HRESULT WINAPI th_XAsyncRun(void *iface, XAsyncBlock *ab, XAsyncWork *work)
{
    (void)iface;
    return xgr_async_begin(ab, (void *)work, NULL, "XAsyncRun", generic_run_provider);
}

static HRESULT WINAPI th_XAsyncBegin(void *iface, XAsyncBlock *ab, void *ctx, const void *id, const char *name, XAsyncProvider *prov)
{
    (void)iface;
    return xgr_async_begin(ab, ctx, id, name, prov);
}

/* Slot 8: XAsyncBeginAlloc — exact 6-arg __stdcall arity (cleans 24 bytes on x86) */
static HRESULT WINAPI th_XAsyncBeginAlloc(void *iface, XAsyncBlock *ab, const void *id, const char *name, XAsyncProvider *prov, size_t contextSize)
{
    (void)iface; (void)ab; (void)id; (void)name; (void)prov; (void)contextSize;
    return xgr_return_hr(E_NOTIMPL);
}

static HRESULT WINAPI th_XAsyncSchedule(void *iface, XAsyncBlock *ab, UINT32 delayMs)
{
    (void)iface;
    return xgr_async_schedule(ab, delayMs);
}

static void WINAPI th_XAsyncComplete(void *iface, XAsyncBlock *ab, HRESULT result, size_t reqSize)
{
    (void)iface;
    xgr_async_complete(ab, result, reqSize);
}

static HRESULT WINAPI th_XAsyncGetResult(void *iface, XAsyncBlock *ab, const void *id, size_t bufSize, void *buf, size_t *used)
{
    (void)iface;
    return xgr_async_get_result(ab, id, bufSize, buf, used);
}

static HRESULT WINAPI th_XTaskQueueCreate(void *iface, XTaskQueueDispatchMode wm, XTaskQueueDispatchMode cm, XTaskQueueHandle *q)
{
    (void)iface;
    return xgr_return_hr(create_queue_internal(wm, cm, q));
}

static inline XTaskQueueHandle resolve_queue(XTaskQueueHandle q, bool *out_temp_ref)
{
    if (out_temp_ref) *out_temp_ref = false;
    if (q) return q;
    XTaskQueueHandle proc_q = NULL;
    if (xgr_task_queue_get_process(&proc_q) && proc_q) {
        if (out_temp_ref) *out_temp_ref = true;
        return proc_q;
    }
    return NULL;
}

static HRESULT WINAPI th_XTaskQueueCreateComposite(void *iface, XTaskQueuePortHandle wp, XTaskQueuePortHandle cp, XTaskQueueHandle *out)
{
    (void)iface;
    if (!wp || !cp || !out) return xgr_return_hr(E_INVALIDARG);
    XTaskQueueHandle q = (XTaskQueueHandle)calloc(1, sizeof(*q));
    if (!q) return xgr_return_hr(E_OUTOFMEMORY);
    q->ref = 1;
    q->composite = true;
    q->next_token = 1;
    InitializeCriticalSection(&q->mon_cs);
    port_owner_addref(wp);
    port_owner_addref(cp);
    q->work = wp;
    q->completion = cp;
    *out = q;
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI th_XTaskQueueGetPort(void *iface, XTaskQueueHandle q, XTaskQueuePort port, XTaskQueuePortHandle *out)
{
    (void)iface;
    if (!out) return xgr_return_hr(E_INVALIDARG);
    *out = NULL;
    bool temp_ref = false;
    q = resolve_queue(q, &temp_ref);
    if (!q) return xgr_return_hr(HRESULT_FROM_WIN32(ERROR_NOT_FOUND));
    HRESULT hr = E_INVALIDARG;
    if (port == XTaskQueuePort_Work) {
        *out = q->work;
        hr = S_OK;
    } else if (port == XTaskQueuePort_Completion) {
        *out = q->completion;
        hr = S_OK;
    }
    if (temp_ref) xgr_task_queue_close(q);
    return xgr_return_hr(hr);
}

static HRESULT WINAPI th_XTaskQueueDuplicateHandle(void *iface, XTaskQueueHandle q, XTaskQueueHandle *dup)
{
    (void)iface;
    return xgr_return_hr(xgr_task_queue_duplicate(q, dup));
}

static BOOLEAN WINAPI th_XTaskQueueDispatch(void *iface, XTaskQueueHandle q, XTaskQueuePort port_type, UINT32 timeoutMs)
{
    (void)iface;
    bool temp_ref = false;
    if (!q) {
        if (!xgr_task_queue_get_process(&q)) return FALSE;
        temp_ref = true;
    }
    XTaskQueuePortHandle port = (port_type == XTaskQueuePort_Work) ? q->work :
                                (port_type == XTaskQueuePort_Completion) ? q->completion : NULL;
    if (!port || port->mode != XTaskQueueDispatchMode_Manual) {
        if (temp_ref) xgr_task_queue_close(q);
        return FALSE;
    }

    ULONGLONG start = GetTickCount64();
    BOOLEAN dispatched = FALSE;

    for (;;) {
        struct queued_task *ready = NULL;
        bool canceled = false;
        EnterCriticalSection(&port->cs);
        for (;;) {
            ULONGLONG now = GetTickCount64();
            bool term = port_is_terminating(port);
            struct queued_task *prev = NULL, *cur = port->head;
            DWORD min_wait = INFINITE;
            while (cur) {
                if (term || cur->due_tick <= now) {
                    ready = cur;
                    canceled = term;
                    if (prev) prev->next = cur->next;
                    else port->head = cur->next;
                    if (port->tail == cur) port->tail = prev;
                    break;
                } else {
                    ULONGLONG diff = cur->due_tick - now;
                    DWORD dw = (diff > 0x7fffffffULL) ? 0x7fffffffU : (DWORD)diff;
                    if (dw < min_wait) min_wait = dw;
                }
                prev = cur;
                cur = cur->next;
            }
            if (ready) break;

            if (port_type == XTaskQueuePort_Completion && q->term_cb &&
                WaitForSingleObject(q->work->terminated_event, 0) == WAIT_OBJECT_0 &&
                WaitForSingleObject(q->completion->terminated_event, 0) == WAIT_OBJECT_0) {
                break;
            }

            if (timeoutMs == 0) break;
            DWORD wait_ms = min_wait;
            if (timeoutMs != INFINITE) {
                ULONGLONG elapsed = now - start;
                if (elapsed >= (ULONGLONG)timeoutMs) break;
                DWORD rem = (DWORD)((ULONGLONG)timeoutMs - elapsed);
                if (rem < wait_ms) wait_ms = rem;
            }
            if (port_type == XTaskQueuePort_Completion && q->term_cb && wait_ms > 50U) {
                wait_ms = 50U;
            }
            SleepConditionVariableCS(&port->cv, &port->cs, wait_ms);
        }
        LeaveCriticalSection(&port->cs);

        if (ready) {
            if (ready->callback) ready->callback(ready->context, canceled);
            port_complete_one_task(port);
            port_release(port);
            free(ready);
            dispatched = TRUE;
            break;
        }

        if (port_type == XTaskQueuePort_Completion && q->term_cb &&
            WaitForSingleObject(q->work->terminated_event, 0) == WAIT_OBJECT_0 &&
            WaitForSingleObject(q->completion->terminated_event, 0) == WAIT_OBJECT_0) {
            XTaskQueueTerminatedCallback *tcb = (XTaskQueueTerminatedCallback *)InterlockedExchangePointer((PVOID *)&q->term_cb, NULL);
            if (tcb) {
                tcb(q->term_ctx);
                dispatched = TRUE;
                break;
            }
        }
        break;
    }

    if (temp_ref) xgr_task_queue_close(q);
    xgr_sync_teb_last_error();
    return dispatched;
}

static void WINAPI th_XTaskQueueCloseHandle(void *iface, XTaskQueueHandle q)
{
    (void)iface;
    xgr_task_queue_close(q);
    xgr_sync_teb_last_error();
}

static HRESULT WINAPI th_XTaskQueueSubmitCallback(void *iface, XTaskQueueHandle q, XTaskQueuePort port, void *ctx, XTaskQueueCallback *cb)
{
    (void)iface;
    return xgr_return_hr(xgr_task_queue_submit_delayed(q, port, 0, ctx, cb));
}

static HRESULT WINAPI th_XTaskQueueSubmitDelayedCallback(void *iface, XTaskQueueHandle q, XTaskQueuePort port, UINT32 delayMs, void *ctx, XTaskQueueCallback *cb)
{
    (void)iface;
    return xgr_return_hr(xgr_task_queue_submit_delayed(q, port, delayMs, ctx, cb));
}

static VOID CALLBACK win32_waiter_fired(PVOID param, BOOLEAN timerOrWaitFired)
{
    (void)timerOrWaitFired;
    struct waiter_entry *w = (struct waiter_entry *)param;
    if (!w || InterlockedCompareExchange(&w->closed, 0, 0) != 0) return;
    InterlockedExchange(&w->callback_tid, (LONG)GetCurrentThreadId());
    if (w->callback && InterlockedCompareExchange(&w->closed, 0, 0) == 0) {
        xgr_task_queue_submit_delayed(w->queue, w->port, 0, w->context, w->callback);
    }
    InterlockedExchange(&w->callback_tid, 0);
}

static HRESULT WINAPI th_XTaskQueueRegisterWaiter(void *iface, XTaskQueueHandle q, XTaskQueuePort port, HANDLE waitHandle, void *ctx, XTaskQueueCallback *cb, XTaskQueueRegistrationToken *token)
{
    (void)iface;
    if (!waitHandle || !cb || !token) return xgr_return_hr(E_INVALIDARG);
    bool release_extra = false;
    if (!q) {
        release_extra = xgr_task_queue_get_process(&q);
        if (!q) return xgr_return_hr(E_INVALIDARG);
    }

    struct waiter_entry *w = (struct waiter_entry *)calloc(1, sizeof(*w));
    if (!w) {
        if (release_extra) xgr_task_queue_close(q);
        return xgr_return_hr(E_OUTOFMEMORY);
    }
    w->queue = q;
    w->port = port;
    w->context = ctx;
    w->callback = cb;

    if (!RegisterWaitForSingleObject(&w->wait_object, waitHandle, win32_waiter_fired, w, INFINITE, WT_EXECUTEDEFAULT)) {
        DWORD err = GetLastError();
        free(w);
        if (release_extra) xgr_task_queue_close(q);
        return xgr_return_hr(HRESULT_FROM_WIN32(err));
    }

    EnterCriticalSection(&q->mon_cs);
    w->token = q->next_token++;
    token->token = w->token;
    w->next = q->waiters;
    q->waiters = w;
    LeaveCriticalSection(&q->mon_cs);
    if (release_extra) xgr_task_queue_close(q);
    return xgr_return_hr(S_OK);
}

static void WINAPI th_XTaskQueueUnregisterWaiter(void *iface, XTaskQueueHandle q, XTaskQueueRegistrationToken token)
{
    (void)iface;
    bool release_extra = false;
    if (!q) {
        release_extra = xgr_task_queue_get_process(&q);
        if (!q) {
            xgr_sync_teb_last_error();
            return;
        }
    }
    struct waiter_entry *found = NULL;
    EnterCriticalSection(&q->mon_cs);
    struct waiter_entry *prev = NULL, *cur = q->waiters;
    while (cur) {
        if (cur->token == token.token) {
            found = cur;
            if (prev) prev->next = cur->next;
            else q->waiters = cur->next;
            break;
        }
        prev = cur;
        cur = cur->next;
    }
    LeaveCriticalSection(&q->mon_cs);
    if (found) {
        InterlockedExchange(&found->closed, 1);
        if (found->wait_object) {
            DWORD cur_tid = GetCurrentThreadId();
            DWORD cb_tid = (DWORD)InterlockedCompareExchange(&found->callback_tid, 0, 0);
            HANDLE completion_ev = (cb_tid == cur_tid) ? NULL : INVALID_HANDLE_VALUE;
            UnregisterWaitEx(found->wait_object, completion_ev);
        }
        free(found);
    }
    if (release_extra) xgr_task_queue_close(q);
    xgr_sync_teb_last_error();
}

static HRESULT WINAPI th_XTaskQueueTerminate(void *iface, XTaskQueueHandle q, BOOLEAN wait, void *ctx, XTaskQueueTerminatedCallback *cb)
{
    (void)iface;
    if (!q) return xgr_return_hr(E_INVALIDARG);
    InterlockedExchange(&q->terminated, 1);
    q->term_ctx = ctx;
    q->term_cb = cb;

    if (!q->composite) {
        EnterCriticalSection(&q->work->cs);
        InterlockedExchange(&q->work->terminating, 1);
        if (InterlockedCompareExchange(&q->work->queued_count, 0, 0) == 0) SetEvent(q->work->terminated_event);
        WakeAllConditionVariable(&q->work->cv);
        LeaveCriticalSection(&q->work->cs);

        EnterCriticalSection(&q->completion->cs);
        InterlockedExchange(&q->completion->terminating, 1);
        if (InterlockedCompareExchange(&q->completion->queued_count, 0, 0) == 0) SetEvent(q->completion->terminated_event);
        WakeAllConditionVariable(&q->completion->cv);
        LeaveCriticalSection(&q->completion->cs);

        if (wait) {
            HANDLE evs[2] = { q->work->terminated_event, q->completion->terminated_event };
            WaitForMultipleObjects(2, evs, TRUE, 5000);
        }
    }

    if (cb && (!q->completion || q->completion->mode != XTaskQueueDispatchMode_Manual)) {
        XTaskQueueTerminatedCallback *tcb = (XTaskQueueTerminatedCallback *)InterlockedExchangePointer((PVOID *)&q->term_cb, NULL);
        if (tcb) tcb(ctx);
    }
    return xgr_return_hr(S_OK);
}

static HRESULT WINAPI th_XTaskQueueRegisterMonitor(void *iface, XTaskQueueHandle q, void *ctx, XTaskQueueMonitorCallback *cb, XTaskQueueRegistrationToken *token)
{
    (void)iface;
    if (!cb || !token) return xgr_return_hr(E_POINTER);
    bool release_extra = false;
    if (!q) {
        release_extra = xgr_task_queue_get_process(&q);
        if (!q) return xgr_return_hr(E_INVALIDARG);
    }
    EnterCriticalSection(&q->mon_cs);
    if (q->monitor_len == q->monitor_cap) {
        uint32_t new_cap = q->monitor_cap ? q->monitor_cap * 2 : 8;
        struct monitor_entry *next = (struct monitor_entry *)realloc(q->monitors, new_cap * sizeof(*next));
        if (!next) {
            LeaveCriticalSection(&q->mon_cs);
            if (release_extra) xgr_task_queue_close(q);
            return xgr_return_hr(E_OUTOFMEMORY);
        }
        q->monitors = next;
        q->monitor_cap = new_cap;
    }
    token->token = q->next_token++;
    q->monitors[q->monitor_len].token = *token;
    q->monitors[q->monitor_len].context = ctx;
    q->monitors[q->monitor_len].callback = cb;
    q->monitor_len++;
    LeaveCriticalSection(&q->mon_cs);
    if (release_extra) xgr_task_queue_close(q);
    return xgr_return_hr(S_OK);
}

static void WINAPI th_XTaskQueueUnregisterMonitor(void *iface, XTaskQueueHandle q, XTaskQueueRegistrationToken token)
{
    (void)iface;
    bool release_extra = false;
    if (!q) {
        release_extra = xgr_task_queue_get_process(&q);
        if (!q) {
            xgr_sync_teb_last_error();
            return;
        }
    }
    EnterCriticalSection(&q->mon_cs);
    for (uint32_t i = 0; i < q->monitor_len; i++) {
        if (q->monitors[i].token.token == token.token) {
            memmove(&q->monitors[i], &q->monitors[i + 1], (q->monitor_len - i - 1) * sizeof(*q->monitors));
            q->monitor_len--;
            break;
        }
    }
    LeaveCriticalSection(&q->mon_cs);
    if (release_extra) xgr_task_queue_close(q);
    xgr_sync_teb_last_error();
}

static BOOLEAN WINAPI th_XTaskQueueGetCurrentProcessTaskQueue(void *iface, XTaskQueueHandle *q)
{
    (void)iface;
    return xgr_task_queue_get_process(q) ? TRUE : FALSE;
}

static void WINAPI th_XTaskQueueSetCurrentProcessTaskQueue(void *iface, XTaskQueueHandle q)
{
    (void)iface;
    AcquireSRWLockExclusive(&g_proc_queue_lock);
    g_proc_queue_created = true;
    XTaskQueueHandle old = g_proc_queue;
    if (q) InterlockedIncrement(&q->ref);
    g_proc_queue = q;
    ReleaseSRWLockExclusive(&g_proc_queue_lock);
    if (old) xgr_task_queue_close(old);
}

static HRESULT WINAPI th_XThreadSetTimeSensitive(void *iface, BOOLEAN sensitive)
{
    (void)iface;
    DWORD tls = get_time_sensitive_tls();
    if (tls != TLS_OUT_OF_INDEXES) {
        TlsSetValue(tls, (LPVOID)(uintptr_t)(sensitive ? 1 : 0));
    }
    return xgr_return_hr(S_OK);
}

static BOOLEAN WINAPI th_XThreadIsTimeSensitive(void *iface)
{
    (void)iface;
    DWORD tls = get_time_sensitive_tls();
    if (tls == TLS_OUT_OF_INDEXES) return FALSE;
    return TlsGetValue(tls) != NULL ? TRUE : FALSE;
}

static HRESULT WINAPI th_XThreadVerifyNotTimeSensitive(void *iface)
{
    return xgr_return_hr(th_XThreadIsTimeSensitive(iface) ? ((HRESULT)0x89235100L) : S_OK);
}

static void WINAPI th_XThreadAssertNotTimeSensitive(void *iface) { (void)iface; }

struct IXThreadingImplVtbl {
    HRESULT (WINAPI *QueryInterface)(void *iface, REFIID riid, void **ppv);                                                 /* 0 */
    ULONG   (WINAPI *AddRef)(void *iface);                                                                                  /* 1 */
    ULONG   (WINAPI *Release)(void *iface);                                                                                 /* 2 */
    HRESULT (WINAPI *XAsyncGetStatus)(void *iface, XAsyncBlock *ab, BOOLEAN wait);                                          /* 3 */
    HRESULT (WINAPI *XAsyncGetResultSize)(void *iface, XAsyncBlock *ab, size_t *sz);                                        /* 4 */
    void    (WINAPI *XAsyncCancel)(void *iface, XAsyncBlock *ab);                                                           /* 5 */
    HRESULT (WINAPI *XAsyncRun)(void *iface, XAsyncBlock *ab, XAsyncWork *work);                                            /* 6 */
    HRESULT (WINAPI *XAsyncBegin)(void *iface, XAsyncBlock *ab, void *ctx, const void *id, const char *name, XAsyncProvider *prov); /* 7 */
    HRESULT (WINAPI *XAsyncBeginAlloc)(void *iface, XAsyncBlock *ab, const void *id, const char *name, XAsyncProvider *prov, size_t contextSize); /* 8 */
    HRESULT (WINAPI *XAsyncSchedule)(void *iface, XAsyncBlock *ab, UINT32 delayMs);                                         /* 9 */
    void    (WINAPI *XAsyncComplete)(void *iface, XAsyncBlock *ab, HRESULT result, size_t reqSize);                         /* 10 */
    HRESULT (WINAPI *XAsyncGetResult)(void *iface, XAsyncBlock *ab, const void *id, size_t bufSize, void *buf, size_t *used); /* 11 */
    HRESULT (WINAPI *XTaskQueueCreate)(void *iface, XTaskQueueDispatchMode wm, XTaskQueueDispatchMode cm, XTaskQueueHandle *q); /* 12 */
    HRESULT (WINAPI *XTaskQueueCreateComposite)(void *iface, XTaskQueuePortHandle wp, XTaskQueuePortHandle cp, XTaskQueueHandle *out); /* 13 */
    HRESULT (WINAPI *XTaskQueueGetPort)(void *iface, XTaskQueueHandle q, XTaskQueuePort port, XTaskQueuePortHandle *out);   /* 14 */
    HRESULT (WINAPI *XTaskQueueDuplicateHandle)(void *iface, XTaskQueueHandle q, XTaskQueueHandle *dup);                    /* 15 */
    BOOLEAN (WINAPI *XTaskQueueDispatch)(void *iface, XTaskQueueHandle q, XTaskQueuePort port_type, UINT32 timeoutMs);      /* 16 */
    void    (WINAPI *XTaskQueueCloseHandle)(void *iface, XTaskQueueHandle q);                                               /* 17 */
    HRESULT (WINAPI *XTaskQueueSubmitCallback)(void *iface, XTaskQueueHandle q, XTaskQueuePort port, void *ctx, XTaskQueueCallback *cb); /* 18 */
    HRESULT (WINAPI *XTaskQueueSubmitDelayedCallback)(void *iface, XTaskQueueHandle q, XTaskQueuePort port, UINT32 delayMs, void *ctx, XTaskQueueCallback *cb); /* 19 */
    HRESULT (WINAPI *XTaskQueueRegisterWaiter)(void *iface, XTaskQueueHandle q, XTaskQueuePort port, HANDLE waitHandle, void *ctx, XTaskQueueCallback *cb, XTaskQueueRegistrationToken *token); /* 20 */
    void    (WINAPI *XTaskQueueUnregisterWaiter)(void *iface, XTaskQueueHandle q, XTaskQueueRegistrationToken token);       /* 21 */
    HRESULT (WINAPI *XTaskQueueTerminate)(void *iface, XTaskQueueHandle q, BOOLEAN wait, void *ctx, XTaskQueueTerminatedCallback *cb); /* 22 */
    HRESULT (WINAPI *XTaskQueueRegisterMonitor)(void *iface, XTaskQueueHandle q, void *ctx, XTaskQueueMonitorCallback *cb, XTaskQueueRegistrationToken *token); /* 23 */
    void    (WINAPI *XTaskQueueUnregisterMonitor)(void *iface, XTaskQueueHandle q, XTaskQueueRegistrationToken token);      /* 24 */
    BOOLEAN (WINAPI *XTaskQueueGetCurrentProcessTaskQueue)(void *iface, XTaskQueueHandle *q);                               /* 25 */
    void    (WINAPI *XTaskQueueSetCurrentProcessTaskQueue)(void *iface, XTaskQueueHandle q);                                /* 26 */
    HRESULT (WINAPI *XThreadSetTimeSensitive)(void *iface, BOOLEAN sensitive);                                              /* 27 */
    HRESULT (WINAPI *XThreadVerifyNotTimeSensitive)(void *iface);                                                           /* 28 */
    void    (WINAPI *XThreadAssertNotTimeSensitive)(void *iface);                                                           /* 29 */
    BOOLEAN (WINAPI *XThreadIsTimeSensitive)(void *iface);                                                                  /* 30 */
};

_Static_assert(sizeof(IXThreadingImplVtbl) == 31 * sizeof(void *), "IXThreadingImplVtbl must have exactly 31 slots");

static const IXThreadingImplVtbl g_xthreading_vtbl = {
    th_QueryInterface,
    th_AddRef,
    th_Release,
    th_XAsyncGetStatus,
    th_XAsyncGetResultSize,
    th_XAsyncCancel,
    th_XAsyncRun,
    th_XAsyncBegin,
    th_XAsyncBeginAlloc,
    th_XAsyncSchedule,
    th_XAsyncComplete,
    th_XAsyncGetResult,
    th_XTaskQueueCreate,
    th_XTaskQueueCreateComposite,
    th_XTaskQueueGetPort,
    th_XTaskQueueDuplicateHandle,
    th_XTaskQueueDispatch,
    th_XTaskQueueCloseHandle,
    th_XTaskQueueSubmitCallback,
    th_XTaskQueueSubmitDelayedCallback,
    th_XTaskQueueRegisterWaiter,
    th_XTaskQueueUnregisterWaiter,
    th_XTaskQueueTerminate,
    th_XTaskQueueRegisterMonitor,
    th_XTaskQueueUnregisterMonitor,
    th_XTaskQueueGetCurrentProcessTaskQueue,
    th_XTaskQueueSetCurrentProcessTaskQueue,
    th_XThreadSetTimeSensitive,
    th_XThreadVerifyNotTimeSensitive,
    th_XThreadAssertNotTimeSensitive,
    th_XThreadIsTimeSensitive
};

static IXThreadingImplObj g_xthreading_singleton = { &g_xthreading_vtbl };

HRESULT xgr_query_threading(REFIID iid, void **ppv)
{
    return th_QueryInterface(&g_xthreading_singleton, iid, ppv);
}
