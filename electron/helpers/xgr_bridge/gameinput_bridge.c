/*
 * One Launcher Clean-Room Win64 GameInput Bridge (`one_gameinput_bridge.dll`)
 *
 * Replaces stubbed Wine `gameinput.dll` (`E_NOTIMPL`) and ALPC-bound
 * `GameInputRedist.dll` (`GameInputSvc` failure under Wine/CrossOver) with a
 * self-contained, zero-ALPC Win32 + XInput COM implementation supporting
 * Microsoft GameInput v0, v1, and v2 ABIs simultaneously via multi-vtable
 * COM composition.
 */

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <unknwn.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

/* Embedded PE binary marker verified by `scripts/build-xbox-bridge.cjs` */
#if defined(__GNUC__) || defined(__clang__)
__attribute__((used))
#endif
static const char g_onelauncher_gameinput_marker[] = "OneLauncher.GameInputBridge.v1";

/* -------------------------------------------------------------------------
 * Official GameInput HRESULTs (FACILITY_GAMEINPUT = 906 = 0x38A)
 * ------------------------------------------------------------------------- */
#define GI_E_DEVICE_DISCONNECTED               ((HRESULT)0x838A0001L)
#define GI_E_DEVICE_NOT_FOUND                  ((HRESULT)0x838A0002L)
#define GI_E_READING_NOT_FOUND                 ((HRESULT)0x838A0003L)
#define GI_E_REFERENCE_READING_TOO_OLD         ((HRESULT)0x838A0004L)
#define GI_E_TIMESTAMP_OUT_OF_RANGE            ((HRESULT)0x838A0005L)
#define GI_E_INSUFFICIENT_FFB_RESOURCES        ((HRESULT)0x838A0006L)
#define GI_E_FEEDBACK_NOT_SUPPORTED            ((HRESULT)0x838A0007L)
#define GI_E_OBJECT_NO_LONGER_EXISTS           ((HRESULT)0x838A0008L)
#define GI_E_CALLBACK_NOT_FOUND                ((HRESULT)0x838A0009L)
#define GI_E_HAPTIC_INFO_NOT_FOUND             ((HRESULT)0x838A000AL)
#define GI_E_AGGREGATE_OPERATION_NOT_SUPPORTED ((HRESULT)0x838A000BL)

/* -------------------------------------------------------------------------
 * Interface GUIDs across GameInput v0, v1, and v2
 * ------------------------------------------------------------------------- */
static const GUID GI_IID_IUnknown =
    {0x00000000, 0x0000, 0x0000, {0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};

static const GUID GI_IID_IGameInput_v0 =
    {0x11be2a7e, 0x4254, 0x445a, {0x9c, 0x09, 0xff, 0xc4, 0x0f, 0x00, 0x69, 0x18}};
static const GUID GI_IID_IGameInput_v1 =
    {0x40ffb7e4, 0x6150, 0x407a, {0xb4, 0x39, 0x13, 0x2b, 0xad, 0xc0, 0x8d, 0x2d}};
static const GUID GI_IID_IGameInput_v2 =
    {0xbbaa66d2, 0x837a, 0x40f7, {0xa3, 0x03, 0x91, 0x7d, 0x50, 0x09, 0x55, 0xf4}};

static const GUID GI_IID_IGameInputReading_v0 =
    {0x2156947a, 0xe1fa, 0x4de0, {0xa3, 0x0b, 0xd8, 0x12, 0x93, 0x1d, 0xbd, 0x8d}};
static const GUID GI_IID_IGameInputReading_v1 =
    {0x86318e60, 0x0b3c, 0x40d6, {0xbe, 0xfa, 0xc6, 0x2f, 0x2d, 0x95, 0x27, 0x24}};
static const GUID GI_IID_IGameInputReading_v2 =
    {0x65f06483, 0xdb76, 0x40b7, {0xb7, 0x45, 0xf5, 0x91, 0xfa, 0xe5, 0x5f, 0xc9}};

static const GUID GI_IID_IGameInputDevice_v0 =
    {0x31dd86fb, 0x4c1b, 0x408a, {0x86, 0x8f, 0x43, 0x9b, 0x3c, 0xd4, 0x71, 0x25}};
static const GUID GI_IID_IGameInputDevice_v1 =
    {0xb169652a, 0x4a32, 0x40d7, {0x9f, 0xa9, 0x90, 0x59, 0x97, 0x95, 0x25, 0x16}};
static const GUID GI_IID_IGameInputDevice_v2 =
    {0x39a0c9f2, 0xf055, 0x4089, {0x96, 0xe7, 0x25, 0xb2, 0x75, 0x6d, 0x30, 0x77}};

static const GUID GI_IID_IGameInputDispatcher =
    {0x415eed2e, 0x98cb, 0x42c2, {0x8f, 0x28, 0xb9, 0x46, 0x01, 0x07, 0x4e, 0x31}};

static inline int gi_guid_eq(const GUID *a, const GUID *b) {
    return (a && b && memcmp(a, b, sizeof(GUID)) == 0);
}

/* -------------------------------------------------------------------------
 * Core GameInput Enumerations & Structures
 * ------------------------------------------------------------------------- */
typedef uint64_t GameInputCallbackToken;
typedef uint32_t GameInputKind;
typedef uint32_t GameInputDeviceStatus;
typedef uint32_t GameInputEnumerationKind;
typedef uint32_t GameInputFocusPolicy;
typedef uint32_t GameInputSystemButtons;
typedef uint32_t GameInputMouseButtons;
typedef uint32_t GameInputMousePositions;
typedef uint32_t GameInputGamepadButtons;
typedef uint32_t GameInputUiNavigationButtons;
typedef uint32_t GameInputRumbleMotors;
typedef int32_t  GameInputSwitchPosition;
typedef int32_t  GameInputDeviceFamily;
typedef int32_t  GameInputLabel;

enum {
    GI_KindUnknown          = 0x00000000u,
    GI_KindRawDeviceReport  = 0x00000001u,
    GI_KindControllerAxis   = 0x00000002u,
    GI_KindControllerButton = 0x00000004u,
    GI_KindControllerSwitch = 0x00000008u,
    GI_KindController       = 0x0000000Eu,
    GI_KindKeyboard         = 0x00000010u,
    GI_KindMouse            = 0x00000020u,
    GI_KindSensors          = 0x00000040u,
    GI_KindTouch            = 0x00000100u,
    GI_KindMotion           = 0x00001000u,
    GI_KindArcadeStick      = 0x00010000u,
    GI_KindFlightStick      = 0x00020000u,
    GI_KindGamepad          = 0x00040000u,
    GI_KindRacingWheel      = 0x00080000u,
    GI_KindUiNavigation     = 0x01000000u
};

enum {
    GI_NoEnumeration       = 0u,
    GI_AsyncEnumeration    = 1u,
    GI_BlockingEnumeration = 2u
};

enum {
    GI_DefaultFocusPolicy             = 0x00000000u,
    GI_DisableBackgroundInput         = 0x00000001u,
    GI_ExclusiveForegroundInput       = 0x00000002u,
    GI_DisableBackgroundGuideButton   = 0x00000004u,
    GI_ExclusiveForegroundGuideButton = 0x00000008u,
    GI_DisableBackgroundShareButton   = 0x00000010u,
    GI_ExclusiveForegroundShareButton = 0x00000020u,
    GI_EnableBackgroundInput          = 0x00000040u,
    GI_EnableBackgroundGuideButton    = 0x00000080u,
    GI_EnableBackgroundShareButton    = 0x00000100u
};

enum {
    GI_DeviceNoStatus     = 0x00000000u,
    GI_DeviceConnected    = 0x00000001u,
    GI_DeviceInputEnabled = 0x00000002u
};

enum {
    GI_MouseNone         = 0x00000000u,
    GI_MouseLeftButton   = 0x00000001u,
    GI_MouseRightButton  = 0x00000002u,
    GI_MouseMiddleButton = 0x00000004u,
    GI_MouseButton4      = 0x00000008u,
    GI_MouseButton5      = 0x00000010u
};

enum {
    GI_MouseNoPosition       = 0x00000000u,
    GI_MouseAbsolutePosition = 0x00000001u,
    GI_MouseRelativePosition = 0x00000002u
};

enum {
    GI_GamepadNone            = 0x00000000u,
    GI_GamepadMenu            = 0x00000001u,
    GI_GamepadView            = 0x00000002u,
    GI_GamepadA               = 0x00000004u,
    GI_GamepadB               = 0x00000008u,
    GI_GamepadX               = 0x00000010u,
    GI_GamepadY               = 0x00000020u,
    GI_GamepadDPadUp          = 0x00000040u,
    GI_GamepadDPadDown        = 0x00000080u,
    GI_GamepadDPadLeft        = 0x00000100u,
    GI_GamepadDPadRight       = 0x00000200u,
    GI_GamepadLeftShoulder    = 0x00000400u,
    GI_GamepadRightShoulder   = 0x00000800u,
    GI_GamepadLeftThumbstick  = 0x00001000u,
    GI_GamepadRightThumbstick = 0x00002000u
};

enum {
    GI_UiNavNone      = 0x00000000u,
    GI_UiNavMenu      = 0x00000001u,
    GI_UiNavView      = 0x00000002u,
    GI_UiNavAccept    = 0x00000004u,
    GI_UiNavCancel    = 0x00000008u,
    GI_UiNavUp        = 0x00000010u,
    GI_UiNavDown      = 0x00000020u,
    GI_UiNavLeft      = 0x00000040u,
    GI_UiNavRight     = 0x00000080u,
    GI_UiNavPageLeft  = 0x00004000u,
    GI_UiNavPageRight = 0x00008000u
};

enum {
    GI_SwitchCenter    = 0,
    GI_SwitchUp        = 1,
    GI_SwitchUpRight   = 2,
    GI_SwitchRight     = 3,
    GI_SwitchDownRight = 4,
    GI_SwitchDown      = 5,
    GI_SwitchDownLeft  = 6,
    GI_SwitchLeft      = 7,
    GI_SwitchUpLeft    = 8
};

enum {
    GI_FamilyVirtual   = -1,
    GI_FamilyAggregate = 0,
    GI_FamilyXboxOne   = 1,
    GI_FamilyXbox360   = 2,
    GI_FamilyHid       = 3,
    GI_FamilyI8042     = 4
};

enum {
    GI_RumbleNone          = 0x00000000u,
    GI_RumbleLowFrequency  = 0x00000001u,
    GI_RumbleHighFrequency = 0x00000002u,
    GI_RumbleLeftTrigger   = 0x00000004u,
    GI_RumbleRightTrigger  = 0x00000008u
};

typedef struct GI_APP_LOCAL_DEVICE_ID {
    uint8_t value[32];
} GI_APP_LOCAL_DEVICE_ID;

typedef struct GI_Usage {
    uint16_t page;
    uint16_t id;
} GI_Usage;

typedef struct GI_Version {
    uint16_t major;
    uint16_t minor;
    uint16_t build;
    uint16_t revision;
} GI_Version;

typedef struct GI_String {
    uint32_t sizeInBytes;
    uint32_t codePointCount;
    const char *data;
} GI_String;

typedef struct GI_KeyState {
    uint32_t scanCode;
    uint32_t codePoint;
    uint8_t  virtualKey;
    bool     isDeadKey;
} GI_KeyState;

typedef struct GI_MouseState_v0 {
    GameInputMouseButtons buttons;
    int64_t positionX;
    int64_t positionY;
    int64_t wheelX;
    int64_t wheelY;
} GI_MouseState_v0;

typedef struct GI_MouseState_v1 {
    GameInputMouseButtons   buttons;
    GameInputMousePositions positions;
    int64_t positionX;
    int64_t positionY;
    int64_t absolutePositionX;
    int64_t absolutePositionY;
    int64_t wheelX;
    int64_t wheelY;
} GI_MouseState_v1;

typedef struct GI_GamepadState {
    GameInputGamepadButtons buttons;
    float leftTrigger;
    float rightTrigger;
    float leftThumbstickX;
    float leftThumbstickY;
    float rightThumbstickX;
    float rightThumbstickY;
} GI_GamepadState;

typedef struct GI_UiNavigationState {
    GameInputUiNavigationButtons buttons;
} GI_UiNavigationState;

typedef struct GI_BatteryState {
    float   chargeRate;
    float   maxChargeRate;
    float   remainingCapacity;
    float   fullChargeCapacity;
    int32_t status;
} GI_BatteryState;

typedef struct GI_RumbleParams {
    float lowFrequency;
    float highFrequency;
    float leftTrigger;
    float rightTrigger;
} GI_RumbleParams;

typedef struct GI_KeyboardInfo_v0 {
    int32_t          kind;
    uint32_t         layout;
    uint32_t         keyCount;
    uint32_t         functionKeyCount;
    uint32_t         maxSimultaneousKeys;
    uint32_t         platformType;
    uint32_t         platformSubtype;
    const GI_String *nativeLanguage;
} GI_KeyboardInfo_v0;

typedef struct GI_KeyboardInfo_v1 {
    int32_t  kind;
    uint32_t layout;
    uint32_t keyCount;
    uint32_t functionKeyCount;
    uint32_t maxSimultaneousKeys;
    uint32_t platformType;
    uint32_t platformSubtype;
} GI_KeyboardInfo_v1;

typedef struct GI_MouseInfo_v0 {
    GameInputMouseButtons supportedButtons;
    uint32_t sampleRate;
    uint32_t sensorDpi;
    bool     hasWheelX;
    bool     hasWheelY;
} GI_MouseInfo_v0;

typedef struct GI_MouseInfo_v1 {
    GameInputMouseButtons supportedButtons;
    uint32_t sampleRate;
    bool     hasWheelX;
    bool     hasWheelY;
} GI_MouseInfo_v1;

typedef struct GI_GamepadInfo {
    GameInputLabel menuButtonLabel;
    GameInputLabel viewButtonLabel;
    GameInputLabel aButtonLabel;
    GameInputLabel bButtonLabel;
    GameInputLabel xButtonLabel;
    GameInputLabel yButtonLabel;
    GameInputLabel dpadUpLabel;
    GameInputLabel dpadDownLabel;
    GameInputLabel dpadLeftLabel;
    GameInputLabel dpadRightLabel;
    GameInputLabel leftShoulderButtonLabel;
    GameInputLabel rightShoulderButtonLabel;
    GameInputLabel leftThumbstickButtonLabel;
    GameInputLabel rightThumbstickButtonLabel;
} GI_GamepadInfo;

typedef struct GI_ControllerAxisInfo_v0 {
    GameInputKind  mappedInputKinds;
    GameInputLabel label;
    bool           isContinuous;
    bool           isNonlinear;
    bool           isQuantized;
    bool           hasRestValue;
    float          restValue;
    uint64_t       resolution;
    uint16_t       legacyDInputIndex;
    uint16_t       legacyHidIndex;
    uint32_t       rawReportIndex;
    const void    *inputReport;
    const void    *inputReportItem;
} GI_ControllerAxisInfo_v0;

typedef struct GI_ControllerAxisInfo_v1 {
    GameInputKind  mappedInputKinds;
    GameInputLabel label;
    bool           isContinuous;
    bool           isNonlinear;
    bool           isQuantized;
    bool           hasRestValue;
    float          restValue;
    uint64_t       resolution;
    uint16_t       legacyDInputIndex;
    uint16_t       legacyHidIndex;
} GI_ControllerAxisInfo_v1;

typedef struct GI_ControllerButtonInfo_v0 {
    GameInputKind  mappedInputKinds;
    GameInputLabel label;
    uint16_t       legacyDInputIndex;
    uint16_t       legacyHidIndex;
    uint32_t       rawReportIndex;
    const void    *inputReport;
    const void    *inputReportItem;
} GI_ControllerButtonInfo_v0;

typedef struct GI_ControllerButtonInfo_v1 {
    GameInputKind  mappedInputKinds;
    GameInputLabel label;
    uint16_t       legacyDInputIndex;
    uint16_t       legacyHidIndex;
} GI_ControllerButtonInfo_v1;

typedef struct GI_ControllerSwitchInfo_v0 {
    GameInputKind  mappedInputKinds;
    GameInputLabel label;
    GameInputLabel positionLabels[9];
    int32_t        kind;
    uint16_t       legacyDInputIndex;
    uint16_t       legacyHidIndex;
    uint32_t       rawReportIndex;
    const void    *inputReport;
    const void    *inputReportItem;
} GI_ControllerSwitchInfo_v0;

typedef struct GI_ControllerSwitchInfo_v1 {
    GameInputKind  mappedInputKinds;
    GameInputLabel label;
    GameInputLabel positionLabels[9];
    int32_t        kind;
    uint16_t       legacyDInputIndex;
    uint16_t       legacyHidIndex;
} GI_ControllerSwitchInfo_v1;

typedef struct GI_UiNavigationInfo {
    GameInputUiNavigationButtons supportedButtons;
    GameInputLabel menuLabel;
    GameInputLabel viewLabel;
    GameInputLabel acceptLabel;
    GameInputLabel cancelLabel;
    GameInputLabel upLabel;
    GameInputLabel downLabel;
    GameInputLabel leftLabel;
    GameInputLabel rightLabel;
    GameInputLabel context1Label;
    GameInputLabel context2Label;
    GameInputLabel context3Label;
    GameInputLabel context4Label;
    GameInputLabel pageUpLabel;
    GameInputLabel pageDownLabel;
    GameInputLabel pageLeftLabel;
    GameInputLabel pageRightLabel;
    GameInputLabel scrollUpLabel;
    GameInputLabel scrollDownLabel;
    GameInputLabel scrollLeftLabel;
    GameInputLabel scrollRightLabel;
} GI_UiNavigationInfo;

typedef struct GI_DeviceInfo_v0 {
    uint32_t               infoSize;
    uint16_t               vendorId;
    uint16_t               productId;
    uint16_t               revisionNumber;
    uint8_t                interfaceNumber;
    uint8_t                collectionNumber;
    GI_Usage               usage;
    GI_Version             hardwareVersion;
    GI_Version             firmwareVersion;
    GI_APP_LOCAL_DEVICE_ID deviceId;
    GI_APP_LOCAL_DEVICE_ID deviceRootId;
    GameInputDeviceFamily  deviceFamily;
    uint32_t               capabilities;
    GameInputKind          supportedInput;
    GameInputRumbleMotors  supportedRumbleMotors;
    uint32_t               inputReportCount;
    uint32_t               outputReportCount;
    uint32_t               featureReportCount;
    uint32_t               controllerAxisCount;
    uint32_t               controllerButtonCount;
    uint32_t               controllerSwitchCount;
    uint32_t               touchPointCount;
    uint32_t               touchSensorCount;
    uint32_t               forceFeedbackMotorCount;
    uint32_t               hapticFeedbackMotorCount;
    uint32_t               deviceStringCount;
    uint32_t               deviceDescriptorSize;
    const void            *inputReportInfo;
    const void            *outputReportInfo;
    const void            *featureReportInfo;
    const void            *controllerAxisInfo;
    const void            *controllerButtonInfo;
    const void            *controllerSwitchInfo;
    const GI_KeyboardInfo_v0 *keyboardInfo;
    const GI_MouseInfo_v0    *mouseInfo;
    const void            *touchSensorInfo;
    const void            *motionInfo;
    const void            *arcadeStickInfo;
    const void            *flightStickInfo;
    const GI_GamepadInfo  *gamepadInfo;
    const void            *racingWheelInfo;
    const void            *uiNavigationInfo;
    const void            *forceFeedbackMotorInfo;
    const void            *hapticFeedbackMotorInfo;
    const GI_String       *displayName;
    const GI_String       *deviceStrings;
    const void            *deviceDescriptorData;
    GameInputSystemButtons supportedSystemButtons;
} GI_DeviceInfo_v0;

typedef struct GI_DeviceInfo_v1 {
    uint16_t                  vendorId;
    uint16_t                  productId;
    GI_Usage                  usage;
    GI_APP_LOCAL_DEVICE_ID    deviceId;
    GI_APP_LOCAL_DEVICE_ID    deviceRootId;
    GameInputDeviceFamily     deviceFamily;
    GameInputKind             supportedInput;
    GameInputRumbleMotors     supportedRumbleMotors;
    GameInputSystemButtons    supportedSystemButtons;
    const char               *displayName;
    const char               *pnpPath;
    const GI_KeyboardInfo_v1 *keyboardInfo;
    const GI_MouseInfo_v1    *mouseInfo;
    const void               *arcadeStickInfo;
    const void               *flightStickInfo;
    const GI_GamepadInfo     *gamepadInfo;
    const void               *racingWheelInfo;
    const void               *uiNavigationInfo;
    uint32_t                  controllerAxisCount;
    const void               *controllerAxisInfo;
    uint32_t                  controllerButtonCount;
    const void               *controllerButtonInfo;
    uint32_t                  controllerSwitchCount;
    const void               *controllerSwitchInfo;
    uint32_t                  forceFeedbackMotorCount;
    const void               *forceFeedbackMotorInfo;
} GI_DeviceInfo_v1;

typedef struct GI_DeviceInfo_v2 {
    uint16_t                  vendorId;
    uint16_t                  productId;
    uint16_t                  revisionNumber;
    GI_Usage                  usage;
    GI_Version                hardwareVersion;
    GI_Version                firmwareVersion;
    GI_APP_LOCAL_DEVICE_ID    deviceId;
    GI_APP_LOCAL_DEVICE_ID    deviceRootId;
    GameInputDeviceFamily     deviceFamily;
    GameInputKind             supportedInput;
    GameInputRumbleMotors     supportedRumbleMotors;
    GameInputSystemButtons    supportedSystemButtons;
    GUID                      containerId;
    const char               *displayName;
    const char               *pnpPath;
    const GI_KeyboardInfo_v1 *keyboardInfo;
    const GI_MouseInfo_v1    *mouseInfo;
    const void               *sensorsInfo;
    const void               *arcadeStickInfo;
    const void               *flightStickInfo;
    const GI_GamepadInfo     *gamepadInfo;
    const void               *racingWheelInfo;
    const void               *uiNavigationInfo;
    uint32_t                  controllerAxisCount;
    const void               *controllerAxisInfo;
    uint32_t                  controllerButtonCount;
    const void               *controllerButtonInfo;
    uint32_t                  controllerSwitchCount;
    const void               *controllerSwitchInfo;
    uint32_t                  forceFeedbackMotorCount;
    const void               *forceFeedbackMotorInfo;
} GI_DeviceInfo_v2;

/* -------------------------------------------------------------------------
 * Dynamic XInput Loader (`xinput1_4.dll` / `xinput1_3.dll` / `xinput9_1_0.dll`)
 * ------------------------------------------------------------------------- */
typedef struct GI_XINPUT_GAMEPAD {
    WORD  wButtons;
    BYTE  bLeftTrigger;
    BYTE  bRightTrigger;
    SHORT sThumbLX;
    SHORT sThumbLY;
    SHORT sThumbRX;
    SHORT sThumbRY;
} GI_XINPUT_GAMEPAD;

typedef struct GI_XINPUT_STATE {
    DWORD             dwPacketNumber;
    GI_XINPUT_GAMEPAD Gamepad;
} GI_XINPUT_STATE;

typedef struct GI_XINPUT_VIBRATION {
    WORD wLeftMotorSpeed;
    WORD wRightMotorSpeed;
} GI_XINPUT_VIBRATION;

#define GI_XINPUT_GAMEPAD_DPAD_UP        0x0001
#define GI_XINPUT_GAMEPAD_DPAD_DOWN      0x0002
#define GI_XINPUT_GAMEPAD_DPAD_LEFT      0x0004
#define GI_XINPUT_GAMEPAD_DPAD_RIGHT     0x0008
#define GI_XINPUT_GAMEPAD_START          0x0010
#define GI_XINPUT_GAMEPAD_BACK           0x0020
#define GI_XINPUT_GAMEPAD_LEFT_THUMB     0x0040
#define GI_XINPUT_GAMEPAD_RIGHT_THUMB    0x0080
#define GI_XINPUT_GAMEPAD_LEFT_SHOULDER  0x0100
#define GI_XINPUT_GAMEPAD_RIGHT_SHOULDER 0x0200
#define GI_XINPUT_GAMEPAD_A              0x1000
#define GI_XINPUT_GAMEPAD_B              0x2000
#define GI_XINPUT_GAMEPAD_X              0x4000
#define GI_XINPUT_GAMEPAD_Y              0x8000

typedef DWORD (WINAPI *PFN_XInputGetState)(DWORD dwUserIndex, GI_XINPUT_STATE *pState);
typedef DWORD (WINAPI *PFN_XInputSetState)(DWORD dwUserIndex, GI_XINPUT_VIBRATION *pVibration);

static INIT_ONCE          g_xinput_once = INIT_ONCE_STATIC_INIT;
static PFN_XInputGetState g_pfn_XInputGetState = NULL;
static PFN_XInputSetState g_pfn_XInputSetState = NULL;

static BOOL CALLBACK gi_init_xinput_once(PINIT_ONCE once, PVOID param, PVOID *ctx) {
    static const wchar_t *const dll_names[] = {
        L"xinput1_4.dll",
        L"xinput1_3.dll",
        L"xinput9_1_0.dll"
    };
    (void)once;
    (void)param;
    (void)ctx;

    for (size_t i = 0; i < sizeof(dll_names) / sizeof(dll_names[0]); i++) {
        HMODULE mod = LoadLibraryW(dll_names[i]);
        if (mod) {
            /* Try ordinal 100 (Ex with Guide button) or standard XInputGetState */
            PFN_XInputGetState get_fn = (PFN_XInputGetState)(void *)GetProcAddress(mod, (LPCSTR)100);
            if (!get_fn) {
                get_fn = (PFN_XInputGetState)(void *)GetProcAddress(mod, "XInputGetState");
            }
            PFN_XInputSetState set_fn = (PFN_XInputSetState)(void *)GetProcAddress(mod, "XInputSetState");
            if (get_fn) {
                g_pfn_XInputGetState = get_fn;
                g_pfn_XInputSetState = set_fn;
                break;
            }
        }
    }
    return TRUE;
}

static inline void gi_ensure_xinput(void) {
    InitOnceExecuteOnce(&g_xinput_once, gi_init_xinput_once, NULL, NULL);
}

/* High-resolution monotonic timestamp in microseconds */
static uint64_t gi_get_timestamp_us(void) {
    LARGE_INTEGER counter, freq;
    if (QueryPerformanceCounter(&counter) && QueryPerformanceFrequency(&freq) && freq.QuadPart > 0) {
        uint64_t whole_sec = (uint64_t)(counter.QuadPart / freq.QuadPart);
        uint64_t rem_ticks = (uint64_t)(counter.QuadPart % freq.QuadPart);
        return whole_sec * 1000000ull + (rem_ticks * 1000000ull) / (uint64_t)freq.QuadPart;
    }
    return (uint64_t)GetTickCount64() * 1000ull;
}

/* -------------------------------------------------------------------------
 * Forward Declarations & Internal COM Object Layouts
 * ------------------------------------------------------------------------- */
typedef struct GI_IfaceSlot {
    const void *lpVtbl;
} GI_IfaceSlot;

typedef enum GI_ApiVer {
    GI_VER_0 = 0,
    GI_VER_1 = 1,
    GI_VER_2 = 2
} GI_ApiVer;

typedef enum GI_InternalDevType {
    GI_DEV_KEYBOARD  = 0,
    GI_DEV_MOUSE     = 1,
    GI_DEV_GAMEPAD_0 = 2,
    GI_DEV_GAMEPAD_1 = 3,
    GI_DEV_GAMEPAD_2 = 4,
    GI_DEV_GAMEPAD_3 = 5,
    GI_DEV_AGGREGATE = 6,
    GI_DEV_COUNT     = 7
} GI_InternalDevType;

struct GI_ReadingImpl;

typedef struct GI_DeviceImpl {
    GI_IfaceSlot           v0_iface;
    GI_IfaceSlot           v1_iface;
    GI_IfaceSlot           v2_iface;
    volatile LONG          ref_count;
    GI_InternalDevType     dev_type;
    int                    xinput_slot; /* 0..3 for gamepads, -1 otherwise */
    bool                   connected;
    bool                   has_last_snapshot;
    volatile LONGLONG      next_probe_tick_ms;
    struct GI_ReadingImpl *current_reading;
    GI_String              display_str_v0;
    GI_DeviceInfo_v0       info_v0;
    GI_DeviceInfo_v1       info_v1;
    GI_DeviceInfo_v2       info_v2;
} GI_DeviceImpl;

#define GI_MAX_ACTIVE_KEYS       32
#define GI_CONTROLLER_AXIS_COUNT 6
#define GI_CONTROLLER_BTN_COUNT  14

typedef struct GI_ReadingSnapshot {
    GameInputKind           kind;
    uint64_t                sequence;
    uint64_t                timestamp;
    GI_DeviceImpl          *device;
    uint32_t                key_count;
    GI_KeyState             keys[GI_MAX_ACTIVE_KEYS];
    GI_MouseState_v1        mouse;
    GI_GamepadState         gamepad;
    GI_UiNavigationState    ui_nav;
    uint32_t                axis_count;
    float                   axes[GI_CONTROLLER_AXIS_COUNT];
    uint32_t                button_count;
    bool                    buttons[GI_CONTROLLER_BTN_COUNT];
    uint32_t                switch_count;
    GameInputSwitchPosition hat_switch;
} GI_ReadingSnapshot;

typedef struct GI_ReadingImpl {
    GI_IfaceSlot       v0_iface;
    GI_IfaceSlot       v1_iface;
    GI_IfaceSlot       v2_iface;
    volatile LONG      ref_count;
    GI_ReadingSnapshot snap;
} GI_ReadingImpl;

typedef struct GI_DispatcherImpl {
    GI_IfaceSlot  iface;
    volatile LONG ref_count;
    HANDLE        wait_event;
} GI_DispatcherImpl;

#define GI_HISTORY_CAPACITY              64
#define GI_MAX_CALLBACKS                 64
#define GI_MAX_DISPATCHERS               16
#define GI_CALLBACK_QUEUE_CAP            256
#define GI_DISCONNECTED_PROBE_BACKOFF_MS 1500ull
#define GI_DESKTOP_CACHE_TTL_US          2000ull

typedef struct GI_VkMapEntry {
    uint32_t scan_code;
    uint32_t code_point;
} GI_VkMapEntry;

static INIT_ONCE     g_vk_table_once = INIT_ONCE_STATIC_INIT;
static GI_VkMapEntry g_vk_table[256];

static BOOL CALLBACK gi_init_vk_table_once(PINIT_ONCE once, PVOID param, PVOID *ctx) {
    (void)once;
    (void)param;
    (void)ctx;
    for (uint32_t vk = 0; vk < 256; vk++) {
        UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
        if (scan == 0) scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
        UINT ch = MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) & 0x7FFFFFFFu;
        g_vk_table[vk].scan_code  = (uint32_t)scan;
        g_vk_table[vk].code_point = (uint32_t)ch;
    }
    return TRUE;
}

static inline void gi_ensure_vk_table(void) {
    InitOnceExecuteOnce(&g_vk_table_once, gi_init_vk_table_once, NULL, NULL);
}

typedef struct GI_CallbackSlot {
    bool                   active;
    bool                   stopped;
    bool                   unregistering;
    uint32_t               in_flight;
    DWORD                  running_tid;
    GameInputCallbackToken token;
    GI_ApiVer              api_ver;
    uint32_t               cb_type; /* 1=reading, 2=device, 3=system/guide, 4=kblayout */
    GI_DeviceImpl         *device_filter;
    GameInputKind          kind_filter;
    GameInputDeviceStatus  status_filter;
    void                  *callback_fn;
    void                  *context;
} GI_CallbackSlot;

typedef struct GI_PendingCallbackItem {
    uint32_t               cb_type; /* 1=reading, 2=device */
    GI_ApiVer              api_ver;
    GameInputCallbackToken token;
    void                  *callback_fn;
    void                  *context;
    struct GI_ReadingImpl *reading;
    GI_DeviceImpl         *device;
    uint64_t               timestamp;
    GameInputDeviceStatus  current_status;
    GameInputDeviceStatus  previous_status;
} GI_PendingCallbackItem;

typedef struct GI_ManagerImpl {
    GI_IfaceSlot           v0_iface;
    GI_IfaceSlot           v1_iface;
    GI_IfaceSlot           v2_iface;
    volatile LONG          ref_count;
    SRWLOCK                lock;
    CONDITION_VARIABLE     cb_cv;
    volatile LONG          focus_policy;
    uint64_t               next_sequence;
    volatile LONGLONG      next_token;
    uint64_t               cached_input_ts_us;
    bool                   cached_input_valid;
    bool                   cached_focused;
    BYTE                   cached_kb_state[256];
    POINT                  cached_cursor_pt;
    bool                   has_prev_cursor_pt;
    POINT                  prev_cursor_pt;
    int64_t                fallback_mouse_x;
    int64_t                fallback_mouse_y;
    GI_DeviceImpl          devices[GI_DEV_COUNT];
    GI_ReadingImpl        *history[GI_HISTORY_CAPACITY];
    size_t                 history_count;
    size_t                 history_head; /* index of oldest or ring cursor */
    GI_CallbackSlot        callbacks[GI_MAX_CALLBACKS];
    GI_DispatcherImpl     *dispatchers[GI_MAX_DISPATCHERS];
    GI_PendingCallbackItem cb_queue[GI_CALLBACK_QUEUE_CAP];
    size_t                 cb_queue_head;
    size_t                 cb_queue_count;
} GI_ManagerImpl;

static INIT_ONCE      g_mgr_once = INIT_ONCE_STATIC_INIT;
static volatile LONG  g_mgr_ready = 0;
static volatile LONG  g_live_dispatchers = 0;
static GI_ManagerImpl g_mgr;

/* -------------------------------------------------------------------------
 * Raw Mouse WM_INPUT Sink Thread (Unclamped Relative Mickeys + Wheel Deltas)
 * ------------------------------------------------------------------------- */
#ifndef RIDEV_INPUTSINK
#define RIDEV_INPUTSINK 0x00000100
#endif
#ifndef RID_INPUT
#define RID_INPUT 0x10000003
#endif
#ifndef RIM_TYPEMOUSE
#define RIM_TYPEMOUSE 0
#endif
#ifndef MOUSE_MOVE_ABSOLUTE
#define MOUSE_MOVE_ABSOLUTE 0x01
#endif
#ifndef RI_MOUSE_WHEEL
#define RI_MOUSE_WHEEL 0x0400
#endif
#ifndef RI_MOUSE_HWHEEL
#define RI_MOUSE_HWHEEL 0x0800
#endif

static INIT_ONCE         g_raw_mouse_once   = INIT_ONCE_STATIC_INIT;
static volatile LONG     g_raw_mouse_active = 0;
static volatile LONGLONG g_raw_mouse_x      = 0;
static volatile LONGLONG g_raw_mouse_y      = 0;
static volatile LONGLONG g_raw_wheel_x      = 0;
static volatile LONGLONG g_raw_wheel_y      = 0;

static bool gi_is_process_focused(GameInputFocusPolicy policy);

static LRESULT CALLBACK gi_raw_mouse_wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
    if (msg == WM_INPUT) {
        GameInputFocusPolicy pol = (GameInputFocusPolicy)InterlockedCompareExchange(&g_mgr.focus_policy, 0, 0);
        if (gi_is_process_focused(pol)) {
            BYTE stack_buf[128];
            UINT sz = (UINT)sizeof(stack_buf);
            if (GetRawInputData((HRAWINPUT)lparam, RID_INPUT, stack_buf, &sz, sizeof(RAWINPUTHEADER)) != (UINT)-1) {
                const RAWINPUT *ri = (const RAWINPUT *)(const void *)stack_buf;
                if (ri->header.dwType == RIM_TYPEMOUSE) {
                    if ((ri->data.mouse.usFlags & MOUSE_MOVE_ABSOLUTE) == 0) {
                        if (ri->data.mouse.lLastX != 0) {
                            InterlockedExchangeAdd64(&g_raw_mouse_x, (LONGLONG)ri->data.mouse.lLastX);
                        }
                        if (ri->data.mouse.lLastY != 0) {
                            InterlockedExchangeAdd64(&g_raw_mouse_y, (LONGLONG)ri->data.mouse.lLastY);
                        }
                    }
                    if ((ri->data.mouse.usButtonFlags & RI_MOUSE_WHEEL) != 0) {
                        SHORT delta = (SHORT)ri->data.mouse.usButtonData;
                        if (delta != 0) {
                            InterlockedExchangeAdd64(&g_raw_wheel_y, (LONGLONG)delta);
                        }
                    }
                    if ((ri->data.mouse.usButtonFlags & RI_MOUSE_HWHEEL) != 0) {
                        SHORT delta = (SHORT)ri->data.mouse.usButtonData;
                        if (delta != 0) {
                            InterlockedExchangeAdd64(&g_raw_wheel_x, (LONGLONG)delta);
                        }
                    }
                }
            }
        }
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wparam, lparam);
}

static DWORD WINAPI gi_raw_mouse_thread_proc(LPVOID param) {
    HANDLE ready_evt = (HANDLE)param;
    HINSTANCE hinst = GetModuleHandleW(NULL);
    static const wchar_t k_cls_name[] = L"OneLauncherGameInputRawMouseSink";

    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = gi_raw_mouse_wndproc;
    wc.hInstance     = hinst;
    wc.lpszClassName = k_cls_name;
    (void)RegisterClassExW(&wc);

    HWND hwnd = CreateWindowExW(
        0, k_cls_name, L"", 0, 0, 0, 0, 0,
        HWND_MESSAGE, NULL, hinst, NULL);
    if (hwnd) {
        RAWINPUTDEVICE rid;
        memset(&rid, 0, sizeof(rid));
        rid.usUsagePage = 0x0001; /* HID_USAGE_PAGE_GENERIC */
        rid.usUsage     = 0x0002; /* HID_USAGE_GENERIC_MOUSE */
        rid.dwFlags     = RIDEV_INPUTSINK;
        rid.hwndTarget  = hwnd;
        if (RegisterRawInputDevices(&rid, 1, sizeof(rid))) {
            InterlockedExchange(&g_raw_mouse_active, 1);
        } else {
            DestroyWindow(hwnd);
            hwnd = NULL;
        }
    }

    if (ready_evt) {
        SetEvent(ready_evt);
    }
    if (!hwnd) {
        return 0;
    }

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}

static BOOL CALLBACK gi_init_raw_mouse_once(PINIT_ONCE once, PVOID param, PVOID *ctx) {
    (void)once;
    (void)param;
    (void)ctx;

    HANDLE ready_evt = CreateEventW(NULL, TRUE, FALSE, NULL);
    HANDLE th = CreateThread(NULL, 0, gi_raw_mouse_thread_proc, ready_evt, 0, NULL);
    if (th) {
        if (ready_evt) {
            (void)WaitForSingleObject(ready_evt, 150);
        }
        CloseHandle(th);
    }
    if (ready_evt) {
        CloseHandle(ready_evt);
    }
    return TRUE;
}

static inline void gi_ensure_raw_mouse(void) {
    InitOnceExecuteOnce(&g_raw_mouse_once, gi_init_raw_mouse_once, NULL, NULL);
}

static bool gi_probe_xinput_slot(GI_DeviceImpl *dev, GI_XINPUT_STATE *out_state, bool *out_changed) {
    if (out_changed) *out_changed = false;
    if (!dev || dev->xinput_slot < 0) return false;

    bool was_connected = dev->connected;
    uint64_t now_ms = (uint64_t)GetTickCount64();
    uint64_t next_ms = (uint64_t)InterlockedCompareExchange64(&dev->next_probe_tick_ms, 0, 0);
    if (!dev->connected && now_ms < next_ms) {
        return false;
    }

    gi_ensure_xinput();
    if (!g_pfn_XInputGetState) {
        dev->connected = false;
        if (was_connected && out_changed) *out_changed = true;
        InterlockedExchange64(
            &dev->next_probe_tick_ms,
            (LONGLONG)(now_ms + GI_DISCONNECTED_PROBE_BACKOFF_MS));
        return false;
    }

    GI_XINPUT_STATE local_xst;
    GI_XINPUT_STATE *dst = out_state ? out_state : &local_xst;
    memset(dst, 0, sizeof(*dst));
    if (g_pfn_XInputGetState((DWORD)dev->xinput_slot, dst) != ERROR_SUCCESS) {
        dev->connected = false;
        if (was_connected && out_changed) *out_changed = true;
        InterlockedExchange64(
            &dev->next_probe_tick_ms,
            (LONGLONG)(now_ms + GI_DISCONNECTED_PROBE_BACKOFF_MS));
        return false;
    }

    dev->connected = true;
    if (!was_connected && out_changed) *out_changed = true;
    InterlockedExchange64(&dev->next_probe_tick_ms, 0);
    return true;
}

/* Static descriptor tables shared across devices */
static const GI_String g_lang_en_us = { 5, 5, "en-US" };

static const GI_KeyboardInfo_v0 g_kb_info_v0 = {
    0,      /* GameInputAnsiKeyboard */
    0x0409, /* US English */
    104,
    12,
    16,
    4,
    0,
    &g_lang_en_us
};

static const GI_KeyboardInfo_v1 g_kb_info_v1 = {
    0,
    0x0409,
    104,
    12,
    16,
    4,
    0
};

static const GI_MouseInfo_v0 g_mouse_info_v0 = {
    GI_MouseLeftButton | GI_MouseRightButton | GI_MouseMiddleButton | GI_MouseButton4 | GI_MouseButton5,
    1000,
    800,
    true,
    true
};

static const GI_MouseInfo_v1 g_mouse_info_v1 = {
    GI_MouseLeftButton | GI_MouseRightButton | GI_MouseMiddleButton | GI_MouseButton4 | GI_MouseButton5,
    1000,
    true,
    true
};

static const GI_GamepadInfo g_gamepad_info = {
    4,  /* XboxMenu */
    5,  /* XboxView */
    7,  /* XboxA */
    8,  /* XboxB */
    9,  /* XboxX */
    10, /* XboxY */
    11, /* XboxDPadUp */
    12, /* XboxDPadDown */
    13, /* XboxDPadLeft */
    14, /* XboxDPadRight */
    15, /* XboxLeftShoulder */
    18, /* XboxRightShoulder */
    17, /* XboxLeftStickButton */
    20  /* XboxRightStickButton */
};

static const GI_ControllerAxisInfo_v0 g_axis_info_v0[GI_CONTROLLER_AXIS_COUNT] = {
    { GI_KindGamepad, 17, true, false, false, true, 0.0f, 65535ull, 0, 0, 0, NULL, NULL }, /* LeftStickX */
    { GI_KindGamepad, 17, true, false, false, true, 0.0f, 65535ull, 1, 1, 0, NULL, NULL }, /* LeftStickY */
    { GI_KindGamepad, 20, true, false, false, true, 0.0f, 65535ull, 2, 2, 0, NULL, NULL }, /* RightStickX */
    { GI_KindGamepad, 20, true, false, false, true, 0.0f, 65535ull, 3, 3, 0, NULL, NULL }, /* RightStickY */
    { GI_KindGamepad, 16, true, false, false, true, 0.0f,   255ull, 4, 4, 0, NULL, NULL }, /* LeftTrigger */
    { GI_KindGamepad, 19, true, false, false, true, 0.0f,   255ull, 5, 5, 0, NULL, NULL }  /* RightTrigger */
};

static const GI_ControllerAxisInfo_v1 g_axis_info_v1[GI_CONTROLLER_AXIS_COUNT] = {
    { GI_KindGamepad, 17, true, false, false, true, 0.0f, 65535ull, 0, 0 },
    { GI_KindGamepad, 17, true, false, false, true, 0.0f, 65535ull, 1, 1 },
    { GI_KindGamepad, 20, true, false, false, true, 0.0f, 65535ull, 2, 2 },
    { GI_KindGamepad, 20, true, false, false, true, 0.0f, 65535ull, 3, 3 },
    { GI_KindGamepad, 16, true, false, false, true, 0.0f,   255ull, 4, 4 },
    { GI_KindGamepad, 19, true, false, false, true, 0.0f,   255ull, 5, 5 }
};

static const GI_ControllerButtonInfo_v0 g_button_info_v0[GI_CONTROLLER_BTN_COUNT] = {
    { GI_KindGamepad | GI_KindUiNavigation,  7,  0,  0, 0, NULL, NULL }, /* XboxA */
    { GI_KindGamepad | GI_KindUiNavigation,  8,  1,  1, 0, NULL, NULL }, /* XboxB */
    { GI_KindGamepad,                        9,  2,  2, 0, NULL, NULL }, /* XboxX */
    { GI_KindGamepad,                       10,  3,  3, 0, NULL, NULL }, /* XboxY */
    { GI_KindGamepad | GI_KindUiNavigation, 15,  4,  4, 0, NULL, NULL }, /* XboxLeftShoulder */
    { GI_KindGamepad | GI_KindUiNavigation, 18,  5,  5, 0, NULL, NULL }, /* XboxRightShoulder */
    { GI_KindGamepad | GI_KindUiNavigation,  4,  6,  6, 0, NULL, NULL }, /* XboxMenu */
    { GI_KindGamepad | GI_KindUiNavigation,  5,  7,  7, 0, NULL, NULL }, /* XboxView */
    { GI_KindGamepad,                       17,  8,  8, 0, NULL, NULL }, /* XboxLeftStickButton */
    { GI_KindGamepad,                       20,  9,  9, 0, NULL, NULL }, /* XboxRightStickButton */
    { GI_KindGamepad | GI_KindUiNavigation, 11, 10, 10, 0, NULL, NULL }, /* XboxDPadUp */
    { GI_KindGamepad | GI_KindUiNavigation, 12, 11, 11, 0, NULL, NULL }, /* XboxDPadDown */
    { GI_KindGamepad | GI_KindUiNavigation, 13, 12, 12, 0, NULL, NULL }, /* XboxDPadLeft */
    { GI_KindGamepad | GI_KindUiNavigation, 14, 13, 13, 0, NULL, NULL }  /* XboxDPadRight */
};

static const GI_ControllerButtonInfo_v1 g_button_info_v1[GI_CONTROLLER_BTN_COUNT] = {
    { GI_KindGamepad | GI_KindUiNavigation,  7,  0,  0 },
    { GI_KindGamepad | GI_KindUiNavigation,  8,  1,  1 },
    { GI_KindGamepad,                        9,  2,  2 },
    { GI_KindGamepad,                       10,  3,  3 },
    { GI_KindGamepad | GI_KindUiNavigation, 15,  4,  4 },
    { GI_KindGamepad | GI_KindUiNavigation, 18,  5,  5 },
    { GI_KindGamepad | GI_KindUiNavigation,  4,  6,  6 },
    { GI_KindGamepad | GI_KindUiNavigation,  5,  7,  7 },
    { GI_KindGamepad,                       17,  8,  8 },
    { GI_KindGamepad,                       20,  9,  9 },
    { GI_KindGamepad | GI_KindUiNavigation, 11, 10, 10 },
    { GI_KindGamepad | GI_KindUiNavigation, 12, 11, 11 },
    { GI_KindGamepad | GI_KindUiNavigation, 13, 12, 12 },
    { GI_KindGamepad | GI_KindUiNavigation, 14, 13, 13 }
};

static const GI_ControllerSwitchInfo_v0 g_switch_info_v0[1] = {
    {
        GI_KindGamepad | GI_KindUiNavigation,
        0, /* GameInputLabelNone */
        { 0, 11, 0, 14, 0, 12, 0, 13, 0 },
        2, /* GameInput8WaySwitch */
        0,
        0,
        0,
        NULL,
        NULL
    }
};

static const GI_ControllerSwitchInfo_v1 g_switch_info_v1[1] = {
    {
        GI_KindGamepad | GI_KindUiNavigation,
        0,
        { 0, 11, 0, 14, 0, 12, 0, 13, 0 },
        2, /* GameInput8WaySwitch */
        0,
        0
    }
};

static const GI_UiNavigationInfo g_gamepad_ui_nav_info = {
    GI_UiNavMenu | GI_UiNavView | GI_UiNavAccept | GI_UiNavCancel |
        GI_UiNavUp | GI_UiNavDown | GI_UiNavLeft | GI_UiNavRight |
        GI_UiNavPageLeft | GI_UiNavPageRight,
    4,  /* menuLabel = XboxMenu */
    5,  /* viewLabel = XboxView */
    7,  /* acceptLabel = XboxA */
    8,  /* cancelLabel = XboxB */
    11, /* upLabel = XboxDPadUp */
    12, /* downLabel = XboxDPadDown */
    13, /* leftLabel = XboxDPadLeft */
    14, /* rightLabel = XboxDPadRight */
    0, 0, 0, 0,
    0, 0,
    15, /* pageLeftLabel = XboxLeftShoulder */
    18, /* pageRightLabel = XboxRightShoulder */
    0, 0, 0, 0
};

static const GI_UiNavigationInfo g_kb_ui_nav_info = {
    GI_UiNavMenu | GI_UiNavView | GI_UiNavAccept | GI_UiNavCancel |
        GI_UiNavUp | GI_UiNavDown | GI_UiNavLeft | GI_UiNavRight,
    99,  /* Menu */
    100, /* View */
    74,  /* ArrowReturn */
    101, /* Back */
    61,  /* ArrowUp */
    65,  /* ArrowDown */
    67,  /* ArrowLeft */
    63,  /* ArrowRight */
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0
};

/* Helper to recover GI_DeviceImpl* from ANY caller-supplied IGameInputDevice* (v0, v1, or v2) */
static GI_DeviceImpl *gi_resolve_device_ptr(void *raw_iface) {
    if (!raw_iface) return NULL;
    for (size_t i = 0; i < GI_DEV_COUNT; i++) {
        GI_DeviceImpl *dev = &g_mgr.devices[i];
        if (raw_iface == (void *)&dev->v0_iface ||
            raw_iface == (void *)&dev->v1_iface ||
            raw_iface == (void *)&dev->v2_iface) {
            return dev;
        }
    }
    return NULL;
}

static void *gi_device_iface_for_ver(GI_DeviceImpl *dev, GI_ApiVer ver) {
    if (!dev) return NULL;
    InterlockedIncrement(&dev->ref_count);
    switch (ver) {
        case GI_VER_0: return &dev->v0_iface;
        case GI_VER_1: return &dev->v1_iface;
        case GI_VER_2: return &dev->v2_iface;
        default:       return &dev->v0_iface;
    }
}

/* -------------------------------------------------------------------------
 * IGameInputDispatcher Implementation
 * ------------------------------------------------------------------------- */
static bool gi_drain_callbacks_outside_lock(uint64_t quota_us, bool poll_devices_first);

static inline GI_DispatcherImpl *gi_disp_from_iface(void *iface) {
    return (GI_DispatcherImpl *)((uint8_t *)iface - offsetof(GI_DispatcherImpl, iface));
}

static HRESULT WINAPI gi_disp_QueryInterface(void *iface, REFIID riid, void **ppv) {
    GI_DispatcherImpl *self = gi_disp_from_iface(iface);
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!riid) return E_INVALIDARG;
    if (gi_guid_eq(riid, &GI_IID_IUnknown) || gi_guid_eq(riid, &GI_IID_IGameInputDispatcher)) {
        InterlockedIncrement(&self->ref_count);
        *ppv = &self->iface;
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG WINAPI gi_disp_AddRef(void *iface) {
    GI_DispatcherImpl *self = gi_disp_from_iface(iface);
    return (ULONG)InterlockedIncrement(&self->ref_count);
}

static ULONG WINAPI gi_disp_Release(void *iface) {
    GI_DispatcherImpl *self = gi_disp_from_iface(iface);
    LONG ref = InterlockedDecrement(&self->ref_count);
    if (ref <= 0) {
        AcquireSRWLockExclusive(&g_mgr.lock);
        for (size_t i = 0; i < GI_MAX_DISPATCHERS; i++) {
            if (g_mgr.dispatchers[i] == self) {
                g_mgr.dispatchers[i] = NULL;
                break;
            }
        }
        ReleaseSRWLockExclusive(&g_mgr.lock);

        if (self->wait_event) {
            CloseHandle(self->wait_event);
            self->wait_event = NULL;
        }
        HeapFree(GetProcessHeap(), 0, self);
        InterlockedDecrement(&g_live_dispatchers);
        return 0;
    }
    return (ULONG)ref;
}

static bool WINAPI gi_disp_Dispatch(void *iface, uint64_t quota_us) {
    (void)iface;
    return gi_drain_callbacks_outside_lock(quota_us, true);
}

static HRESULT WINAPI gi_disp_OpenWaitHandle(void *iface, HANDLE *out_handle) {
    GI_DispatcherImpl *self = gi_disp_from_iface(iface);
    if (!out_handle) return E_POINTER;
    *out_handle = NULL;
    if (!self->wait_event) return E_FAIL;
    HANDLE dup = NULL;
    if (!DuplicateHandle(GetCurrentProcess(), self->wait_event,
                         GetCurrentProcess(), &dup,
                         0, FALSE, DUPLICATE_SAME_ACCESS)) {
        return HRESULT_FROM_WIN32(GetLastError());
    }
    *out_handle = dup;
    return S_OK;
}

static const void *const g_disp_vtbl[] = {
    (const void *)gi_disp_QueryInterface,
    (const void *)gi_disp_AddRef,
    (const void *)gi_disp_Release,
    (const void *)gi_disp_Dispatch,
    (const void *)gi_disp_OpenWaitHandle
};

/* -------------------------------------------------------------------------
 * IGameInputDevice Implementation (v0, v1, v2)
 * ------------------------------------------------------------------------- */
static GI_DeviceImpl *gi_dev_from_any(void *iface) {
    GI_DeviceImpl *dev = gi_resolve_device_ptr(iface);
    return dev;
}

static HRESULT WINAPI gi_dev_QueryInterface(void *iface, REFIID riid, void **ppv) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!riid || !dev) return E_INVALIDARG;

    if (gi_guid_eq(riid, &GI_IID_IUnknown)) {
        InterlockedIncrement(&dev->ref_count);
        *ppv = iface;
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInputDevice_v0)) {
        *ppv = gi_device_iface_for_ver(dev, GI_VER_0);
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInputDevice_v1)) {
        *ppv = gi_device_iface_for_ver(dev, GI_VER_1);
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInputDevice_v2)) {
        *ppv = gi_device_iface_for_ver(dev, GI_VER_2);
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG WINAPI gi_dev_AddRef(void *iface) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    if (!dev) return 1;
    return (ULONG)InterlockedIncrement(&dev->ref_count);
}

static ULONG WINAPI gi_dev_Release(void *iface) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    if (!dev) return 0;
    LONG r = InterlockedDecrement(&dev->ref_count);
    if (r < 1) {
        InterlockedExchange(&dev->ref_count, 1);
        return 1;
    }
    return (ULONG)r;
}

static const GI_DeviceInfo_v0 *WINAPI gi_dev_v0_GetDeviceInfo(void *iface) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    return dev ? &dev->info_v0 : NULL;
}

static HRESULT WINAPI gi_dev_v1_GetDeviceInfo(void *iface, const GI_DeviceInfo_v1 **out_info) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    if (!out_info) return E_POINTER;
    if (!dev) {
        *out_info = NULL;
        return E_INVALIDARG;
    }
    *out_info = &dev->info_v1;
    return S_OK;
}

static HRESULT WINAPI gi_dev_v2_GetDeviceInfo(void *iface, const GI_DeviceInfo_v2 **out_info) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    if (!out_info) return E_POINTER;
    if (!dev) {
        *out_info = NULL;
        return E_INVALIDARG;
    }
    *out_info = &dev->info_v2;
    return S_OK;
}

static HRESULT WINAPI gi_dev_v2_GetHapticInfo(void *iface, void *out_haptic) {
    (void)iface;
    if (!out_haptic) return E_POINTER;
    return GI_E_HAPTIC_INFO_NOT_FOUND;
}

static GameInputDeviceStatus gi_device_status_value(const GI_DeviceImpl *dev, GI_ApiVer ver) {
    if (!dev || !dev->connected) return GI_DeviceNoStatus;
    if (ver == GI_VER_0) {
        return GI_DeviceConnected | GI_DeviceInputEnabled;
    }
    return GI_DeviceConnected;
}

static GameInputDeviceStatus WINAPI gi_dev_GetDeviceStatus(void *iface) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    if (!dev) return GI_DeviceNoStatus;
    if (dev->xinput_slot >= 0) {
        (void)gi_probe_xinput_slot(dev, NULL, NULL);
    }
    GI_ApiVer ver = (iface == (void *)&dev->v0_iface) ? GI_VER_0 : GI_VER_1;
    return gi_device_status_value(dev, ver);
}

static void WINAPI gi_dev_v0_GetBatteryState(void *iface, GI_BatteryState *state) {
    (void)iface;
    if (state) {
        memset(state, 0, sizeof(*state));
        state->status = 0; /* GameInputBatteryNotPresent */
    }
}

static HRESULT WINAPI gi_dev_CreateForceFeedbackEffect(void *iface, uint32_t motor, const void *params, void **effect) {
    (void)iface;
    (void)motor;
    (void)params;
    if (effect) *effect = NULL;
    return GI_E_FEEDBACK_NOT_SUPPORTED;
}

static bool WINAPI gi_dev_IsForceFeedbackMotorPoweredOn(void *iface, uint32_t motor) {
    (void)iface;
    (void)motor;
    return false;
}

static void WINAPI gi_dev_SetForceFeedbackMotorGain(void *iface, uint32_t motor, float gain) {
    (void)iface;
    (void)motor;
    (void)gain;
}

static HRESULT WINAPI gi_dev_v0_SetHapticMotorState(void *iface, uint32_t motor, const void *params) {
    (void)iface;
    (void)motor;
    (void)params;
    return GI_E_FEEDBACK_NOT_SUPPORTED;
}

static float gi_clamp01(float v) {
    if (v < 0.0f) return 0.0f;
    if (v > 1.0f) return 1.0f;
    return v;
}

static void WINAPI gi_dev_SetRumbleState(void *iface, const GI_RumbleParams *params) {
    GI_DeviceImpl *dev = gi_dev_from_any(iface);
    if (!dev || dev->xinput_slot < 0) return;
    gi_ensure_xinput();
    if (!g_pfn_XInputSetState) return;

    GI_XINPUT_VIBRATION vib;
    if (!params) {
        vib.wLeftMotorSpeed = 0;
        vib.wRightMotorSpeed = 0;
    } else {
        vib.wLeftMotorSpeed  = (WORD)(gi_clamp01(params->lowFrequency) * 65535.0f);
        vib.wRightMotorSpeed = (WORD)(gi_clamp01(params->highFrequency) * 65535.0f);
    }
    g_pfn_XInputSetState((DWORD)dev->xinput_slot, &vib);
}

static void WINAPI gi_dev_v0_SetInputSynchronizationState(void *iface, bool enabled) {
    (void)iface;
    (void)enabled;
}

static void WINAPI gi_dev_v0_SendInputSynchronizationHint(void *iface) {
    (void)iface;
}

static void WINAPI gi_dev_v0_PowerOff(void *iface) {
    (void)iface;
}

static HRESULT WINAPI gi_dev_v0_CreateRawDeviceReport(void *iface, uint32_t id, int32_t kind, void **report) {
    (void)iface;
    (void)id;
    (void)kind;
    if (report) *report = NULL;
    return E_NOTIMPL;
}

static HRESULT WINAPI gi_dev_v0_GetRawDeviceFeature(void *iface, uint32_t id, void **report) {
    (void)iface;
    (void)id;
    if (report) *report = NULL;
    return E_NOTIMPL;
}

static HRESULT WINAPI gi_dev_v0_SetRawDeviceFeature(void *iface, void *report) {
    (void)iface;
    (void)report;
    return E_NOTIMPL;
}

static HRESULT WINAPI gi_dev_v0_SendRawDeviceOutput(void *iface, void *report) {
    (void)iface;
    (void)report;
    return E_NOTIMPL;
}

static HRESULT WINAPI gi_dev_v0_SendRawDeviceOutputWithResponse(void *iface, void *req, void **resp) {
    (void)iface;
    (void)req;
    if (resp) *resp = NULL;
    return E_NOTIMPL;
}

static HRESULT WINAPI gi_dev_v0_ExecuteRawDeviceIoControl(void *iface, uint32_t code, size_t in_sz, const void *in_buf, size_t out_sz, void *out_buf, size_t *written) {
    (void)iface;
    (void)code;
    (void)in_sz;
    (void)in_buf;
    (void)out_sz;
    (void)out_buf;
    if (written) *written = 0;
    return E_NOTIMPL;
}

static bool WINAPI gi_dev_v0_AcquireExclusiveRawDeviceAccess(void *iface, uint64_t timeout_us) {
    (void)iface;
    (void)timeout_us;
    return false;
}

static void WINAPI gi_dev_v0_ReleaseExclusiveRawDeviceAccess(void *iface) {
    (void)iface;
}

static HRESULT WINAPI gi_dev_v2_DirectInputEscape(void *iface, uint32_t cmd, const void *in_buf, uint32_t in_sz, void *out_buf, uint32_t out_sz, uint32_t *written) {
    (void)iface;
    (void)cmd;
    (void)in_buf;
    (void)in_sz;
    (void)out_buf;
    (void)out_sz;
    if (written) *written = 0;
    return E_NOTIMPL;
}

static const void *const g_dev_v0_vtbl[] = {
    (const void *)gi_dev_QueryInterface,
    (const void *)gi_dev_AddRef,
    (const void *)gi_dev_Release,
    (const void *)gi_dev_v0_GetDeviceInfo,
    (const void *)gi_dev_GetDeviceStatus,
    (const void *)gi_dev_v0_GetBatteryState,
    (const void *)gi_dev_CreateForceFeedbackEffect,
    (const void *)gi_dev_IsForceFeedbackMotorPoweredOn,
    (const void *)gi_dev_SetForceFeedbackMotorGain,
    (const void *)gi_dev_v0_SetHapticMotorState,
    (const void *)gi_dev_SetRumbleState,
    (const void *)gi_dev_v0_SetInputSynchronizationState,
    (const void *)gi_dev_v0_SendInputSynchronizationHint,
    (const void *)gi_dev_v0_PowerOff,
    (const void *)gi_dev_v0_CreateRawDeviceReport,
    (const void *)gi_dev_v0_GetRawDeviceFeature,
    (const void *)gi_dev_v0_SetRawDeviceFeature,
    (const void *)gi_dev_v0_SendRawDeviceOutput,
    (const void *)gi_dev_v0_SendRawDeviceOutputWithResponse,
    (const void *)gi_dev_v0_ExecuteRawDeviceIoControl,
    (const void *)gi_dev_v0_AcquireExclusiveRawDeviceAccess,
    (const void *)gi_dev_v0_ReleaseExclusiveRawDeviceAccess
};

static const void *const g_dev_v1_vtbl[] = {
    (const void *)gi_dev_QueryInterface,
    (const void *)gi_dev_AddRef,
    (const void *)gi_dev_Release,
    (const void *)gi_dev_v1_GetDeviceInfo,
    (const void *)gi_dev_GetDeviceStatus,
    (const void *)gi_dev_CreateForceFeedbackEffect,
    (const void *)gi_dev_IsForceFeedbackMotorPoweredOn,
    (const void *)gi_dev_SetForceFeedbackMotorGain,
    (const void *)gi_dev_SetRumbleState
};

static const void *const g_dev_v2_vtbl[] = {
    (const void *)gi_dev_QueryInterface,
    (const void *)gi_dev_AddRef,
    (const void *)gi_dev_Release,
    (const void *)gi_dev_v2_GetDeviceInfo,
    (const void *)gi_dev_v2_GetHapticInfo,
    (const void *)gi_dev_GetDeviceStatus,
    (const void *)gi_dev_CreateForceFeedbackEffect,
    (const void *)gi_dev_IsForceFeedbackMotorPoweredOn,
    (const void *)gi_dev_SetForceFeedbackMotorGain,
    (const void *)gi_dev_SetRumbleState,
    (const void *)gi_dev_v2_DirectInputEscape
};

/* -------------------------------------------------------------------------
 * IGameInputReading Implementation (v0, v1, v2)
 * ------------------------------------------------------------------------- */
static const void *const g_reading_v0_vtbl[];
static const void *const g_reading_v1_vtbl[];
static const void *const g_reading_v2_vtbl[];

static GI_ReadingImpl *gi_reading_from_any(void *iface, GI_ApiVer *out_ver) {
    if (!iface) return NULL;
    const void *vtbl = *(const void *const *)iface;
    if (vtbl == (const void *)g_reading_v0_vtbl) {
        if (out_ver) *out_ver = GI_VER_0;
        return (GI_ReadingImpl *)((uint8_t *)iface - offsetof(GI_ReadingImpl, v0_iface));
    }
    if (vtbl == (const void *)g_reading_v1_vtbl) {
        if (out_ver) *out_ver = GI_VER_1;
        return (GI_ReadingImpl *)((uint8_t *)iface - offsetof(GI_ReadingImpl, v1_iface));
    }
    if (vtbl == (const void *)g_reading_v2_vtbl) {
        if (out_ver) *out_ver = GI_VER_2;
        return (GI_ReadingImpl *)((uint8_t *)iface - offsetof(GI_ReadingImpl, v2_iface));
    }
    return NULL;
}

static void *gi_reading_iface_for_ver(GI_ReadingImpl *r, GI_ApiVer ver) {
    if (!r) return NULL;
    InterlockedIncrement(&r->ref_count);
    switch (ver) {
        case GI_VER_0: return &r->v0_iface;
        case GI_VER_1: return &r->v1_iface;
        case GI_VER_2: return &r->v2_iface;
        default:       return &r->v0_iface;
    }
}

static HRESULT WINAPI gi_reading_QueryInterface(void *iface, REFIID riid, void **ppv) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!riid || !r) return E_INVALIDARG;

    if (gi_guid_eq(riid, &GI_IID_IUnknown)) {
        InterlockedIncrement(&r->ref_count);
        *ppv = iface;
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInputReading_v0)) {
        *ppv = gi_reading_iface_for_ver(r, GI_VER_0);
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInputReading_v1)) {
        *ppv = gi_reading_iface_for_ver(r, GI_VER_1);
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInputReading_v2)) {
        *ppv = gi_reading_iface_for_ver(r, GI_VER_2);
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG WINAPI gi_reading_AddRef(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r) return 0;
    return (ULONG)InterlockedIncrement(&r->ref_count);
}

static ULONG WINAPI gi_reading_Release(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r) return 0;
    LONG c = InterlockedDecrement(&r->ref_count);
    if (c <= 0) {
        HeapFree(GetProcessHeap(), 0, r);
        return 0;
    }
    return (ULONG)c;
}

static GameInputKind WINAPI gi_reading_GetInputKind(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    return r ? r->snap.kind : GI_KindUnknown;
}

static uint64_t WINAPI gi_reading_v0_GetSequenceNumber(void *iface, GameInputKind kind) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r) return 0;
    if (kind != GI_KindUnknown && (r->snap.kind & kind) == 0) return 0;
    return r->snap.sequence;
}

static uint64_t WINAPI gi_reading_GetTimestamp(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    return r ? r->snap.timestamp : 0;
}

static void WINAPI gi_reading_GetDevice(void *iface, void **out_device) {
    GI_ApiVer ver = GI_VER_0;
    GI_ReadingImpl *r = gi_reading_from_any(iface, &ver);
    if (!out_device) return;
    if (!r || !r->snap.device) {
        *out_device = NULL;
        return;
    }
    *out_device = gi_device_iface_for_ver(r->snap.device, ver);
}

static bool WINAPI gi_reading_v0_GetRawReport(void *iface, void **out_report) {
    (void)iface;
    if (out_report) *out_report = NULL;
    return false;
}

static uint32_t WINAPI gi_reading_GetControllerAxisCount(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    return r ? r->snap.axis_count : 0;
}

static uint32_t WINAPI gi_reading_GetControllerAxisState(void *iface, uint32_t count, float *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || count == 0) return 0;
    uint32_t n = count < r->snap.axis_count ? count : r->snap.axis_count;
    if (n > 0) memcpy(state, r->snap.axes, n * sizeof(float));
    return n;
}

static uint32_t WINAPI gi_reading_GetControllerButtonCount(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    return r ? r->snap.button_count : 0;
}

static uint32_t WINAPI gi_reading_GetControllerButtonState(void *iface, uint32_t count, bool *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || count == 0) return 0;
    uint32_t n = count < r->snap.button_count ? count : r->snap.button_count;
    if (n > 0) memcpy(state, r->snap.buttons, n * sizeof(bool));
    return n;
}

static uint32_t WINAPI gi_reading_GetControllerSwitchCount(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    return r ? r->snap.switch_count : 0;
}

static uint32_t WINAPI gi_reading_GetControllerSwitchState(void *iface, uint32_t count, GameInputSwitchPosition *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || count == 0 || r->snap.switch_count == 0) return 0;
    state[0] = r->snap.hat_switch;
    return 1;
}

static uint32_t WINAPI gi_reading_GetKeyCount(void *iface) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    return r ? r->snap.key_count : 0;
}

static uint32_t WINAPI gi_reading_GetKeyState(void *iface, uint32_t count, GI_KeyState *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || count == 0) return 0;
    uint32_t n = count < r->snap.key_count ? count : r->snap.key_count;
    if (n > 0) memcpy(state, r->snap.keys, n * sizeof(GI_KeyState));
    return n;
}

static bool WINAPI gi_reading_v0_GetMouseState(void *iface, GI_MouseState_v0 *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || (r->snap.kind & GI_KindMouse) == 0) {
        if (state) memset(state, 0, sizeof(*state));
        return false;
    }
    state->buttons   = r->snap.mouse.buttons;
    state->positionX = r->snap.mouse.positionX;
    state->positionY = r->snap.mouse.positionY;
    state->wheelX    = r->snap.mouse.wheelX;
    state->wheelY    = r->snap.mouse.wheelY;
    return true;
}

static bool WINAPI gi_reading_v1_GetMouseState(void *iface, GI_MouseState_v1 *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || (r->snap.kind & GI_KindMouse) == 0) {
        if (state) memset(state, 0, sizeof(*state));
        return false;
    }
    *state = r->snap.mouse;
    return true;
}

static uint32_t WINAPI gi_reading_v0_GetTouchCount(void *iface) {
    (void)iface;
    return 0;
}

static uint32_t WINAPI gi_reading_v0_GetTouchState(void *iface, uint32_t count, void *state) {
    (void)iface;
    (void)count;
    (void)state;
    return 0;
}

static bool WINAPI gi_reading_v0_GetMotionState(void *iface, void *state) {
    (void)iface;
    (void)state;
    return false;
}

static bool WINAPI gi_reading_v2_GetSensorsState(void *iface, void *state) {
    (void)iface;
    (void)state;
    return false;
}

static bool WINAPI gi_reading_GetArcadeStickState(void *iface, void *state) {
    (void)iface;
    (void)state;
    return false;
}

static bool WINAPI gi_reading_GetFlightStickState(void *iface, void *state) {
    (void)iface;
    (void)state;
    return false;
}

static bool WINAPI gi_reading_GetGamepadState(void *iface, GI_GamepadState *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || (r->snap.kind & GI_KindGamepad) == 0) {
        if (state) memset(state, 0, sizeof(*state));
        return false;
    }
    *state = r->snap.gamepad;
    return true;
}

static bool WINAPI gi_reading_GetRacingWheelState(void *iface, void *state) {
    (void)iface;
    (void)state;
    return false;
}

static bool WINAPI gi_reading_GetUiNavigationState(void *iface, GI_UiNavigationState *state) {
    GI_ReadingImpl *r = gi_reading_from_any(iface, NULL);
    if (!r || !state || (r->snap.kind & GI_KindUiNavigation) == 0) {
        if (state) memset(state, 0, sizeof(*state));
        return false;
    }
    *state = r->snap.ui_nav;
    return true;
}

static const void *const g_reading_v0_vtbl[] = {
    (const void *)gi_reading_QueryInterface,
    (const void *)gi_reading_AddRef,
    (const void *)gi_reading_Release,
    (const void *)gi_reading_GetInputKind,
    (const void *)gi_reading_v0_GetSequenceNumber,
    (const void *)gi_reading_GetTimestamp,
    (const void *)gi_reading_GetDevice,
    (const void *)gi_reading_v0_GetRawReport,
    (const void *)gi_reading_GetControllerAxisCount,
    (const void *)gi_reading_GetControllerAxisState,
    (const void *)gi_reading_GetControllerButtonCount,
    (const void *)gi_reading_GetControllerButtonState,
    (const void *)gi_reading_GetControllerSwitchCount,
    (const void *)gi_reading_GetControllerSwitchState,
    (const void *)gi_reading_GetKeyCount,
    (const void *)gi_reading_GetKeyState,
    (const void *)gi_reading_v0_GetMouseState,
    (const void *)gi_reading_v0_GetTouchCount,
    (const void *)gi_reading_v0_GetTouchState,
    (const void *)gi_reading_v0_GetMotionState,
    (const void *)gi_reading_GetArcadeStickState,
    (const void *)gi_reading_GetFlightStickState,
    (const void *)gi_reading_GetGamepadState,
    (const void *)gi_reading_GetRacingWheelState,
    (const void *)gi_reading_GetUiNavigationState
};

static const void *const g_reading_v1_vtbl[] = {
    (const void *)gi_reading_QueryInterface,
    (const void *)gi_reading_AddRef,
    (const void *)gi_reading_Release,
    (const void *)gi_reading_GetInputKind,
    (const void *)gi_reading_GetTimestamp,
    (const void *)gi_reading_GetDevice,
    (const void *)gi_reading_GetControllerAxisCount,
    (const void *)gi_reading_GetControllerAxisState,
    (const void *)gi_reading_GetControllerButtonCount,
    (const void *)gi_reading_GetControllerButtonState,
    (const void *)gi_reading_GetControllerSwitchCount,
    (const void *)gi_reading_GetControllerSwitchState,
    (const void *)gi_reading_GetKeyCount,
    (const void *)gi_reading_GetKeyState,
    (const void *)gi_reading_v1_GetMouseState,
    (const void *)gi_reading_GetArcadeStickState,
    (const void *)gi_reading_GetFlightStickState,
    (const void *)gi_reading_GetGamepadState,
    (const void *)gi_reading_GetRacingWheelState,
    (const void *)gi_reading_GetUiNavigationState
};

static const void *const g_reading_v2_vtbl[] = {
    (const void *)gi_reading_QueryInterface,
    (const void *)gi_reading_AddRef,
    (const void *)gi_reading_Release,
    (const void *)gi_reading_GetInputKind,
    (const void *)gi_reading_GetTimestamp,
    (const void *)gi_reading_GetDevice,
    (const void *)gi_reading_GetControllerAxisCount,
    (const void *)gi_reading_GetControllerAxisState,
    (const void *)gi_reading_GetControllerButtonCount,
    (const void *)gi_reading_GetControllerButtonState,
    (const void *)gi_reading_GetControllerSwitchCount,
    (const void *)gi_reading_GetControllerSwitchState,
    (const void *)gi_reading_GetKeyCount,
    (const void *)gi_reading_GetKeyState,
    (const void *)gi_reading_v1_GetMouseState,
    (const void *)gi_reading_v2_GetSensorsState,
    (const void *)gi_reading_GetArcadeStickState,
    (const void *)gi_reading_GetFlightStickState,
    (const void *)gi_reading_GetGamepadState,
    (const void *)gi_reading_GetRacingWheelState,
    (const void *)gi_reading_GetUiNavigationState
};

/* -------------------------------------------------------------------------
 * Live Hardware State Synthesis (Keyboard, Mouse, XInput Slots 0..3)
 * ------------------------------------------------------------------------- */
static float gi_normalize_thumb(SHORT v) {
    float f = (v < 0) ? ((float)v / 32768.0f) : ((float)v / 32767.0f);
    if (f < -1.0f) f = -1.0f;
    if (f >  1.0f) f =  1.0f;
    return f;
}

static bool gi_is_process_focused(GameInputFocusPolicy policy) {
    if ((policy & GI_EnableBackgroundInput) != 0 &&
        (policy & GI_DisableBackgroundInput) == 0) {
        return true;
    }
    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    DWORD fg_pid = 0;
    GetWindowThreadProcessId(fg, &fg_pid);
    return (fg_pid != 0 && fg_pid == GetCurrentProcessId());
}

static bool gi_poll_gamepad_snapshot(GI_DeviceImpl *dev, bool focused, GI_ReadingSnapshot *out, bool *out_conn_changed) {
    if (out_conn_changed) *out_conn_changed = false;
    if (!dev || dev->xinput_slot < 0) return false;

    GI_XINPUT_STATE xst;
    if (!gi_probe_xinput_slot(dev, &xst, out_conn_changed)) {
        return false;
    }

    memset(out, 0, sizeof(*out));
    out->device       = dev;
    out->kind         = GI_KindGamepad | GI_KindControllerAxis | GI_KindControllerButton |
                        GI_KindControllerSwitch | GI_KindUiNavigation;
    out->axis_count   = GI_CONTROLLER_AXIS_COUNT;
    out->button_count = GI_CONTROLLER_BTN_COUNT;
    out->switch_count = 1;
    out->hat_switch   = GI_SwitchCenter;

    if (!focused) {
        return true;
    }

    WORD xb = xst.Gamepad.wButtons;
    GameInputGamepadButtons gbtn = GI_GamepadNone;
    GameInputUiNavigationButtons unav = GI_UiNavNone;

    if (xb & GI_XINPUT_GAMEPAD_START)          { gbtn |= GI_GamepadMenu;            unav |= GI_UiNavMenu; }
    if (xb & GI_XINPUT_GAMEPAD_BACK)           { gbtn |= GI_GamepadView;            unav |= GI_UiNavView; }
    if (xb & GI_XINPUT_GAMEPAD_A)              { gbtn |= GI_GamepadA;               unav |= GI_UiNavAccept; }
    if (xb & GI_XINPUT_GAMEPAD_B)              { gbtn |= GI_GamepadB;               unav |= GI_UiNavCancel; }
    if (xb & GI_XINPUT_GAMEPAD_X)              { gbtn |= GI_GamepadX; }
    if (xb & GI_XINPUT_GAMEPAD_Y)              { gbtn |= GI_GamepadY; }
    if (xb & GI_XINPUT_GAMEPAD_DPAD_UP)        { gbtn |= GI_GamepadDPadUp;          unav |= GI_UiNavUp; }
    if (xb & GI_XINPUT_GAMEPAD_DPAD_DOWN)      { gbtn |= GI_GamepadDPadDown;        unav |= GI_UiNavDown; }
    if (xb & GI_XINPUT_GAMEPAD_DPAD_LEFT)      { gbtn |= GI_GamepadDPadLeft;        unav |= GI_UiNavLeft; }
    if (xb & GI_XINPUT_GAMEPAD_DPAD_RIGHT)     { gbtn |= GI_GamepadDPadRight;       unav |= GI_UiNavRight; }
    if (xb & GI_XINPUT_GAMEPAD_LEFT_SHOULDER)  { gbtn |= GI_GamepadLeftShoulder;    unav |= GI_UiNavPageLeft; }
    if (xb & GI_XINPUT_GAMEPAD_RIGHT_SHOULDER) { gbtn |= GI_GamepadRightShoulder;   unav |= GI_UiNavPageRight; }
    if (xb & GI_XINPUT_GAMEPAD_LEFT_THUMB)     { gbtn |= GI_GamepadLeftThumbstick; }
    if (xb & GI_XINPUT_GAMEPAD_RIGHT_THUMB)    { gbtn |= GI_GamepadRightThumbstick; }

    out->gamepad.buttons          = gbtn;
    out->gamepad.leftTrigger      = (float)xst.Gamepad.bLeftTrigger  / 255.0f;
    out->gamepad.rightTrigger     = (float)xst.Gamepad.bRightTrigger / 255.0f;
    out->gamepad.leftThumbstickX  = gi_normalize_thumb(xst.Gamepad.sThumbLX);
    out->gamepad.leftThumbstickY  = gi_normalize_thumb(xst.Gamepad.sThumbLY);
    out->gamepad.rightThumbstickX = gi_normalize_thumb(xst.Gamepad.sThumbRX);
    out->gamepad.rightThumbstickY = gi_normalize_thumb(xst.Gamepad.sThumbRY);
    out->ui_nav.buttons           = unav;

    out->axes[0] = out->gamepad.leftThumbstickX;
    out->axes[1] = out->gamepad.leftThumbstickY;
    out->axes[2] = out->gamepad.rightThumbstickX;
    out->axes[3] = out->gamepad.rightThumbstickY;
    out->axes[4] = out->gamepad.leftTrigger;
    out->axes[5] = out->gamepad.rightTrigger;

    out->buttons[0]  = (gbtn & GI_GamepadA) != 0;
    out->buttons[1]  = (gbtn & GI_GamepadB) != 0;
    out->buttons[2]  = (gbtn & GI_GamepadX) != 0;
    out->buttons[3]  = (gbtn & GI_GamepadY) != 0;
    out->buttons[4]  = (gbtn & GI_GamepadLeftShoulder) != 0;
    out->buttons[5]  = (gbtn & GI_GamepadRightShoulder) != 0;
    out->buttons[6]  = (gbtn & GI_GamepadMenu) != 0;
    out->buttons[7]  = (gbtn & GI_GamepadView) != 0;
    out->buttons[8]  = (gbtn & GI_GamepadLeftThumbstick) != 0;
    out->buttons[9]  = (gbtn & GI_GamepadRightThumbstick) != 0;
    out->buttons[10] = (gbtn & GI_GamepadDPadUp) != 0;
    out->buttons[11] = (gbtn & GI_GamepadDPadDown) != 0;
    out->buttons[12] = (gbtn & GI_GamepadDPadLeft) != 0;
    out->buttons[13] = (gbtn & GI_GamepadDPadRight) != 0;

    bool u = (xb & GI_XINPUT_GAMEPAD_DPAD_UP) != 0;
    bool d = (xb & GI_XINPUT_GAMEPAD_DPAD_DOWN) != 0;
    bool l = (xb & GI_XINPUT_GAMEPAD_DPAD_LEFT) != 0;
    bool r = (xb & GI_XINPUT_GAMEPAD_DPAD_RIGHT) != 0;
    if (u && r)      out->hat_switch = GI_SwitchUpRight;
    else if (u && l) out->hat_switch = GI_SwitchUpLeft;
    else if (d && r) out->hat_switch = GI_SwitchDownRight;
    else if (d && l) out->hat_switch = GI_SwitchDownLeft;
    else if (u)      out->hat_switch = GI_SwitchUp;
    else if (r)      out->hat_switch = GI_SwitchRight;
    else if (d)      out->hat_switch = GI_SwitchDown;
    else if (l)      out->hat_switch = GI_SwitchLeft;
    else             out->hat_switch = GI_SwitchCenter;

    return true;
}

static bool gi_poll_keyboard_snapshot(GI_DeviceImpl *dev, bool focused, GI_ReadingSnapshot *out) {
    memset(out, 0, sizeof(*out));
    out->device = dev;
    out->kind   = GI_KindKeyboard | GI_KindUiNavigation;

    if (!focused) {
        return true;
    }

    gi_ensure_vk_table();

    uint32_t count = 0;
    GameInputUiNavigationButtons unav = GI_UiNavNone;

    for (uint32_t vk = 0x08; vk <= 0xFE && count < GI_MAX_ACTIVE_KEYS; vk++) {
        /* Skip mouse buttons & generic shift/ctrl/menu duplicates */
        if (vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU) continue;
        if (vk == VK_LBUTTON || vk == VK_RBUTTON || vk == VK_MBUTTON ||
            vk == VK_XBUTTON1 || vk == VK_XBUTTON2) continue;

        if ((g_mgr.cached_kb_state[vk] & 0x80u) == 0) continue;

        out->keys[count].scanCode   = g_vk_table[vk].scan_code;
        out->keys[count].codePoint  = g_vk_table[vk].code_point;
        out->keys[count].virtualKey = (uint8_t)vk;
        out->keys[count].isDeadKey  = false;
        count++;

        if (vk == VK_RETURN || vk == VK_SPACE) unav |= GI_UiNavAccept;
        if (vk == VK_ESCAPE)                   unav |= GI_UiNavCancel | GI_UiNavMenu;
        if (vk == VK_TAB)                      unav |= GI_UiNavView;
        if (vk == VK_UP)                       unav |= GI_UiNavUp;
        if (vk == VK_DOWN)                     unav |= GI_UiNavDown;
        if (vk == VK_LEFT)                     unav |= GI_UiNavLeft;
        if (vk == VK_RIGHT)                    unav |= GI_UiNavRight;
    }

    out->key_count      = count;
    out->ui_nav.buttons = unav;
    return true;
}

static bool gi_poll_mouse_snapshot(GI_DeviceImpl *dev, bool focused, GI_ReadingSnapshot *out) {
    memset(out, 0, sizeof(*out));
    out->device = dev;
    out->kind   = GI_KindMouse;

    gi_ensure_raw_mouse();

    POINT pt = { 0, 0 };
    if (focused) {
        pt = g_mgr.cached_cursor_pt;
    } else if (dev && dev->current_reading) {
        pt.x = (LONG)dev->current_reading->snap.mouse.absolutePositionX;
        pt.y = (LONG)dev->current_reading->snap.mouse.absolutePositionY;
    } else {
        pt = g_mgr.cached_cursor_pt;
    }

    int64_t rel_x = 0;
    int64_t rel_y = 0;
    int64_t wheel_x = 0;
    int64_t wheel_y = 0;

    if (InterlockedCompareExchange(&g_raw_mouse_active, 0, 0) != 0) {
        rel_x   = (int64_t)InterlockedCompareExchange64(&g_raw_mouse_x, 0, 0);
        rel_y   = (int64_t)InterlockedCompareExchange64(&g_raw_mouse_y, 0, 0);
        wheel_x = (int64_t)InterlockedCompareExchange64(&g_raw_wheel_x, 0, 0);
        wheel_y = (int64_t)InterlockedCompareExchange64(&g_raw_wheel_y, 0, 0);
    } else {
        if (focused) {
            if (g_mgr.has_prev_cursor_pt) {
                g_mgr.fallback_mouse_x += (int64_t)(pt.x - g_mgr.prev_cursor_pt.x);
                g_mgr.fallback_mouse_y += (int64_t)(pt.y - g_mgr.prev_cursor_pt.y);
            }
            g_mgr.prev_cursor_pt     = pt;
            g_mgr.has_prev_cursor_pt = true;
        } else {
            g_mgr.has_prev_cursor_pt = false;
        }
        rel_x   = g_mgr.fallback_mouse_x;
        rel_y   = g_mgr.fallback_mouse_y;
        wheel_x = 0;
        wheel_y = 0;
    }

    GameInputMouseButtons btns = GI_MouseNone;
    if (focused) {
        if (g_mgr.cached_kb_state[VK_LBUTTON]  & 0x80u) btns |= GI_MouseLeftButton;
        if (g_mgr.cached_kb_state[VK_RBUTTON]  & 0x80u) btns |= GI_MouseRightButton;
        if (g_mgr.cached_kb_state[VK_MBUTTON]  & 0x80u) btns |= GI_MouseMiddleButton;
        if (g_mgr.cached_kb_state[VK_XBUTTON1] & 0x80u) btns |= GI_MouseButton4;
        if (g_mgr.cached_kb_state[VK_XBUTTON2] & 0x80u) btns |= GI_MouseButton5;
    }

    out->mouse.buttons           = btns;
    out->mouse.positions         = GI_MouseAbsolutePosition | GI_MouseRelativePosition;
    out->mouse.positionX         = rel_x;
    out->mouse.positionY         = rel_y;
    out->mouse.absolutePositionX = (int64_t)pt.x;
    out->mouse.absolutePositionY = (int64_t)pt.y;
    out->mouse.wheelX            = wheel_x;
    out->mouse.wheelY            = wheel_y;
    return true;
}

static bool gi_snapshots_equal(const GI_ReadingSnapshot *a, const GI_ReadingSnapshot *b) {
    if (a->device != b->device || a->kind != b->kind) return false;
    if (a->key_count != b->key_count) return false;
    if (a->key_count > 0 && memcmp(a->keys, b->keys, a->key_count * sizeof(GI_KeyState)) != 0) {
        return false;
    }
    if (memcmp(&a->mouse, &b->mouse, sizeof(a->mouse)) != 0) return false;
    if (memcmp(&a->gamepad, &b->gamepad, sizeof(a->gamepad)) != 0) return false;
    if (a->ui_nav.buttons != b->ui_nav.buttons) return false;
    return true;
}

static bool gi_absf_gt(float v, float thresh) {
    return (v > thresh) || (v < -thresh);
}

static bool gi_snapshot_has_active_input(const GI_ReadingSnapshot *s, GameInputKind kind_mask) {
    if (!s) return false;
    GameInputKind eff = (kind_mask == GI_KindUnknown) ? s->kind : (s->kind & kind_mask);
    if ((eff & GI_KindKeyboard) != 0 && s->key_count > 0) return true;
    if ((eff & GI_KindUiNavigation) != 0 && s->ui_nav.buttons != GI_UiNavNone) return true;
    if ((eff & (GI_KindGamepad | GI_KindControllerButton)) != 0 && s->gamepad.buttons != GI_GamepadNone) {
        return true;
    }
    if ((eff & (GI_KindGamepad | GI_KindControllerSwitch)) != 0 && s->hat_switch != GI_SwitchCenter) {
        return true;
    }
    if ((eff & (GI_KindGamepad | GI_KindControllerAxis)) != 0) {
        if (s->gamepad.leftTrigger > 0.12f || s->gamepad.rightTrigger > 0.12f ||
            gi_absf_gt(s->gamepad.leftThumbstickX, 0.24f) ||
            gi_absf_gt(s->gamepad.leftThumbstickY, 0.24f) ||
            gi_absf_gt(s->gamepad.rightThumbstickX, 0.24f) ||
            gi_absf_gt(s->gamepad.rightThumbstickY, 0.24f)) {
            return true;
        }
    }
    if ((eff & GI_KindMouse) != 0 && s->mouse.buttons != GI_MouseNone) {
        return true;
    }
    return false;
}

static bool gi_snapshot_is_neutral(const GI_ReadingSnapshot *s) {
    return !gi_snapshot_has_active_input(s, GI_KindUnknown);
}

/* -------------------------------------------------------------------------
 * Callback Queue & Background Worker Infrastructure
 * ------------------------------------------------------------------------- */
typedef void (WINAPI *PFN_GI_ReadingCallback_v0)(
    GameInputCallbackToken token,
    void *context,
    void *reading,
    bool has_overrun_occurred);

typedef void (WINAPI *PFN_GI_ReadingCallback_v1)(
    GameInputCallbackToken token,
    void *context,
    void *reading);

typedef void (WINAPI *PFN_GI_DeviceCallback)(
    GameInputCallbackToken token,
    void *context,
    void *device,
    uint64_t timestamp,
    GameInputDeviceStatus current_status,
    GameInputDeviceStatus previous_status);

static void gi_release_pending_cb_item(GI_PendingCallbackItem *item) {
    if (!item) return;
    if (item->reading) {
        gi_reading_Release(&item->reading->v0_iface);
        item->reading = NULL;
    }
    if (item->device) {
        gi_dev_Release(&item->device->v0_iface);
        item->device = NULL;
    }
}

static void gi_signal_dispatchers_locked(bool signaled) {
    for (size_t i = 0; i < GI_MAX_DISPATCHERS; i++) {
        GI_DispatcherImpl *d = g_mgr.dispatchers[i];
        if (d && d->wait_event) {
            if (signaled) {
                SetEvent(d->wait_event);
            } else {
                ResetEvent(d->wait_event);
            }
        }
    }
}

static void gi_enqueue_cb_item_locked(const GI_PendingCallbackItem *item) {
    if (!item || !item->callback_fn) return;

    GI_PendingCallbackItem copy = *item;
    if (copy.reading) {
        InterlockedIncrement(&copy.reading->ref_count);
    }
    if (copy.device) {
        InterlockedIncrement(&copy.device->ref_count);
    }

    if (g_mgr.cb_queue_count < GI_CALLBACK_QUEUE_CAP) {
        size_t idx = (g_mgr.cb_queue_head + g_mgr.cb_queue_count) % GI_CALLBACK_QUEUE_CAP;
        g_mgr.cb_queue[idx] = copy;
        g_mgr.cb_queue_count++;
    } else {
        GI_PendingCallbackItem evicted = g_mgr.cb_queue[g_mgr.cb_queue_head];
        g_mgr.cb_queue[g_mgr.cb_queue_head] = copy;
        g_mgr.cb_queue_head = (g_mgr.cb_queue_head + 1) % GI_CALLBACK_QUEUE_CAP;
        gi_release_pending_cb_item(&evicted);
    }

    gi_signal_dispatchers_locked(true);
}

static void gi_enqueue_reading_callbacks_locked(GI_ReadingImpl *node) {
    if (!node || !node->snap.device) return;
    GI_DeviceImpl *dev = node->snap.device;

    for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
        const GI_CallbackSlot *slot = &g_mgr.callbacks[i];
        if (!slot->active || slot->stopped || slot->unregistering || slot->cb_type != 1) {
            continue;
        }
        if (slot->device_filter &&
            slot->device_filter->dev_type != GI_DEV_AGGREGATE &&
            slot->device_filter != dev) {
            continue;
        }
        if (slot->kind_filter != GI_KindUnknown && (node->snap.kind & slot->kind_filter) == 0) {
            continue;
        }

        GI_PendingCallbackItem item;
        memset(&item, 0, sizeof(item));
        item.cb_type     = 1;
        item.api_ver     = slot->api_ver;
        item.token       = slot->token;
        item.callback_fn = slot->callback_fn;
        item.context     = slot->context;
        item.reading     = node;
        gi_enqueue_cb_item_locked(&item);
    }
}

static void gi_enqueue_device_callbacks_locked(GI_DeviceImpl *dev, bool now_connected) {
    if (!dev) return;
    uint64_t ts = gi_get_timestamp_us();

    for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
        const GI_CallbackSlot *slot = &g_mgr.callbacks[i];
        if (!slot->active || slot->stopped || slot->unregistering || slot->cb_type != 2) {
            continue;
        }
        if (slot->device_filter &&
            slot->device_filter->dev_type != GI_DEV_AGGREGATE &&
            slot->device_filter != dev) {
            continue;
        }
        if (slot->kind_filter != GI_KindUnknown &&
            (dev->info_v1.supportedInput & slot->kind_filter) == 0) {
            continue;
        }

        GameInputDeviceStatus cur_st = now_connected
            ? ((slot->api_ver == GI_VER_0) ? (GI_DeviceConnected | GI_DeviceInputEnabled) : GI_DeviceConnected)
            : GI_DeviceNoStatus;
        GameInputDeviceStatus prev_st = (!now_connected)
            ? ((slot->api_ver == GI_VER_0) ? (GI_DeviceConnected | GI_DeviceInputEnabled) : GI_DeviceConnected)
            : GI_DeviceNoStatus;

        if (slot->status_filter != 0 && ((cur_st | prev_st) & slot->status_filter) == 0) {
            continue;
        }

        GI_PendingCallbackItem item;
        memset(&item, 0, sizeof(item));
        item.cb_type         = 2;
        item.api_ver         = slot->api_ver;
        item.token           = slot->token;
        item.callback_fn     = slot->callback_fn;
        item.context         = slot->context;
        item.device          = dev;
        item.timestamp       = ts;
        item.current_status  = cur_st;
        item.previous_status = prev_st;
        gi_enqueue_cb_item_locked(&item);
    }
}

/* Must be called with g_mgr.lock held exclusively */
static GI_ReadingImpl *gi_alloc_reading_node_locked(const GI_ReadingSnapshot *fresh) {
    GI_ReadingImpl *node = (GI_ReadingImpl *)HeapAlloc(
        GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(GI_ReadingImpl));
    if (!node) return NULL;
    node->v0_iface.lpVtbl = g_reading_v0_vtbl;
    node->v1_iface.lpVtbl = g_reading_v1_vtbl;
    node->v2_iface.lpVtbl = g_reading_v2_vtbl;
    node->ref_count       = 1;
    node->snap            = *fresh;
    node->snap.sequence   = ++g_mgr.next_sequence;
    node->snap.timestamp  = gi_get_timestamp_us();
    return node;
}

/* Must be called with g_mgr.lock held exclusively */
static void gi_push_history_node_locked(GI_ReadingImpl *node) {
    if (!node) return;
    InterlockedIncrement(&node->ref_count); /* History ring ownership ref */
    if (g_mgr.history_count < GI_HISTORY_CAPACITY) {
        size_t slot = (g_mgr.history_head + g_mgr.history_count) % GI_HISTORY_CAPACITY;
        g_mgr.history[slot] = node;
        g_mgr.history_count++;
    } else {
        GI_ReadingImpl *evicted = g_mgr.history[g_mgr.history_head];
        g_mgr.history[g_mgr.history_head] = node;
        g_mgr.history_head = (g_mgr.history_head + 1) % GI_HISTORY_CAPACITY;
        if (evicted) {
            gi_reading_Release(&evicted->v0_iface);
        }
    }
}

/* Must be called with g_mgr.lock held exclusively */
static GI_ReadingImpl *gi_record_or_reuse_snapshot_locked(const GI_ReadingSnapshot *fresh) {
    GI_DeviceImpl *dev = fresh ? fresh->device : NULL;
    if (!dev) return NULL;

    if (!dev->has_last_snapshot || !dev->current_reading) {
        GI_ReadingImpl *initial = gi_alloc_reading_node_locked(fresh);
        if (!initial) return NULL;
        if (dev->current_reading) {
            gi_reading_Release(&dev->current_reading->v0_iface);
        }
        dev->current_reading   = initial; /* Device owns initial ref_count == 1 */
        dev->has_last_snapshot = true;
        /* Only push to global history on initial observation if non-neutral! */
        if (!gi_snapshot_is_neutral(&initial->snap)) {
            gi_push_history_node_locked(initial);
            gi_enqueue_reading_callbacks_locked(initial);
        }
        return initial;
    }

    if (gi_snapshots_equal(&dev->current_reading->snap, fresh)) {
        return dev->current_reading;
    }

    GI_ReadingImpl *node = gi_alloc_reading_node_locked(fresh);
    if (!node) return dev->current_reading;

    gi_reading_Release(&dev->current_reading->v0_iface);
    dev->current_reading   = node; /* Device owns ref_count == 1 */
    dev->has_last_snapshot = true;
    gi_push_history_node_locked(node);
    gi_enqueue_reading_callbacks_locked(node);
    return node;
}

/* Must be called with g_mgr.lock held exclusively */
static GI_ReadingImpl *gi_find_latest_history_locked(GI_DeviceImpl *dev, GameInputKind kind_mask) {
    if (dev) {
        for (size_t i = 0; i < g_mgr.history_count; i++) {
            size_t idx = (g_mgr.history_head + g_mgr.history_count - 1 - i) % GI_HISTORY_CAPACITY;
            GI_ReadingImpl *cand = g_mgr.history[idx];
            if (!cand || cand->snap.device != dev) continue;
            if (kind_mask != GI_KindUnknown && (cand->snap.kind & kind_mask) == 0) continue;
            return cand;
        }
        if (dev->connected && dev->current_reading &&
            (kind_mask == GI_KindUnknown || (dev->current_reading->snap.kind & kind_mask) != 0)) {
            return dev->current_reading;
        }
        return NULL;
    }

    /* 1. System-wide query (dev == NULL): never let passive mouse motion or neutral
     *    snapshots shadow a connected device that currently has active buttons/keys/axes! */
    GI_ReadingImpl *best_active = NULL;
    for (size_t d = 0; d < GI_DEV_AGGREGATE; d++) {
        GI_DeviceImpl *cdev = &g_mgr.devices[d];
        if (!cdev->connected || !cdev->current_reading) continue;
        GI_ReadingImpl *cur = cdev->current_reading;
        if (kind_mask != GI_KindUnknown && (cur->snap.kind & kind_mask) == 0) continue;
        if (gi_snapshot_has_active_input(&cur->snap, kind_mask)) {
            if (!best_active || cur->snap.sequence > best_active->snap.sequence) {
                best_active = cur;
            }
        }
    }
    if (best_active) return best_active;

    /* 2. No device currently holds active input; prefer latest non-passive history entry
     *    when non-mouse kinds are requested, falling back to latest matching history entry. */
    GI_ReadingImpl *fallback_hist = NULL;
    for (size_t i = 0; i < g_mgr.history_count; i++) {
        size_t idx = (g_mgr.history_head + g_mgr.history_count - 1 - i) % GI_HISTORY_CAPACITY;
        GI_ReadingImpl *cand = g_mgr.history[idx];
        if (!cand || !cand->snap.device || !cand->snap.device->connected) continue;
        if (kind_mask != GI_KindUnknown && (cand->snap.kind & kind_mask) == 0) continue;
        if (!fallback_hist) fallback_hist = cand;
        bool is_passive_mouse = (cand->snap.device->dev_type == GI_DEV_MOUSE) &&
                                (cand->snap.mouse.buttons == GI_MouseNone);
        if (!is_passive_mouse || (kind_mask & ~GI_KindMouse) == 0) {
            return cand;
        }
    }
    if (fallback_hist) return fallback_hist;

    /* 3. Idle baseline fallback (no transitions recorded in history yet): prefer connected
     *    gamepads 0..3, then keyboard, then mouse. */
    static const GI_InternalDevType order[6] = {
        GI_DEV_GAMEPAD_0, GI_DEV_GAMEPAD_1, GI_DEV_GAMEPAD_2, GI_DEV_GAMEPAD_3,
        GI_DEV_KEYBOARD, GI_DEV_MOUSE
    };
    for (size_t k = 0; k < 6; k++) {
        GI_DeviceImpl *cdev = &g_mgr.devices[order[k]];
        if (!cdev->connected || !cdev->current_reading) continue;
        if (kind_mask != GI_KindUnknown && (cdev->current_reading->snap.kind & kind_mask) == 0) continue;
        return cdev->current_reading;
    }
    return NULL;
}

/* Refresh 2 ms desktop focus, keyboard state, and cursor cache under g_mgr.lock */
static void gi_refresh_desktop_cache_locked(void) {
    uint64_t now_us = gi_get_timestamp_us();
    if (g_mgr.cached_input_valid &&
        now_us >= g_mgr.cached_input_ts_us &&
        (now_us - g_mgr.cached_input_ts_us) <= GI_DESKTOP_CACHE_TTL_US) {
        return;
    }

    GameInputFocusPolicy pol = (GameInputFocusPolicy)InterlockedCompareExchange(&g_mgr.focus_policy, 0, 0);
    bool focused = gi_is_process_focused(pol);
    g_mgr.cached_focused = focused;
    if (focused) {
        gi_ensure_vk_table();
        (void)GetKeyState(0);
        if (!GetKeyboardState(g_mgr.cached_kb_state)) {
            memset(g_mgr.cached_kb_state, 0, sizeof(g_mgr.cached_kb_state));
            for (uint32_t vk = 0x01; vk <= 0xFE; vk++) {
                if ((GetAsyncKeyState((int)vk) & 0x8000) != 0) {
                    g_mgr.cached_kb_state[vk] = 0x80u;
                }
            }
        }
    } else {
        memset(g_mgr.cached_kb_state, 0, sizeof(g_mgr.cached_kb_state));
    }
    if (!GetCursorPos(&g_mgr.cached_cursor_pt)) {
        g_mgr.cached_cursor_pt.x = 0;
        g_mgr.cached_cursor_pt.y = 0;
    }
    g_mgr.cached_input_ts_us = now_us;
    g_mgr.cached_input_valid = true;
}

/* Refresh live state for all matching devices under lock */
static void gi_refresh_matching_devices_locked(GameInputKind kind, GI_DeviceImpl *filter_dev) {
    GI_ReadingSnapshot snap;
    gi_refresh_desktop_cache_locked();
    bool focused = g_mgr.cached_focused;

    /* 1. XInput gamepads 0..3 */
    if ((kind & (GI_KindGamepad | GI_KindController | GI_KindUiNavigation)) != 0) {
        for (int s = 0; s < 4; s++) {
            GI_DeviceImpl *gdev = &g_mgr.devices[GI_DEV_GAMEPAD_0 + s];
            if (filter_dev && filter_dev != gdev) continue;
            bool conn_changed = false;
            bool ok = gi_poll_gamepad_snapshot(gdev, focused, &snap, &conn_changed);
            if (conn_changed) {
                gi_enqueue_device_callbacks_locked(gdev, gdev->connected);
            }
            if (ok) {
                (void)gi_record_or_reuse_snapshot_locked(&snap);
            }
        }
    }

    /* 2. Mouse */
    if ((kind & GI_KindMouse) != 0) {
        GI_DeviceImpl *mdev = &g_mgr.devices[GI_DEV_MOUSE];
        if (!filter_dev || filter_dev == mdev) {
            if (gi_poll_mouse_snapshot(mdev, focused, &snap)) {
                (void)gi_record_or_reuse_snapshot_locked(&snap);
            }
        }
    }

    /* 3. Keyboard */
    if ((kind & (GI_KindKeyboard | GI_KindUiNavigation)) != 0) {
        GI_DeviceImpl *kdev = &g_mgr.devices[GI_DEV_KEYBOARD];
        if (!filter_dev || filter_dev == kdev) {
            if (gi_poll_keyboard_snapshot(kdev, focused, &snap)) {
                (void)gi_record_or_reuse_snapshot_locked(&snap);
            }
        }
    }
}

static GI_CallbackSlot *gi_find_runnable_slot_locked(GameInputCallbackToken token) {
    if (token == 0) return NULL;
    for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
        GI_CallbackSlot *s = &g_mgr.callbacks[i];
        if (s->active && s->token == token && !s->stopped && !s->unregistering) {
            return s;
        }
    }
    return NULL;
}

/* Drain pending callbacks strictly OUTSIDE g_mgr.lock; returns true if more work remains */
static bool gi_drain_callbacks_outside_lock(uint64_t quota_us, bool poll_devices_first) {
    if (InterlockedCompareExchange(&g_mgr_ready, 0, 0) == 0) return false;

    if (poll_devices_first) {
        AcquireSRWLockExclusive(&g_mgr.lock);
        gi_refresh_matching_devices_locked(
            GI_KindGamepad | GI_KindController | GI_KindKeyboard | GI_KindMouse | GI_KindUiNavigation,
            NULL);
        ReleaseSRWLockExclusive(&g_mgr.lock);
    }

    uint64_t start_us = gi_get_timestamp_us();
    bool executed_any = false;

    for (;;) {
        if (executed_any) {
            uint64_t elapsed_us = gi_get_timestamp_us() - start_us;
            if (elapsed_us >= quota_us) {
                break;
            }
        }

        GI_PendingCallbackItem item;
        memset(&item, 0, sizeof(item));
        bool have_item = false;

        AcquireSRWLockExclusive(&g_mgr.lock);
        while (g_mgr.cb_queue_count > 0) {
            item = g_mgr.cb_queue[g_mgr.cb_queue_head];
            g_mgr.cb_queue_head = (g_mgr.cb_queue_head + 1) % GI_CALLBACK_QUEUE_CAP;
            g_mgr.cb_queue_count--;

            GI_CallbackSlot *slot = gi_find_runnable_slot_locked(item.token);
            if (!slot) {
                gi_release_pending_cb_item(&item);
                memset(&item, 0, sizeof(item));
                continue;
            }
            slot->in_flight++;
            slot->running_tid = GetCurrentThreadId();
            have_item = true;
            break;
        }
        if (g_mgr.cb_queue_count == 0) {
            gi_signal_dispatchers_locked(false);
        }
        ReleaseSRWLockExclusive(&g_mgr.lock);

        if (!have_item) {
            return false;
        }

        /* Invoke user callback strictly outside g_mgr.lock */
        if (item.cb_type == 1 && item.reading && item.callback_fn) {
            void *r_iface =
                (item.api_ver == GI_VER_0) ? (void *)&item.reading->v0_iface :
                (item.api_ver == GI_VER_1) ? (void *)&item.reading->v1_iface :
                                             (void *)&item.reading->v2_iface;
            if (item.api_ver == GI_VER_0) {
                ((PFN_GI_ReadingCallback_v0)item.callback_fn)(item.token, item.context, r_iface, false);
            } else {
                ((PFN_GI_ReadingCallback_v1)item.callback_fn)(item.token, item.context, r_iface);
            }
        } else if (item.cb_type == 2 && item.device && item.callback_fn) {
            void *d_iface =
                (item.api_ver == GI_VER_0) ? (void *)&item.device->v0_iface :
                (item.api_ver == GI_VER_1) ? (void *)&item.device->v1_iface :
                                             (void *)&item.device->v2_iface;
            ((PFN_GI_DeviceCallback)item.callback_fn)(
                item.token, item.context, d_iface, item.timestamp,
                item.current_status, item.previous_status);
        }

        gi_release_pending_cb_item(&item);

        AcquireSRWLockExclusive(&g_mgr.lock);
        for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
            GI_CallbackSlot *slot = &g_mgr.callbacks[i];
            if (slot->active && slot->token == item.token) {
                if (slot->in_flight > 0) {
                    slot->in_flight--;
                }
                if (slot->in_flight == 0) {
                    slot->running_tid = 0;
                    if (slot->unregistering) {
                        memset(slot, 0, sizeof(*slot));
                    }
                    WakeAllConditionVariable(&g_mgr.cb_cv);
                }
                break;
            }
        }
        ReleaseSRWLockExclusive(&g_mgr.lock);

        executed_any = true;
    }

    bool more_work = false;
    AcquireSRWLockShared(&g_mgr.lock);
    more_work = (g_mgr.cb_queue_count > 0);
    ReleaseSRWLockShared(&g_mgr.lock);
    return more_work;
}

static INIT_ONCE g_cb_worker_once  = INIT_ONCE_STATIC_INIT;
static HANDLE    g_cb_wake_event   = NULL;

static DWORD WINAPI gi_cb_worker_thread_proc(LPVOID param) {
    (void)param;
    for (;;) {
        GameInputKind active_kinds = GI_KindUnknown;
        bool any_active = false;

        AcquireSRWLockShared(&g_mgr.lock);
        for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
            const GI_CallbackSlot *s = &g_mgr.callbacks[i];
            if (s->active && !s->stopped && !s->unregistering && (s->cb_type == 1 || s->cb_type == 2)) {
                any_active = true;
                if (s->cb_type == 2) {
                    active_kinds |= GI_KindGamepad | GI_KindController | GI_KindUiNavigation;
                } else if (s->kind_filter == GI_KindUnknown) {
                    active_kinds |= GI_KindGamepad | GI_KindController | GI_KindKeyboard |
                                    GI_KindMouse | GI_KindUiNavigation;
                } else {
                    active_kinds |= s->kind_filter;
                }
            }
        }
        ReleaseSRWLockShared(&g_mgr.lock);

        if (!any_active) {
            if (g_cb_wake_event) {
                (void)WaitForSingleObject(g_cb_wake_event, INFINITE);
            } else {
                Sleep(50);
            }
            continue;
        }

        if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) > 0) {
            AcquireSRWLockExclusive(&g_mgr.lock);
            gi_refresh_matching_devices_locked(active_kinds, NULL);
            ReleaseSRWLockExclusive(&g_mgr.lock);
        } else {
            (void)gi_drain_callbacks_outside_lock(4000, true);
        }
        Sleep(8);
    }
}

static BOOL CALLBACK gi_init_cb_worker_once(PINIT_ONCE once, PVOID param, PVOID *ctx) {
    (void)once;
    (void)param;
    (void)ctx;

    g_cb_wake_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    HANDLE th = CreateThread(NULL, 0, gi_cb_worker_thread_proc, NULL, 0, NULL);
    if (th) {
        CloseHandle(th);
    }
    return TRUE;
}

static inline void gi_ensure_cb_worker(void) {
    InitOnceExecuteOnce(&g_cb_worker_once, gi_init_cb_worker_once, NULL, NULL);
    if (g_cb_wake_event) {
        SetEvent(g_cb_wake_event);
    }
}

/* -------------------------------------------------------------------------
 * IGameInput Implementation (v0, v1, v2)
 * ------------------------------------------------------------------------- */
static const void *const g_mgr_v0_vtbl[];
static const void *const g_mgr_v1_vtbl[];
static const void *const g_mgr_v2_vtbl[];

static GI_ApiVer gi_mgr_ver_from_iface(void *iface) {
    if (iface == (void *)&g_mgr.v1_iface) return GI_VER_1;
    if (iface == (void *)&g_mgr.v2_iface) return GI_VER_2;
    return GI_VER_0;
}

static HRESULT WINAPI gi_mgr_QueryInterface(void *iface, REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!riid) return E_INVALIDARG;

    if (gi_guid_eq(riid, &GI_IID_IUnknown)) {
        InterlockedIncrement(&g_mgr.ref_count);
        *ppv = iface;
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInput_v0)) {
        InterlockedIncrement(&g_mgr.ref_count);
        *ppv = &g_mgr.v0_iface;
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInput_v1)) {
        InterlockedIncrement(&g_mgr.ref_count);
        *ppv = &g_mgr.v1_iface;
        return S_OK;
    }
    if (gi_guid_eq(riid, &GI_IID_IGameInput_v2)) {
        InterlockedIncrement(&g_mgr.ref_count);
        *ppv = &g_mgr.v2_iface;
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG WINAPI gi_mgr_AddRef(void *iface) {
    (void)iface;
    return (ULONG)InterlockedIncrement(&g_mgr.ref_count);
}

static ULONG WINAPI gi_mgr_Release(void *iface) {
    (void)iface;
    LONG r = InterlockedDecrement(&g_mgr.ref_count);
    if (r < 0) {
        InterlockedExchange(&g_mgr.ref_count, 0);
        return 0;
    }
    return (ULONG)r;
}

static uint64_t WINAPI gi_mgr_GetCurrentTimestamp(void *iface) {
    (void)iface;
    return gi_get_timestamp_us();
}

static HRESULT WINAPI gi_mgr_GetCurrentReading(void *iface, GameInputKind kind, void *raw_device, void **out_reading) {
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    if (!out_reading) return E_POINTER;
    *out_reading = NULL;
    if (kind == GI_KindUnknown) return E_INVALIDARG;

    GI_DeviceImpl *filter_dev = NULL;
    if (raw_device) {
        filter_dev = gi_resolve_device_ptr(raw_device);
        if (!filter_dev) return GI_E_DEVICE_NOT_FOUND;
        if (filter_dev->dev_type == GI_DEV_AGGREGATE) {
            filter_dev = NULL;
        } else if ((filter_dev->info_v1.supportedInput & kind) == 0) {
            return GI_E_READING_NOT_FOUND;
        }
    }

    AcquireSRWLockExclusive(&g_mgr.lock);
    gi_refresh_matching_devices_locked(kind, filter_dev);

    if (filter_dev && !filter_dev->connected) {
        ReleaseSRWLockExclusive(&g_mgr.lock);
        if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) == 0) {
            (void)gi_drain_callbacks_outside_lock(2000, false);
        }
        return GI_E_DEVICE_DISCONNECTED;
    }

    GI_ReadingImpl *latest = gi_find_latest_history_locked(filter_dev, kind);
    if (!latest || (latest->snap.device && !latest->snap.device->connected)) {
        ReleaseSRWLockExclusive(&g_mgr.lock);
        if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) == 0) {
            (void)gi_drain_callbacks_outside_lock(2000, false);
        }
        return GI_E_READING_NOT_FOUND;
    }

    *out_reading = gi_reading_iface_for_ver(latest, ver);
    ReleaseSRWLockExclusive(&g_mgr.lock);
    if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) == 0) {
        (void)gi_drain_callbacks_outside_lock(2000, false);
    }
    return S_OK;
}

static HRESULT WINAPI gi_mgr_GetNextReading(void *iface, void *raw_ref, GameInputKind kind, void *raw_device, void **out_reading) {
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    if (!out_reading) return E_POINTER;
    *out_reading = NULL;
    if (!raw_ref || kind == GI_KindUnknown) return E_INVALIDARG;

    GI_ReadingImpl *ref = gi_reading_from_any(raw_ref, NULL);
    if (!ref) return E_INVALIDARG;

    GI_DeviceImpl *filter_dev = NULL;
    if (raw_device) {
        filter_dev = gi_resolve_device_ptr(raw_device);
        if (!filter_dev) return GI_E_DEVICE_NOT_FOUND;
        if (filter_dev->dev_type == GI_DEV_AGGREGATE) filter_dev = NULL;
    }

    AcquireSRWLockExclusive(&g_mgr.lock);
    gi_refresh_matching_devices_locked(kind, filter_dev);

    GI_ReadingImpl *found_next = NULL;
    bool ref_seen = false;
    for (size_t i = 0; i < g_mgr.history_count; i++) {
        size_t idx = (g_mgr.history_head + i) % GI_HISTORY_CAPACITY;
        GI_ReadingImpl *cand = g_mgr.history[idx];
        if (!cand) continue;
        if (cand->snap.sequence == ref->snap.sequence) {
            ref_seen = true;
            continue;
        }
        if (cand->snap.sequence > ref->snap.sequence) {
            if (filter_dev && cand->snap.device != filter_dev) continue;
            if ((cand->snap.kind & kind) == 0) continue;
            found_next = cand;
            break;
        }
    }

    if (!ref_seen && g_mgr.history_count > 0) {
        GI_ReadingImpl *oldest = g_mgr.history[g_mgr.history_head];
        if (oldest && ref->snap.sequence < oldest->snap.sequence) {
            ReleaseSRWLockExclusive(&g_mgr.lock);
            if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) == 0) {
                (void)gi_drain_callbacks_outside_lock(2000, false);
            }
            return GI_E_REFERENCE_READING_TOO_OLD;
        }
    }

    if (!found_next) {
        ReleaseSRWLockExclusive(&g_mgr.lock);
        if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) == 0) {
            (void)gi_drain_callbacks_outside_lock(2000, false);
        }
        return GI_E_READING_NOT_FOUND;
    }

    *out_reading = gi_reading_iface_for_ver(found_next, ver);
    ReleaseSRWLockExclusive(&g_mgr.lock);
    if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) == 0) {
        (void)gi_drain_callbacks_outside_lock(2000, false);
    }
    return S_OK;
}

static HRESULT WINAPI gi_mgr_GetPreviousReading(void *iface, void *raw_ref, GameInputKind kind, void *raw_device, void **out_reading) {
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    if (!out_reading) return E_POINTER;
    *out_reading = NULL;
    if (!raw_ref || kind == GI_KindUnknown) return E_INVALIDARG;

    GI_ReadingImpl *ref = gi_reading_from_any(raw_ref, NULL);
    if (!ref) return E_INVALIDARG;

    GI_DeviceImpl *filter_dev = NULL;
    if (raw_device) {
        filter_dev = gi_resolve_device_ptr(raw_device);
        if (!filter_dev) return GI_E_DEVICE_NOT_FOUND;
        if (filter_dev->dev_type == GI_DEV_AGGREGATE) filter_dev = NULL;
    }

    AcquireSRWLockExclusive(&g_mgr.lock);
    GI_ReadingImpl *found_prev = NULL;
    for (size_t i = 0; i < g_mgr.history_count; i++) {
        size_t idx = (g_mgr.history_head + i) % GI_HISTORY_CAPACITY;
        GI_ReadingImpl *cand = g_mgr.history[idx];
        if (!cand) continue;
        if (cand->snap.sequence >= ref->snap.sequence) break;
        if (filter_dev && cand->snap.device != filter_dev) continue;
        if ((cand->snap.kind & kind) == 0) continue;
        found_prev = cand;
    }

    if (!found_prev) {
        ReleaseSRWLockExclusive(&g_mgr.lock);
        return GI_E_READING_NOT_FOUND;
    }

    *out_reading = gi_reading_iface_for_ver(found_prev, ver);
    ReleaseSRWLockExclusive(&g_mgr.lock);
    return S_OK;
}

static HRESULT WINAPI gi_mgr_v0_GetTemporalReading(void *iface, uint64_t timestamp, void *raw_device, void **out_reading) {
    (void)iface;
    (void)timestamp;
    (void)raw_device;
    if (!out_reading) return E_POINTER;
    *out_reading = NULL;
    return GI_E_TIMESTAMP_OUT_OF_RANGE;
}

static HRESULT gi_register_callback_common(
    GI_ApiVer api_ver,
    uint32_t cb_type,
    void *raw_device,
    GameInputKind kind,
    GameInputDeviceStatus status_filter,
    void *callback_fn,
    void *context,
    GameInputCallbackToken *out_token)
{
    if (out_token) *out_token = 0;
    if (!callback_fn) return E_INVALIDARG;

    GI_DeviceImpl *filter_dev = NULL;
    if (raw_device) {
        filter_dev = gi_resolve_device_ptr(raw_device);
        if (!filter_dev) return GI_E_DEVICE_NOT_FOUND;
    }
    GameInputCallbackToken tok = (GameInputCallbackToken)InterlockedIncrement64(&g_mgr.next_token);

    if (cb_type == 1 && (kind == GI_KindUnknown || (kind & GI_KindMouse) != 0)) {
        gi_ensure_raw_mouse();
    }

    AcquireSRWLockExclusive(&g_mgr.lock);
    size_t chosen = GI_MAX_CALLBACKS;
    for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
        if (!g_mgr.callbacks[i].active) {
            chosen = i;
            break;
        }
    }
    if (chosen == GI_MAX_CALLBACKS) {
        for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
            size_t idx = ((size_t)tok + i) % GI_MAX_CALLBACKS;
            if (g_mgr.callbacks[idx].in_flight == 0) {
                chosen = idx;
                break;
            }
        }
    }
    if (chosen == GI_MAX_CALLBACKS) {
        ReleaseSRWLockExclusive(&g_mgr.lock);
        return E_OUTOFMEMORY;
    }

    memset(&g_mgr.callbacks[chosen], 0, sizeof(g_mgr.callbacks[chosen]));
    g_mgr.callbacks[chosen].active        = true;
    g_mgr.callbacks[chosen].stopped       = false;
    g_mgr.callbacks[chosen].unregistering = false;
    g_mgr.callbacks[chosen].in_flight     = 0;
    g_mgr.callbacks[chosen].running_tid   = 0;
    g_mgr.callbacks[chosen].token         = tok;
    g_mgr.callbacks[chosen].api_ver       = api_ver;
    g_mgr.callbacks[chosen].cb_type       = cb_type;
    g_mgr.callbacks[chosen].device_filter = filter_dev;
    g_mgr.callbacks[chosen].kind_filter   = kind;
    g_mgr.callbacks[chosen].status_filter = status_filter;
    g_mgr.callbacks[chosen].callback_fn   = callback_fn;
    g_mgr.callbacks[chosen].context       = context;
    ReleaseSRWLockExclusive(&g_mgr.lock);

    if (cb_type == 1 || cb_type == 2) {
        gi_ensure_cb_worker();
    }

    if (out_token) *out_token = tok;
    return S_OK;
}

static HRESULT WINAPI gi_mgr_v0_RegisterReadingCallback(
    void *iface,
    void *raw_device,
    GameInputKind kind,
    float threshold,
    void *context,
    void *callback_fn,
    GameInputCallbackToken *out_token)
{
    (void)iface;
    (void)threshold;
    return gi_register_callback_common(GI_VER_0, 1, raw_device, kind, 0, callback_fn, context, out_token);
}

static HRESULT WINAPI gi_mgr_v1_RegisterReadingCallback(
    void *iface,
    void *raw_device,
    GameInputKind kind,
    void *context,
    void *callback_fn,
    GameInputCallbackToken *out_token)
{
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    return gi_register_callback_common(ver, 1, raw_device, kind, 0, callback_fn, context, out_token);
}

static HRESULT WINAPI gi_mgr_RegisterDeviceCallback(
    void *iface,
    void *raw_device,
    GameInputKind kind,
    GameInputDeviceStatus status_filter,
    GameInputEnumerationKind enum_kind,
    void *context,
    void *callback_fn,
    GameInputCallbackToken *out_token)
{
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    GameInputCallbackToken tok = 0;
    HRESULT hr = gi_register_callback_common(ver, 2, raw_device, kind, status_filter, callback_fn, context, &tok);
    if (FAILED(hr)) return hr;
    if (out_token) *out_token = tok;

    /* Deliver initial connected device enumeration when requested */
    if ((enum_kind == GI_AsyncEnumeration || enum_kind == GI_BlockingEnumeration) &&
        (status_filter & GI_DeviceConnected) != 0) {
        GI_DeviceImpl *filter_dev = raw_device ? gi_resolve_device_ptr(raw_device) : NULL;
        uint64_t now_ts = gi_get_timestamp_us();
        bool queue_for_dispatcher =
            (enum_kind == GI_AsyncEnumeration) &&
            (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) > 0);

        if (queue_for_dispatcher) {
            AcquireSRWLockExclusive(&g_mgr.lock);
            for (size_t i = 0; i < GI_DEV_AGGREGATE; i++) {
                GI_DeviceImpl *dev = &g_mgr.devices[i];
                if (filter_dev && filter_dev->dev_type != GI_DEV_AGGREGATE && filter_dev != dev) continue;
                if (kind != GI_KindUnknown && (dev->info_v1.supportedInput & kind) == 0) continue;
                if (dev->xinput_slot >= 0) {
                    (void)gi_probe_xinput_slot(dev, NULL, NULL);
                }
                GameInputDeviceStatus st = gi_device_status_value(dev, ver);
                if ((st & GI_DeviceConnected) != 0) {
                    GI_PendingCallbackItem item;
                    memset(&item, 0, sizeof(item));
                    item.cb_type         = 2;
                    item.api_ver         = ver;
                    item.token           = tok;
                    item.callback_fn     = callback_fn;
                    item.context         = context;
                    item.device          = dev;
                    item.timestamp       = now_ts;
                    item.current_status  = st;
                    item.previous_status = GI_DeviceNoStatus;
                    gi_enqueue_cb_item_locked(&item);
                }
            }
            ReleaseSRWLockExclusive(&g_mgr.lock);
        } else {
            PFN_GI_DeviceCallback cb = (PFN_GI_DeviceCallback)callback_fn;
            for (size_t i = 0; i < GI_DEV_AGGREGATE; i++) {
                GI_DeviceImpl *dev = &g_mgr.devices[i];
                if (filter_dev && filter_dev->dev_type != GI_DEV_AGGREGATE && filter_dev != dev) continue;
                if (kind != GI_KindUnknown && (dev->info_v1.supportedInput & kind) == 0) continue;

                GameInputDeviceStatus st = gi_dev_GetDeviceStatus(
                    ver == GI_VER_0 ? (void *)&dev->v0_iface :
                    ver == GI_VER_1 ? (void *)&dev->v1_iface : (void *)&dev->v2_iface);
                if ((st & GI_DeviceConnected) != 0) {
                    void *dev_iface = gi_device_iface_for_ver(dev, ver);
                    cb(tok, context, dev_iface, now_ts, st, GI_DeviceNoStatus);
                    gi_dev_Release(dev_iface);
                }
            }
        }
    }
    return S_OK;
}

static bool gi_is_executable_ptr(const void *ptr) {
    if (!ptr || (uintptr_t)ptr < 0x10000u) return false;
    MEMORY_BASIC_INFORMATION mbi;
    memset(&mbi, 0, sizeof(mbi));
    if (VirtualQuery(ptr, &mbi, sizeof(mbi)) == 0) return false;
    if (mbi.State != MEM_COMMIT) return false;
    DWORD p = mbi.Protect & 0xFFu;
    return (p == PAGE_EXECUTE || p == PAGE_EXECUTE_READ ||
            p == PAGE_EXECUTE_READWRITE || p == PAGE_EXECUTE_WRITECOPY);
}

/*
 * Slot 10 on `v0_IGameInput`:
 * Early v0 headers had 4-arg `RegisterGuideButtonCallback(dev, ctx, cb, tok)`,
 * while updated GDK v0 headers replaced it in-place with 5-arg
 * `RegisterSystemButtonCallback(dev, buttonFilter, ctx, cb, tok)`.
 * On Win64 (caller cleans stack), we safely support BOTH signatures!
 */
static HRESULT WINAPI gi_mgr_v0_RegisterSystemOrGuideCallback(
    void *iface,
    void *raw_device,
    uintptr_t arg3,
    void *arg4,
    void *arg5,
    GameInputCallbackToken *arg6)
{
    (void)iface;
    /* Check if 4-arg RegisterGuideButtonCallback(dev, ctx=arg3, cb=arg4, tok=arg5) */
    if (gi_is_executable_ptr(arg4) && !gi_is_executable_ptr(arg5)) {
        return gi_register_callback_common(
            GI_VER_0, 3, raw_device, GI_KindUnknown, 0,
            arg4, (void *)arg3, (GameInputCallbackToken *)arg5);
    }
    /* Otherwise 5-arg RegisterSystemButtonCallback(dev, filter=arg3, ctx=arg4, cb=arg5, tok=arg6) */
    if (arg3 == 0) {
        if (arg6) *arg6 = 0;
        return E_INVALIDARG;
    }
    return gi_register_callback_common(GI_VER_0, 3, raw_device, GI_KindUnknown, 0, arg5, arg4, arg6);
}

static HRESULT WINAPI gi_mgr_v1_RegisterSystemButtonCallback(
    void *iface,
    void *raw_device,
    GameInputSystemButtons button_filter,
    void *context,
    void *callback_fn,
    GameInputCallbackToken *out_token)
{
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    if (button_filter == 0) {
        if (out_token) *out_token = 0;
        return E_INVALIDARG;
    }
    return gi_register_callback_common(ver, 3, raw_device, GI_KindUnknown, 0, callback_fn, context, out_token);
}

static HRESULT WINAPI gi_mgr_RegisterKeyboardLayoutCallback(
    void *iface,
    void *raw_device,
    void *context,
    void *callback_fn,
    GameInputCallbackToken *out_token)
{
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    return gi_register_callback_common(ver, 4, raw_device, GI_KindKeyboard, 0, callback_fn, context, out_token);
}

static void WINAPI gi_mgr_StopCallback(void *iface, GameInputCallbackToken token) {
    (void)iface;
    if (token == 0) return;
    AcquireSRWLockExclusive(&g_mgr.lock);
    for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
        if (g_mgr.callbacks[i].active && g_mgr.callbacks[i].token == token) {
            g_mgr.callbacks[i].stopped = true;
            break;
        }
    }
    ReleaseSRWLockExclusive(&g_mgr.lock);
}

static bool gi_unregister_token(GameInputCallbackToken token) {
    if (token == 0) return false;
    bool found = false;
    DWORD cur_tid = GetCurrentThreadId();

    AcquireSRWLockExclusive(&g_mgr.lock);
    for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
        GI_CallbackSlot *slot = &g_mgr.callbacks[i];
        if (slot->active && slot->token == token) {
            found = true;
            slot->stopped = true;
            slot->unregistering = true;
            while (slot->active &&
                   slot->token == token &&
                   slot->in_flight > 0 &&
                   slot->running_tid != cur_tid) {
                if (!SleepConditionVariableSRW(&g_mgr.cb_cv, &g_mgr.lock, 500, 0)) {
                    break;
                }
            }
            if (slot->active && slot->token == token && slot->in_flight == 0) {
                memset(slot, 0, sizeof(*slot));
            }
            break;
        }
    }
    ReleaseSRWLockExclusive(&g_mgr.lock);
    return found;
}

static bool WINAPI gi_mgr_v0_UnregisterCallback(void *iface, GameInputCallbackToken token, uint64_t timeout_us) {
    (void)iface;
    (void)timeout_us;
    return gi_unregister_token(token);
}

static bool WINAPI gi_mgr_v1_UnregisterCallback(void *iface, GameInputCallbackToken token) {
    (void)iface;
    return gi_unregister_token(token);
}

static HRESULT WINAPI gi_mgr_CreateDispatcher(void *iface, void **out_dispatcher) {
    (void)iface;
    if (!out_dispatcher) return E_POINTER;
    *out_dispatcher = NULL;

    GI_DispatcherImpl *disp = (GI_DispatcherImpl *)HeapAlloc(
        GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(GI_DispatcherImpl));
    if (!disp) return E_OUTOFMEMORY;

    disp->iface.lpVtbl = g_disp_vtbl;
    disp->ref_count    = 1;
    disp->wait_event   = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!disp->wait_event) {
        HeapFree(GetProcessHeap(), 0, disp);
        return HRESULT_FROM_WIN32(GetLastError());
    }

    AcquireSRWLockExclusive(&g_mgr.lock);
    for (size_t i = 0; i < GI_MAX_DISPATCHERS; i++) {
        if (!g_mgr.dispatchers[i]) {
            g_mgr.dispatchers[i] = disp;
            break;
        }
    }
    if (g_mgr.cb_queue_count > 0) {
        SetEvent(disp->wait_event);
    }
    ReleaseSRWLockExclusive(&g_mgr.lock);

    InterlockedIncrement(&g_live_dispatchers);
    *out_dispatcher = &disp->iface;
    return S_OK;
}

static HRESULT WINAPI gi_mgr_v0_CreateAggregateDevice(void *iface, GameInputKind kind, void **out_device) {
    (void)iface;
    if (!out_device) return E_POINTER;
    *out_device = NULL;
    if (kind == GI_KindUnknown) return E_INVALIDARG;
    *out_device = gi_device_iface_for_ver(&g_mgr.devices[GI_DEV_AGGREGATE], GI_VER_0);
    return S_OK;
}

static HRESULT WINAPI gi_mgr_FindDeviceFromId(void *iface, const GI_APP_LOCAL_DEVICE_ID *id, void **out_device) {
    GI_ApiVer ver = gi_mgr_ver_from_iface(iface);
    if (!out_device) return E_POINTER;
    *out_device = NULL;
    if (!id) return E_INVALIDARG;

    for (size_t i = 0; i < GI_DEV_COUNT; i++) {
        GI_DeviceImpl *dev = &g_mgr.devices[i];
        if (memcmp(id->value, dev->info_v1.deviceId.value, sizeof(id->value)) == 0) {
            *out_device = gi_device_iface_for_ver(dev, ver);
            return S_OK;
        }
    }
    return GI_E_DEVICE_NOT_FOUND;
}

static HRESULT WINAPI gi_mgr_v0_FindDeviceFromObject(void *iface, IUnknown *obj, void **out_device) {
    (void)iface;
    if (!out_device) return E_POINTER;
    *out_device = NULL;
    if (!obj) return E_INVALIDARG;
    return GI_E_DEVICE_NOT_FOUND;
}

static HRESULT WINAPI gi_mgr_v0_FindDeviceFromPlatformHandle(void *iface, HANDLE handle, void **out_device) {
    (void)iface;
    if (!out_device) return E_POINTER;
    *out_device = NULL;
    if (!handle || handle == INVALID_HANDLE_VALUE) return E_INVALIDARG;
    return GI_E_DEVICE_NOT_FOUND;
}

static HRESULT WINAPI gi_mgr_FindDeviceFromPlatformString(void *iface, LPCWSTR str, void **out_device) {
    (void)iface;
    if (!out_device) return E_POINTER;
    *out_device = NULL;
    if (!str) return E_INVALIDARG;
    return GI_E_DEVICE_NOT_FOUND;
}

static HRESULT WINAPI gi_mgr_v0_EnableOemDeviceSupport(void *iface, uint16_t vid, uint16_t pid, uint8_t if_num, uint8_t col_num) {
    (void)iface;
    (void)vid;
    (void)pid;
    (void)if_num;
    (void)col_num;
    return S_OK;
}

static void WINAPI gi_mgr_SetFocusPolicy(void *iface, GameInputFocusPolicy policy) {
    (void)iface;
    AcquireSRWLockExclusive(&g_mgr.lock);
    InterlockedExchange(&g_mgr.focus_policy, (LONG)policy);
    g_mgr.cached_input_valid = false;
    ReleaseSRWLockExclusive(&g_mgr.lock);
}

static const void *const g_mgr_v0_vtbl[] = {
    (const void *)gi_mgr_QueryInterface,
    (const void *)gi_mgr_AddRef,
    (const void *)gi_mgr_Release,
    (const void *)gi_mgr_GetCurrentTimestamp,
    (const void *)gi_mgr_GetCurrentReading,
    (const void *)gi_mgr_GetNextReading,
    (const void *)gi_mgr_GetPreviousReading,
    (const void *)gi_mgr_v0_GetTemporalReading,
    (const void *)gi_mgr_v0_RegisterReadingCallback,
    (const void *)gi_mgr_RegisterDeviceCallback,
    (const void *)gi_mgr_v0_RegisterSystemOrGuideCallback,
    (const void *)gi_mgr_RegisterKeyboardLayoutCallback,
    (const void *)gi_mgr_StopCallback,
    (const void *)gi_mgr_v0_UnregisterCallback,
    (const void *)gi_mgr_CreateDispatcher,
    (const void *)gi_mgr_v0_CreateAggregateDevice,
    (const void *)gi_mgr_FindDeviceFromId,
    (const void *)gi_mgr_v0_FindDeviceFromObject,
    (const void *)gi_mgr_v0_FindDeviceFromPlatformHandle,
    (const void *)gi_mgr_FindDeviceFromPlatformString,
    (const void *)gi_mgr_v0_EnableOemDeviceSupport,
    (const void *)gi_mgr_SetFocusPolicy
};

static const void *const g_mgr_v1_vtbl[] = {
    (const void *)gi_mgr_QueryInterface,
    (const void *)gi_mgr_AddRef,
    (const void *)gi_mgr_Release,
    (const void *)gi_mgr_GetCurrentTimestamp,
    (const void *)gi_mgr_GetCurrentReading,
    (const void *)gi_mgr_GetNextReading,
    (const void *)gi_mgr_GetPreviousReading,
    (const void *)gi_mgr_v1_RegisterReadingCallback,
    (const void *)gi_mgr_RegisterDeviceCallback,
    (const void *)gi_mgr_v1_RegisterSystemButtonCallback,
    (const void *)gi_mgr_RegisterKeyboardLayoutCallback,
    (const void *)gi_mgr_StopCallback,
    (const void *)gi_mgr_v1_UnregisterCallback,
    (const void *)gi_mgr_CreateDispatcher,
    (const void *)gi_mgr_FindDeviceFromId,
    (const void *)gi_mgr_FindDeviceFromPlatformString,
    (const void *)gi_mgr_SetFocusPolicy
};

static const void *const g_mgr_v2_vtbl[] = {
    (const void *)gi_mgr_QueryInterface,
    (const void *)gi_mgr_AddRef,
    (const void *)gi_mgr_Release,
    (const void *)gi_mgr_GetCurrentTimestamp,
    (const void *)gi_mgr_GetCurrentReading,
    (const void *)gi_mgr_GetNextReading,
    (const void *)gi_mgr_GetPreviousReading,
    (const void *)gi_mgr_v1_RegisterReadingCallback,
    (const void *)gi_mgr_RegisterDeviceCallback,
    (const void *)gi_mgr_v1_RegisterSystemButtonCallback,
    (const void *)gi_mgr_RegisterKeyboardLayoutCallback,
    (const void *)gi_mgr_StopCallback,
    (const void *)gi_mgr_v1_UnregisterCallback,
    (const void *)gi_mgr_CreateDispatcher,
    (const void *)gi_mgr_FindDeviceFromId,
    (const void *)gi_mgr_FindDeviceFromPlatformString,
    (const void *)gi_mgr_SetFocusPolicy
};

/* -------------------------------------------------------------------------
 * Singleton Initialization & DLL Exports
 * ------------------------------------------------------------------------- */
static void gi_init_single_device(
    GI_DeviceImpl *dev,
    GI_InternalDevType dev_type,
    int xinput_slot,
    bool initially_connected,
    uint16_t vid,
    uint16_t pid,
    uint16_t usage_page,
    uint16_t usage_id,
    GameInputDeviceFamily family,
    GameInputKind supported_input,
    GameInputRumbleMotors rumble,
    const char *display_name)
{
    memset(dev, 0, sizeof(*dev));
    dev->v0_iface.lpVtbl = g_dev_v0_vtbl;
    dev->v1_iface.lpVtbl = g_dev_v1_vtbl;
    dev->v2_iface.lpVtbl = g_dev_v2_vtbl;
    dev->ref_count       = 1;
    dev->dev_type        = dev_type;
    dev->xinput_slot     = xinput_slot;
    dev->connected       = initially_connected;

    GI_APP_LOCAL_DEVICE_ID dev_id;
    memset(&dev_id, 0, sizeof(dev_id));
    static const char prefix[] = "OneLauncher.GI.Device.";
    memcpy(dev_id.value, prefix, sizeof(prefix) - 1);
    dev_id.value[24] = (uint8_t)dev_type;
    dev_id.value[25] = (uint8_t)(xinput_slot >= 0 ? xinput_slot : 0xFF);
    dev_id.value[31] = 0x01;

    uint32_t name_len = (uint32_t)strlen(display_name);
    dev->display_str_v0.sizeInBytes    = name_len;
    dev->display_str_v0.codePointCount = name_len;
    dev->display_str_v0.data           = display_name;

    /* Populate v0_GameInputDeviceInfo */
    dev->info_v0.infoSize              = sizeof(GI_DeviceInfo_v0);
    dev->info_v0.vendorId              = vid;
    dev->info_v0.productId             = pid;
    dev->info_v0.revisionNumber        = 1;
    dev->info_v0.usage.page            = usage_page;
    dev->info_v0.usage.id              = usage_id;
    dev->info_v0.hardwareVersion.major = 1;
    dev->info_v0.firmwareVersion.major = 1;
    dev->info_v0.deviceId              = dev_id;
    dev->info_v0.deviceRootId          = dev_id;
    dev->info_v0.deviceFamily          = family;
    dev->info_v0.supportedInput        = supported_input;
    dev->info_v0.supportedRumbleMotors = rumble;
    dev->info_v0.displayName           = &dev->display_str_v0;

    /* Populate v1_GameInputDeviceInfo */
    dev->info_v1.vendorId              = vid;
    dev->info_v1.productId             = pid;
    dev->info_v1.usage.page            = usage_page;
    dev->info_v1.usage.id              = usage_id;
    dev->info_v1.deviceId              = dev_id;
    dev->info_v1.deviceRootId          = dev_id;
    dev->info_v1.deviceFamily          = family;
    dev->info_v1.supportedInput        = supported_input;
    dev->info_v1.supportedRumbleMotors = rumble;
    dev->info_v1.displayName           = display_name;
    dev->info_v1.pnpPath               = "\\\\?\\HID#OneLauncherVirtualGameInput";

    /* Populate v2_GameInputDeviceInfo */
    dev->info_v2.vendorId              = vid;
    dev->info_v2.productId             = pid;
    dev->info_v2.revisionNumber        = 1;
    dev->info_v2.usage.page            = usage_page;
    dev->info_v2.usage.id              = usage_id;
    dev->info_v2.hardwareVersion.major = 1;
    dev->info_v2.firmwareVersion.major = 1;
    dev->info_v2.deviceId              = dev_id;
    dev->info_v2.deviceRootId          = dev_id;
    dev->info_v2.deviceFamily          = family;
    dev->info_v2.supportedInput        = supported_input;
    dev->info_v2.supportedRumbleMotors = rumble;
    dev->info_v2.displayName           = display_name;
    dev->info_v2.pnpPath               = "\\\\?\\HID#OneLauncherVirtualGameInput";

    if ((supported_input & GI_KindKeyboard) != 0) {
        dev->info_v0.keyboardInfo = &g_kb_info_v0;
        dev->info_v1.keyboardInfo = &g_kb_info_v1;
        dev->info_v2.keyboardInfo = &g_kb_info_v1;
    }
    if ((supported_input & GI_KindMouse) != 0) {
        dev->info_v0.mouseInfo = &g_mouse_info_v0;
        dev->info_v1.mouseInfo = &g_mouse_info_v1;
        dev->info_v2.mouseInfo = &g_mouse_info_v1;
    }
    if ((supported_input & GI_KindUiNavigation) != 0) {
        const void *ui_nav = ((supported_input & GI_KindGamepad) != 0)
            ? (const void *)&g_gamepad_ui_nav_info
            : (const void *)&g_kb_ui_nav_info;
        dev->info_v0.uiNavigationInfo = ui_nav;
        dev->info_v1.uiNavigationInfo = ui_nav;
        dev->info_v2.uiNavigationInfo = ui_nav;
    }
    if ((supported_input & (GI_KindGamepad | GI_KindController)) != 0) {
        dev->info_v0.gamepadInfo           = &g_gamepad_info;
        dev->info_v0.controllerAxisCount   = GI_CONTROLLER_AXIS_COUNT;
        dev->info_v0.controllerAxisInfo    = g_axis_info_v0;
        dev->info_v0.controllerButtonCount = GI_CONTROLLER_BTN_COUNT;
        dev->info_v0.controllerButtonInfo  = g_button_info_v0;
        dev->info_v0.controllerSwitchCount = 1;
        dev->info_v0.controllerSwitchInfo  = g_switch_info_v0;

        dev->info_v1.gamepadInfo           = &g_gamepad_info;
        dev->info_v1.controllerAxisCount   = GI_CONTROLLER_AXIS_COUNT;
        dev->info_v1.controllerAxisInfo    = g_axis_info_v1;
        dev->info_v1.controllerButtonCount = GI_CONTROLLER_BTN_COUNT;
        dev->info_v1.controllerButtonInfo  = g_button_info_v1;
        dev->info_v1.controllerSwitchCount = 1;
        dev->info_v1.controllerSwitchInfo  = g_switch_info_v1;

        dev->info_v2.gamepadInfo           = &g_gamepad_info;
        dev->info_v2.controllerAxisCount   = GI_CONTROLLER_AXIS_COUNT;
        dev->info_v2.controllerAxisInfo    = g_axis_info_v1;
        dev->info_v2.controllerButtonCount = GI_CONTROLLER_BTN_COUNT;
        dev->info_v2.controllerButtonInfo  = g_button_info_v1;
        dev->info_v2.controllerSwitchCount = 1;
        dev->info_v2.controllerSwitchInfo  = g_switch_info_v1;
    }
}

static BOOL CALLBACK gi_init_mgr_once(PINIT_ONCE once, PVOID param, PVOID *ctx) {
    static const char *const pad_names[4] = {
        "Xbox Wireless Controller (Slot 1)",
        "Xbox Wireless Controller (Slot 2)",
        "Xbox Wireless Controller (Slot 3)",
        "Xbox Wireless Controller (Slot 4)"
    };
    (void)once;
    (void)param;
    (void)ctx;

    memset(&g_mgr, 0, sizeof(g_mgr));
    g_mgr.v0_iface.lpVtbl = g_mgr_v0_vtbl;
    g_mgr.v1_iface.lpVtbl = g_mgr_v1_vtbl;
    g_mgr.v2_iface.lpVtbl = g_mgr_v2_vtbl;
    InitializeSRWLock(&g_mgr.lock);
    InitializeConditionVariable(&g_mgr.cb_cv);

    gi_init_single_device(
        &g_mgr.devices[GI_DEV_KEYBOARD],
        GI_DEV_KEYBOARD, -1, true,
        0x045Eu, 0x07F8u, 0x0001u, 0x0006u,
        GI_FamilyHid,
        GI_KindKeyboard | GI_KindUiNavigation,
        GI_RumbleNone,
        "Standard HID Keyboard");

    gi_init_single_device(
        &g_mgr.devices[GI_DEV_MOUSE],
        GI_DEV_MOUSE, -1, true,
        0x045Eu, 0x07FDu, 0x0001u, 0x0002u,
        GI_FamilyHid,
        GI_KindMouse,
        GI_RumbleNone,
        "Standard HID Mouse");

    for (int s = 0; s < 4; s++) {
        gi_init_single_device(
            &g_mgr.devices[GI_DEV_GAMEPAD_0 + s],
            (GI_InternalDevType)(GI_DEV_GAMEPAD_0 + s), s, false,
            0x045Eu, 0x02FFu, 0x0001u, 0x0005u,
            GI_FamilyXboxOne,
            GI_KindGamepad | GI_KindController | GI_KindUiNavigation,
            GI_RumbleLowFrequency | GI_RumbleHighFrequency,
            pad_names[s]);
    }

    gi_init_single_device(
        &g_mgr.devices[GI_DEV_AGGREGATE],
        GI_DEV_AGGREGATE, -1, true,
        0x045Eu, 0x0001u, 0x0001u, 0x0004u,
        GI_FamilyAggregate,
        GI_KindGamepad | GI_KindController | GI_KindKeyboard | GI_KindMouse | GI_KindUiNavigation,
        GI_RumbleNone,
        "System Aggregate Input");

    InterlockedExchange(&g_mgr_ready, 1);
    return TRUE;
}

HRESULT WINAPI GameInputCreate(void **out_game_input) {
    /* Reference marker so linker always retains it even under --gc-sections */
    if (!g_onelauncher_gameinput_marker[0]) return E_UNEXPECTED;
    if (!out_game_input) return E_POINTER;
    *out_game_input = NULL;

    InitOnceExecuteOnce(&g_mgr_once, gi_init_mgr_once, NULL, NULL);
    InterlockedIncrement(&g_mgr.ref_count);
    *out_game_input = &g_mgr.v0_iface;
    return S_OK;
}

HRESULT WINAPI DllCanUnloadNow(void) {
    if (InterlockedCompareExchange(&g_mgr_ready, 0, 0) == 0) {
        return S_OK;
    }
    if (InterlockedCompareExchange(&g_mgr.ref_count, 0, 0) > 0) {
        return S_FALSE;
    }
    if (InterlockedCompareExchange(&g_live_dispatchers, 0, 0) > 0) {
        return S_FALSE;
    }
    for (size_t d = 0; d < GI_DEV_COUNT; d++) {
        if (InterlockedCompareExchange(&g_mgr.devices[d].ref_count, 0, 0) > 1) {
            return S_FALSE;
        }
    }
    bool has_active_cb = false;
    AcquireSRWLockShared(&g_mgr.lock);
    for (size_t i = 0; i < GI_MAX_CALLBACKS; i++) {
        if (g_mgr.callbacks[i].active) {
            has_active_cb = true;
            break;
        }
    }
    ReleaseSRWLockShared(&g_mgr.lock);
    return has_active_cb ? S_FALSE : S_OK;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
    }
    return TRUE;
}
