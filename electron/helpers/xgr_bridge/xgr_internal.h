/*
 * One Launcher Clean-Room Xbox Game Runtime Bridge (`one_xgameruntime_bridge.dll`)
 * Pure Win32 C11 — Zero Wine-internal headers, zero libxml2/WinRT dependencies.
 */

#ifndef ONE_XGR_INTERNAL_H
#define ONE_XGR_INTERNAL_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef COBJMACROS
#define COBJMACROS
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <objbase.h>
#include <intrin.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Synchronize Win32 LastError into x86_64 TEB LastErrorValue (%gs:0x68)
 * to prevent Rosetta 2 / older Wine inline GetLastError() desyncs. */
static inline void xgr_sync_teb_last_error(void)
{
#if defined(_WIN32) && (defined(__x86_64__) || defined(_M_X64))
    DWORD err = GetLastError();
    __writegsdword(0x68, err);
#endif
}

static inline HRESULT xgr_return_hr(HRESULT hr)
{
    xgr_sync_teb_last_error();
    return hr;
}

/* Standard Xbox GDK HRESULTs */
#ifndef REGDB_E_CLASSNOTREG
#define REGDB_E_CLASSNOTREG                 ((HRESULT)0x80040154L)
#endif
#define E_GAMEUSER_NO_DEFAULT_USER          ((HRESULT)0x89245106L)
#define E_GAMEUSER_USER_NOT_FOUND           ((HRESULT)0x89245105L)
#define E_GAME_MISSING_GAME_CONFIG          ((HRESULT)0x87E5001FL)
#define E_GS_INVALID_CONTAINER_NAME         ((HRESULT)0x80830001L)
#define E_GS_OUT_OF_LOCAL_STORAGE           ((HRESULT)0x80830003L)
#define E_GS_UPDATE_TOO_BIG                 ((HRESULT)0x80830005L)
#define E_GS_QUOTA_EXCEEDED                 ((HRESULT)0x80830006L)
#define E_GS_PROVIDED_BUFFER_TOO_SMALL      ((HRESULT)0x80830007L)
#define E_GS_BLOB_NOT_FOUND                 ((HRESULT)0x80830008L)
#define E_GS_CONTAINER_NOT_IN_SYNC          ((HRESULT)0x8083000AL)
#define E_GS_HANDLE_EXPIRED                 ((HRESULT)0x8083000CL)

#define XGR_PACKAGE_IDENTIFIER_MAX_LEN      33
#define XGR_SAVE_QUOTA_DEFAULT              (256LL * 1024LL * 1024LL)

/* -------------------------------------------------------------------------
 * Core GDK Types & Structures (Exact Win64 ABI Layout)
 * ------------------------------------------------------------------------- */

typedef struct XTaskQueueObject *XTaskQueueHandle;
typedef struct XTaskQueuePortObject *XTaskQueuePortHandle;

typedef struct XTaskQueueRegistrationToken {
    uint64_t token;
} XTaskQueueRegistrationToken;

typedef enum XTaskQueuePort {
    XTaskQueuePort_Work = 0,
    XTaskQueuePort_Completion = 1
} XTaskQueuePort;

typedef enum XTaskQueueDispatchMode {
    XTaskQueueDispatchMode_Manual = 0,
    XTaskQueueDispatchMode_ThreadPool = 1,
    XTaskQueueDispatchMode_SerializedThreadPool = 2,
    XTaskQueueDispatchMode_Immediate = 3
} XTaskQueueDispatchMode;

typedef void (CALLBACK XTaskQueueCallback)(void *context, bool canceled);
typedef void (CALLBACK XTaskQueueMonitorCallback)(void *context, XTaskQueueHandle queue, XTaskQueuePort port);
typedef void (CALLBACK XTaskQueueTerminatedCallback)(void *context);

typedef struct XAsyncBlock XAsyncBlock;
typedef void (CALLBACK XAsyncCompletionRoutine)(XAsyncBlock *asyncBlock);

struct XAsyncBlock {
    XTaskQueueHandle queue;
    void *context;
    XAsyncCompletionRoutine *callback;
    unsigned char internal[sizeof(void *) * 4];
};

typedef enum XAsyncOp {
    XAsyncOp_Begin = 0,
    XAsyncOp_DoWork = 1,
    XAsyncOp_GetResult = 2,
    XAsyncOp_Cancel = 3,
    XAsyncOp_Cleanup = 4
} XAsyncOp;

typedef struct XAsyncProviderData {
    XAsyncBlock *async;
    size_t bufferSize;
    void *buffer;
    void *context;
} XAsyncProviderData;

typedef HRESULT (CALLBACK XAsyncProvider)(XAsyncOp op, const XAsyncProviderData *data);
typedef HRESULT (CALLBACK XAsyncWork)(XAsyncBlock *asyncBlock);

typedef struct XVersion {
    union {
        struct {
            uint16_t major;
            uint16_t minor;
            uint16_t build;
            uint16_t revision;
        };
        uint64_t Value;
    };
} XVersion;

/* XError */
typedef bool (CALLBACK XErrorCallback)(HRESULT hr, const char *msg, void *context);

/* XUser */
typedef struct XUser *XUserHandle;

typedef struct XUserLocalId {
    uint64_t value;
} XUserLocalId;

typedef enum XUserState {
    XUserState_SignedIn = 0,
    XUserState_SigningOut = 1,
    XUserState_SignedOut = 2
} XUserState;

typedef enum XUserAddOptions {
    XUserAddOptions_None = 0x00,
    XUserAddOptions_AddDefaultUserSilently = 0x01,
    XUserAddOptions_AllowGuests = 0x02,
    XUserAddOptions_AddDefaultUserAllowingUI = 0x04
} XUserAddOptions;

typedef enum XUserGamertagComponent {
    XUserGamertagComponent_Classic = 0,
    XUserGamertagComponent_Modern = 1,
    XUserGamertagComponent_ModernSuffix = 2,
    XUserGamertagComponent_UniqueModern = 3
} XUserGamertagComponent;

typedef enum XUserGamerPictureSize {
    XUserGamerPictureSize_Small = 0,
    XUserGamerPictureSize_Medium = 1,
    XUserGamerPictureSize_Large = 2,
    XUserGamerPictureSize_ExtraLarge = 3
} XUserGamerPictureSize;

typedef enum XUserAgeGroup {
    XUserAgeGroup_Unknown = 0,
    XUserAgeGroup_Child = 1,
    XUserAgeGroup_Teen = 2,
    XUserAgeGroup_Adult = 3
} XUserAgeGroup;

typedef enum XUserPrivilegeDenyReason {
    XUserPrivilegeDenyReason_None = 0
} XUserPrivilegeDenyReason;

typedef struct XUserGetTokenAndSignatureHttpHeader {
    const char *name;
    const char *value;
} XUserGetTokenAndSignatureHttpHeader;

typedef struct XUserGetTokenAndSignatureUtf16HttpHeader {
    const wchar_t *name;
    const wchar_t *value;
} XUserGetTokenAndSignatureUtf16HttpHeader;

typedef struct XUserGetTokenAndSignatureData {
    size_t tokenSize;
    size_t signatureSize;
    const char *token;
    const char *signature;
} XUserGetTokenAndSignatureData;

typedef struct XUserGetTokenAndSignatureUtf16Data {
    size_t tokenCount;
    size_t signatureCount;
    const wchar_t *token;
    const wchar_t *signature;
} XUserGetTokenAndSignatureUtf16Data;

typedef void (CALLBACK XUserChangeEventCallback)(void *context, XUserLocalId userLocalId, int event);

/* XStore */
typedef struct XStoreContext *XStoreContextHandle;
typedef struct XStoreLicense *XStoreLicenseHandle;
typedef struct XStoreProductQuery *XStoreProductQueryHandle;

typedef struct XStoreGameLicense {
    char skuStoreId[18];
    bool isActive;
    bool isTrialOwnedByThisUser;
    bool isDiscLicense;
    bool isTrial;
    uint32_t trialTimeRemainingInSeconds;
    char trialUniqueId[64];
    int64_t expirationDate;
} XStoreGameLicense;

typedef struct XStoreAddonLicense {
    char skuStoreId[18];
    char inAppOfferToken[64];
    bool isActive;
    int64_t expirationDate;
} XStoreAddonLicense;

typedef struct XStorePrice {
    float basePrice;
    float price;
    float recurrencePrice;
    const char *currencyCode;
    char formattedBasePrice[16];
    char formattedPrice[16];
    char formattedRecurrencePrice[16];
    bool isOnSale;
    int64_t saleEndDate;
} XStorePrice;

typedef struct XStoreAvailability {
    const char *availabilityId;
    XStorePrice price;
    int64_t endDate;
} XStoreAvailability;

typedef struct XStoreCollectionData {
    int64_t acquiredDate;
    int64_t startDate;
    int64_t endDate;
    bool isTrial;
    uint32_t trialTimeRemainingInSeconds;
    uint32_t quantity;
    const char *campaignId;
    const char *developerOfferId;
} XStoreCollectionData;

typedef struct XStoreSubscriptionInfo {
    bool hasTrialPeriod;
    uint32_t trialPeriodUnit;
    uint32_t trialPeriod;
    uint32_t billingPeriodUnit;
    uint32_t billingPeriod;
} XStoreSubscriptionInfo;

typedef struct XStoreSku {
    const char *skuId;
    const char *title;
    const char *description;
    const char *language;
    XStorePrice price;
    bool isTrial;
    bool isInUserCollection;
    XStoreCollectionData collectionData;
    bool isSubscription;
    XStoreSubscriptionInfo subscriptionInfo;
    uint32_t bundledSkusCount;
    const char **bundledSkus;
    uint32_t imagesCount;
    void *images;
    uint32_t videosCount;
    void *videos;
    uint32_t availabilitiesCount;
    XStoreAvailability *availabilities;
} XStoreSku;

typedef struct XStoreProduct {
    const char *storeId;
    const char *title;
    const char *description;
    const char *language;
    const char *inAppOfferToken;
    char *linkUri;
    uint32_t productKind;
    XStorePrice price;
    bool hasDigitalDownload;
    bool isInUserCollection;
    uint32_t keywordsCount;
    const char **keywords;
    uint32_t skusCount;
    XStoreSku *skus;
    uint32_t imagesCount;
    void *images;
    uint32_t videosCount;
    void *videos;
} XStoreProduct;

typedef struct XStorePackageUpdate {
    char packageIdentifier[XGR_PACKAGE_IDENTIFIER_MAX_LEN];
    bool isMandatory;
} XStorePackageUpdate;

typedef bool (CALLBACK XStoreProductQueryCallback)(const XStoreProduct *product, void *context);

/* XGameSave */
typedef struct XGameSaveProvider *XGameSaveProviderHandle;
typedef struct XGameSaveContainer *XGameSaveContainerHandle;
typedef struct XGameSaveUpdate *XGameSaveUpdateHandle;

typedef struct XGameSaveContainerInfo {
    const char *name;
    const char *displayName;
    uint32_t blobCount;
    uint64_t totalSize;
    int64_t lastModifiedTime;
    bool needsSync;
} XGameSaveContainerInfo;

typedef struct XGameSaveBlobInfo {
    const char *name;
    uint32_t size;
} XGameSaveBlobInfo;

typedef struct XGameSaveBlob {
    XGameSaveBlobInfo info;
    uint8_t *data;
} XGameSaveBlob;

typedef bool (CALLBACK XGameSaveContainerInfoCallback)(const XGameSaveContainerInfo *info, void *context);
typedef bool (CALLBACK XGameSaveBlobInfoCallback)(const XGameSaveBlobInfo *info, void *context);

/* XPackage */
typedef struct XPackageMountObject *XPackageMountHandle;
typedef struct XPackageInstallationMonitorObject *XPackageInstallationMonitorHandle;

typedef struct XPackageDetails {
    const char *packageIdentifier;
    XVersion version;
    uint32_t kind;
    const char *displayName;
    const char *description;
    const char *publisher;
    const char *storeId;
    bool installing;
    uint32_t index;
    uint32_t count;
    bool ageRestricted;
    const char *titleID;
} XPackageDetails;

typedef struct XPackageInstallationProgress {
    uint64_t totalBytes;
    uint64_t installedBytes;
    uint64_t launchBytes;
    bool launchable;
    bool completed;
} XPackageInstallationProgress;

typedef struct XPackageWriteStats {
    uint64_t interval;
    uint64_t budget;
    uint64_t elapsed;
    uint64_t bytesWritten;
} XPackageWriteStats;

typedef bool (CALLBACK XPackageEnumerationCallback)(void *context, const XPackageDetails *details);

/* XNetworking */
typedef struct XNetworkingConnectivityHint {
    uint32_t connectivityLevel;
    uint32_t connectivityCost;
    uint32_t ianaInterfaceType;
    bool networkInitialized;
    bool approachingDataLimit;
    bool overDataLimit;
    bool roaming;
} XNetworkingConnectivityHint;

typedef void (CALLBACK XNetworkingConnectivityHintChangedCallback)(void *context, const XNetworkingConnectivityHint *hint);

/* XSystem */
typedef struct XSystemAnalyticsInfo {
    XVersion osVersion;
    XVersion hostingOsVersion;
    char family[64];
    char form[64];
} XSystemAnalyticsInfo;

typedef struct XSystemRuntimeInfo {
    XVersion runtimeVersion;
    XVersion availableVersion;
} XSystemRuntimeInfo;

/* InitializeApiImplEx2 Options */
struct xgr_initialize_options {
    uint32_t unk;
    BOOL isInline;
    const char *gameConfig;
};

/* Global Parsed Runtime Configuration */
struct xgr_runtime_config {
    SRWLOCK lock;
    bool initialized;
    bool packaged;
    bool fullTrust;
    uint32_t titleId;
    char titleIdHex[16];
    char scid[128];
    char msaAppId[128];
    char storeId[32];
    char identityName[160];
    char publisher[256];
    char packageFamilyName[256];
    char packageIdentifier[XGR_PACKAGE_IDENTIFIER_MAX_LEN];
    char displayName[256];
    XVersion version;
    char gameRootUtf8[4096];
    wchar_t gameRootWide[4096];
};

/* Thread-safe compact snapshot of g_xgr_cfg (excludes 12 KB path buffers) */
struct xgr_runtime_config_snapshot {
    bool initialized;
    bool packaged;
    bool fullTrust;
    uint32_t titleId;
    char titleIdHex[16];
    char scid[128];
    char msaAppId[128];
    char storeId[32];
    char identityName[160];
    char publisher[256];
    char packageFamilyName[256];
    char packageIdentifier[XGR_PACKAGE_IDENTIFIER_MAX_LEN];
    char displayName[256];
    XVersion version;
};

extern struct xgr_runtime_config g_xgr_cfg;
extern const char g_one_launcher_xgr_bridge_marker[];
HRESULT WINAPI xgr_not_impl_stub(void *iface);

/* -------------------------------------------------------------------------
 * Verified CLSIDs & IIDs (Exact Match to Microsoft Retail xgameruntime.dll)
 * ------------------------------------------------------------------------- */
extern const GUID CLSID_XThreadingImpl;
extern const GUID IID_IXThreadingImpl;

extern const GUID CLSID_XErrorImpl;
extern const GUID IID_IXErrorImpl;

extern const GUID CLSID_XUserImpl;
extern const GUID IID_IXUserImpl;
extern const GUID IID_IXUserImpl2;
extern const GUID IID_IXUserImpl3;
extern const GUID IID_IXUserImpl4;
extern const GUID IID_IXUserImpl5;
extern const GUID IID_IXUserImpl6;
extern const GUID IID_IXUserGamertagImpl;

extern const GUID CLSID_XUserDeviceImpl;
extern const GUID IID_IXUserDeviceImpl;
extern const GUID IID_IXUserDeviceImpl2;

extern const GUID CLSID_XStoreImpl;
extern const GUID IID_IXStoreImpl;
extern const GUID IID_IXStoreImpl2;
extern const GUID IID_IXStoreImpl3;
extern const GUID IID_IXStoreImpl4;
extern const GUID IID_IXStoreImpl5;
extern const GUID IID_IXStoreImpl6;

extern const GUID CLSID_XGameSaveImpl;
extern const GUID IID_IXGameSaveImpl;
extern const GUID IID_IXGameSaveImpl2;
extern const GUID IID_IXGameSaveImpl3;
extern const GUID IID_IXGameSaveImpl4;

extern const GUID CLSID_XPackageImpl;
extern const GUID IID_IXPackageImpl;
extern const GUID IID_IXPackageImpl2;
extern const GUID IID_IXPackageImpl3;
extern const GUID IID_IXPackageImpl4;
extern const GUID IID_IXPackageLegacy;

extern const GUID CLSID_XGameImpl;
extern const GUID IID_IXGameImpl;
extern const GUID IID_IXGameImpl2;
extern const GUID IID_IXGameImpl3;

extern const GUID CLSID_XSystemImpl;
extern const GUID IID_IXSystemImpl;
extern const GUID IID_IXSystemImpl2;
extern const GUID IID_IXSystemImpl3;
extern const GUID IID_IXSystemImpl4;
extern const GUID IID_IXSystemImpl5;

extern const GUID CLSID_XSystemAnalyticsImpl;
extern const GUID IID_IXSystemAnalyticsImpl;

extern const GUID CLSID_XPersistentLocalStorageImpl;
extern const GUID IID_IXPersistentLocalStorageImpl;
extern const GUID IID_IXPersistentLocalStorageImpl2;
extern const GUID IID_IXPersistentLocalStorageImpl3;

extern const GUID CLSID_XNetworkingImpl;
extern const GUID IID_IXNetworkingImpl;
extern const GUID IID_IXNetworkingImpl2;

extern const GUID CLSID_XGameUiImpl;
extern const GUID IID_IXGameUiImpl;
extern const GUID IID_IXGameUiImpl2;
extern const GUID IID_IXGameUiImpl3;
extern const GUID IID_IXGameUiImpl4;
extern const GUID IID_IXGameUiImpl_Legacy0;
extern const GUID IID_IXGameUiImpl_Legacy1;
extern const GUID IID_IXGameUiImpl_Legacy2;

extern const GUID CLSID_XGameRuntimeFeatureImpl;
extern const GUID IID_IXGameRuntimeFeatureImpl;

extern const GUID CLSID_XDisplayImpl;
extern const GUID IID_IXDisplayImpl;

extern const GUID CLSID_XLauncherImpl;
extern const GUID IID_IXLauncherImpl;

extern const GUID CLSID_XAccessibilityImpl;
extern const GUID IID_IXAccessibilityImpl;
extern const GUID IID_IXAccessibilityImpl2;

extern const GUID CLSID_XAppCaptureImpl;
extern const GUID IID_IXAppCaptureImpl;
extern const GUID IID_IXAppCaptureImpl2;
extern const GUID IID_IXAppCaptureImpl3;
extern const GUID IID_IXAppCaptureImpl4;

extern const GUID CLSID_XAppCaptureMetadataImpl;
extern const GUID IID_IXAppCaptureMetadataImpl;

extern const GUID CLSID_XGameProtocolImpl;
extern const GUID IID_IXGameProtocolImpl;

extern const GUID CLSID_XGameActivationImpl;
extern const GUID IID_IXGameActivationImpl;

extern const GUID CLSID_XGameInviteImpl;
extern const GUID IID_IXGameInviteImpl;
extern const GUID IID_IXGameInviteImpl2;

extern const GUID CLSID_XGameStreamingImpl;
extern const GUID IID_IXGameStreamingImpl;
extern const GUID IID_IXGameStreamingImpl2;
extern const GUID IID_IXGameStreamingImpl3;

extern const GUID CLSID_XGameEventImpl;
extern const GUID IID_IXGameEventImpl;

/* -------------------------------------------------------------------------
 * Internal Module Entrypoints
 * ------------------------------------------------------------------------- */

/* xgr_xml_pfn.c */
void xgr_sha256(const uint8_t *data, size_t len, uint8_t out_digest[32]);
bool xgr_compute_package_family_name(const char *identity_name, const char *publisher, char *out_pfn, size_t out_size);
void xgr_load_runtime_config(const struct xgr_initialize_options *options);
void xgr_copy_runtime_config_snapshot(struct xgr_runtime_config_snapshot *out_snap);
void xgr_copy_game_root_utf8(char *out_buf, size_t out_size);

/* xgr_rpc.c */
typedef struct XgrStrBuf {
    char *buf;
    size_t len;
    size_t cap;
    bool failed;
} XgrStrBuf;

void xgr_sb_init(XgrStrBuf *sb);
bool xgr_sb_reserve(XgrStrBuf *sb, size_t extra);
bool xgr_sb_append_len(XgrStrBuf *sb, const char *str, size_t n);
bool xgr_sb_append_cstr(XgrStrBuf *sb, const char *str);
bool xgr_sb_append_char(XgrStrBuf *sb, char c);
bool xgr_sb_append_json_str(XgrStrBuf *sb, const char *raw);
bool xgr_sb_append_fmt(XgrStrBuf *sb, const char *fmt, ...);
char *xgr_sb_detach(XgrStrBuf *sb);
void xgr_sb_free(XgrStrBuf *sb);

bool xgr_get_env_utf8(const WCHAR *name, char *out_buf, size_t out_cap);
bool xgr_rpc_is_configured(void);
HRESULT xgr_rpc_call(const char *method, const char *params_json_obj, char **out_result_json);
void xgr_rpc_shutdown(void);
bool xgr_json_get_string(const char *json, const char *key, char *out_buf, size_t out_size);
bool xgr_json_extract_string(const char *json, const char *key, char *out_buf, size_t out_size);
char *xgr_json_alloc_string(const char *json, const char *key);
bool xgr_json_get_int64(const char *json, const char *key, int64_t *out_val);
bool xgr_json_get_uint64(const char *json, const char *key, uint64_t *out_val);
bool xgr_json_get_bool(const char *json, const char *key, bool *out_val);
char *xgr_json_escape_alloc(const char *raw);
char *xgr_base64_encode_alloc(const uint8_t *data, size_t len);
uint8_t *xgr_base64_decode_alloc(const char *b64, size_t *out_len);

/* xgr_xcurl_shim.c */
void xgr_set_bridge_hmodule(HMODULE hmod);
void xgr_install_xcurl_shim(void);
void xgr_ensure_xcurl_shim(void);
bool xgr_is_xcurl_shim_active(void);
void xgr_uninstall_xcurl_shim(void);

/* xthreading.c */
HRESULT xgr_query_threading(REFIID iid, void **ppv);
void xgr_threading_shutdown(void);
void *xgr_async_try_acquire_state(XAsyncBlock *async, void **out_context);
void xgr_async_release_state(void *state_ref);
HRESULT xgr_async_begin(XAsyncBlock *async, void *context, const void *identity, const char *identityName, XAsyncProvider *provider);
HRESULT xgr_async_schedule(XAsyncBlock *async, uint32_t delayMs);
HRESULT xgr_async_schedule_background(XAsyncBlock *async);
void xgr_async_complete(XAsyncBlock *async, HRESULT result, size_t requiredBufferSize);
HRESULT xgr_async_get_status(XAsyncBlock *async, bool wait);
HRESULT xgr_async_get_result_size(XAsyncBlock *async, size_t *bufferSize);
HRESULT xgr_async_get_result(XAsyncBlock *async, const void *identity, size_t bufferSize, void *buffer, size_t *bufferUsed);
bool xgr_task_queue_get_process(XTaskQueueHandle *out_queue);
HRESULT xgr_task_queue_duplicate(XTaskQueueHandle queue, XTaskQueueHandle *out_dup);
void xgr_task_queue_close(XTaskQueueHandle queue);
HRESULT xgr_task_queue_submit_delayed(XTaskQueueHandle queue, XTaskQueuePort port, uint32_t delayMs, void *ctx, XTaskQueueCallback *cb);

/* xuser.c */
HRESULT xgr_query_user(REFIID iid, void **ppv);
HRESULT xgr_query_user_device(REFIID iid, void **ppv);
void xgr_user_shutdown(void);
uint64_t xgr_user_get_xuid(XUserHandle user);
HRESULT xgr_user_duplicate(XUserHandle user, XUserHandle *out_user);
void xgr_user_close(XUserHandle user);

/* xstore.c */
HRESULT xgr_query_store(REFIID iid, void **ppv);

/* xgamesave.c */
HRESULT xgr_query_gamesave(REFIID iid, void **ppv);
void xgr_gamesave_shutdown(void);

/* xpackage.c */
HRESULT xgr_query_package(REFIID iid, void **ppv);
HRESULT xgr_package_mount_internal(const char *pkg_id, XPackageMountHandle *out);

/* xsystem_misc.c */
HRESULT xgr_query_error(REFIID iid, void **ppv);
BOOL xgr_invoke_error_report(HRESULT error, const char *message);
HRESULT xgr_query_display(REFIID iid, void **ppv);
HRESULT xgr_query_launcher(REFIID iid, void **ppv);
HRESULT xgr_query_game(REFIID iid, void **ppv);
HRESULT xgr_query_system(REFIID iid, void **ppv);
HRESULT xgr_query_system_analytics(REFIID iid, void **ppv);
HRESULT xgr_query_pls(REFIID iid, void **ppv);
HRESULT xgr_query_networking(REFIID iid, void **ppv);
HRESULT xgr_query_game_ui(REFIID iid, void **ppv);
HRESULT xgr_query_runtime_feature(REFIID iid, void **ppv);
HRESULT xgr_query_accessibility(REFIID iid, void **ppv);
HRESULT xgr_query_app_capture(REFIID iid, void **ppv);
HRESULT xgr_query_app_capture_metadata(REFIID iid, void **ppv);
HRESULT xgr_query_game_protocol(REFIID iid, void **ppv);
HRESULT xgr_query_game_activation(REFIID iid, void **ppv);
HRESULT xgr_query_game_invite(REFIID iid, void **ppv);
HRESULT xgr_query_game_streaming(REFIID iid, void **ppv);
HRESULT xgr_query_game_event(REFIID iid, void **ppv);

/* Exported DLL API */
HRESULT WINAPI QueryApiImpl(REFCLSID clsid, REFIID iid, void **out);

#endif /* ONE_XGR_INTERNAL_H */
