#include <dlfcn.h>
#include <stdlib.h>
#include <pthread.h>
#include <CoreFoundation/CoreFoundation.h>

extern void *MTLCreateSystemDefaultDevice(void);

struct interpose_s {
    void *new_func;
    void *orig_func;
};

static pthread_once_t s_once = PTHREAD_ONCE_INIT;

static void preinit_metal_and_mvk(void) {
    void *dev = MTLCreateSystemDefaultDevice();
    (void)dev;
    const char *mvk_path = getenv("ONE_LAUNCHER_MOLTENVK_PATH");
    if (mvk_path && mvk_path[0]) {
        dlopen(mvk_path, RTLD_NOW | RTLD_GLOBAL);
    }
    dlopen("libMoltenVK.dylib", RTLD_NOW | RTLD_GLOBAL);
}

static void my_CFRunLoopRun(void) {
    if (pthread_main_np()) {
        pthread_once(&s_once, preinit_metal_and_mvk);
    }
    CFRunLoopRun();
}

__attribute__((used)) static const struct interpose_s interpose_CFRunLoopRun
    __attribute__((section("__DATA,__interpose"))) = {
        (void *)my_CFRunLoopRun,
        (void *)CFRunLoopRun
    };
