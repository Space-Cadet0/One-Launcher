import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const nodeRequire = createRequire(import.meta.url);
const { registerStoreSyncIpcHandlers } = nodeRequire('../../electron/ipc/storeSyncIpcHandlers.cjs');
const {
  generateXboxOAuthState,
  verifyXboxOAuthState,
  extractAuthCodeFromInput,
  normalizeXblRpsTicket,
  createXboxAuthProvider,
} = nodeRequire('../../electron/storefronts/xbox/xboxAuthManager.cjs');

// Mock BrowserWindow tracking instance
class MockBrowserWindow extends EventEmitter {
  width: number;
  height: number;
  webPreferences: Record<string, any>;
  destroyed = false;
  webContents: any;
  currentUrl = '';
  loadedUrls: { url: string; options?: any }[] = [];

  constructor(options: any = {}) {
    super();
    this.width = options.width;
    this.height = options.height;
    this.webPreferences = options.webPreferences || {};
    const webContentsEmitter = new EventEmitter();
    this.webContents = Object.assign(webContentsEmitter, {
      setUserAgent: vi.fn((ua: string) => {
        this.webPreferences.userAgent = ua;
      }),
      getURL: () => this.currentUrl,
      loadURL: vi.fn((url: string, opts?: any) => {
        this.currentUrl = url;
        this.loadedUrls.push({ url, options: opts });
      }),
      executeJavaScript: vi.fn(),
      session: {
        clearStorageData: vi.fn(async () => {}),
        clearCache: vi.fn(async () => {}),
        clearAuthCache: vi.fn(async () => {}),
      },
    });
  }

  isDestroyed() {
    return this.destroyed;
  }

  close() {
    this.destroyed = true;
    this.emit('closed');
  }

  destroy() {
    this.destroyed = true;
  }

  loadURL(url: string, options?: any) {
    this.currentUrl = url;
    this.loadedUrls.push({ url, options });
  }
}

describe('Universal Windows Xbox Login HTTP 400 Elimination & LiveSDK OAuth2 Flow', () => {
  let handlers: Map<string, (...args: any[]) => any>;
  let mockIpcMain: any;
  let lastCreatedWindow: MockBrowserWindow | null = null;
  let mockStoreSync: any;
  let origPlatform: string;

  beforeEach(() => {
    origPlatform = process.platform;
    handlers = new Map();
    mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
        handlers.set(channel, handler);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    lastCreatedWindow = null;

    mockStoreSync = {
      saveTokens: vi.fn(),
      loadSavedTokens: vi.fn(() => ({})),
      loginXbox: vi.fn(async (_codeOrPayload: any) => ({
        success: true,
        gamertag: 'SyntheticPlayer01',
        accountName: 'SyntheticPlayer01',
        xuid: '2533274790000001',
        avatarUrl: 'https://images-eds-ssl.xboxlive.com/image?url=gamerpic.png',
        subscription: 'ULTIMATE',
        syncMode: 'cloud_and_local',
        authoritativeComplete: true,
        games: [
          {
            id: 'xbox-9NSYNTH00001',
            title: 'Synthetic Nebula Tactics',
            platforms: [{ platformId: 'xbox', platformGameId: '9NSYNTH00001', installed: false }],
          },
        ],
      })),
      xboxStorefront: {
        // CXH builder exists to verify it is NEVER called during auth:storefront
        buildInlineLoginRequest: vi.fn(() => ({
          url: 'https://login.live.com/ppsecure/InlineLogin.srf?id=80604&scid=3&Platform=Windows10',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; MSAppHost/3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edge/18.26100',
          headers: { hostapp: 'CloudExperienceHost' },
          extraHeadersString: 'hostapp: CloudExperienceHost\r\n',
        })),
        isTrustedXboxAuthUrl: vi.fn((url: string) => url.startsWith('https://login.live.com')),
      },
      getXboxAuthProvider: vi.fn(() => ({
        ensureDeviceContext: vi.fn(async () => {}),
        beginOAuthAuthorization: vi.fn(() => {
          const state = generateXboxOAuthState();
          const params = new URLSearchParams({
            client_id: '00000000402b5328',
            response_type: 'code',
            approval_prompt: 'auto',
            scope: 'service::user.auth.xboxlive.com::MBI_SSL',
            redirect_uri: 'https://login.live.com/oauth20_desktop.srf',
            state,
          });
          return {
            url: `https://login.live.com/oauth20_authorize.srf?${params.toString()}`,
            state,
          };
        }),
      })),
    };
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  function setupIpc(platform = 'win32') {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    class BrowserWindowMock extends MockBrowserWindow {
      constructor(opts: any) {
        super(opts);
        lastCreatedWindow = this;
      }
    }

    registerStoreSyncIpcHandlers({
      ipcMain: mockIpcMain,
      BrowserWindow: BrowserWindowMock,
      session: {
        fromPartition: vi.fn(() => ({
          clearStorageData: vi.fn(async () => {}),
          clearCache: vi.fn(async () => {}),
          clearAuthCache: vi.fn(async () => {}),
          getUserAgent: () => '',
        })),
      },
      getMainWindow: () => null,
      storeSync: mockStoreSync,
      launcherEngine: {
        isStoreDisconnectedTombstoned: () => false,
        clearStoreDisconnectedTombstone: vi.fn(),
        setXboxStoreLicenseRecoveryHook: vi.fn(),
      },
    });
  }

  it('1. auth:storefront on native Windows (win32) initiates LiveSDK OAuth 2.0 without CXH or MSAppHost spoofing', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    expect(authHandler).toBeTypeOf('function');

    // Start auth:storefront in background
    const authPromise = authHandler!({}, 'xbox');

    // Confirm authWindow was created
    expect(lastCreatedWindow).not.toBeNull();
    const win = lastCreatedWindow!;

    // Must NOT call CXH buildInlineLoginRequest
    expect(mockStoreSync.xboxStorefront.buildInlineLoginRequest).not.toHaveBeenCalled();

    // Must NOT use CXH MSAppHost/3.0 spoofed UA
    expect(win.webPreferences.userAgent).not.toContain('MSAppHost/3.0');
    expect(win.webPreferences.userAgent).not.toContain('Edge/18.26100');
    expect(win.webPreferences.preload).toBeUndefined();

    // Must load standard LiveSDK Desktop OAuth authorize URL
    expect(win.loadedUrls).toHaveLength(1);
    const initialLoad = win.loadedUrls[0];
    expect(initialLoad.options).toBeUndefined(); // Zero extraHeaders attached

    const parsedAuthUrl = new URL(initialLoad.url);
    expect(parsedAuthUrl.origin).toBe('https://login.live.com');
    expect(parsedAuthUrl.pathname).toBe('/oauth20_authorize.srf');
    expect(parsedAuthUrl.searchParams.get('client_id')).toBe('00000000402b5328');
    expect(parsedAuthUrl.searchParams.get('response_type')).toBe('code');
    expect(parsedAuthUrl.searchParams.get('redirect_uri')).toBe('https://login.live.com/oauth20_desktop.srf');
    expect(parsedAuthUrl.searchParams.get('scope')).toBe('service::user.auth.xboxlive.com::MBI_SSL');

    // State must be 32 bytes (64 hex characters)
    const state = parsedAuthUrl.searchParams.get('state');
    expect(state).toBeDefined();
    expect(state).toHaveLength(64);

    // Simulate user closing window to resolve promise cleanly
    win.close();
    const cancelRes = await authPromise;
    expect(cancelRes.success).toBe(false);
    expect(cancelRes.error).toMatch(/closed/i);
  });

  it('2. Completing Xbox authentication via password or passkey redirects to oauth20_desktop.srf and resolves successfully', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const parsedAuthUrl = new URL(win.loadedUrls[0].url);
    const expectedState = parsedAuthUrl.searchParams.get('state')!;

    // Simulate Microsoft authentication completion (passkey or password redirect)
    const authCode = 'M.R3_BLA_authentic_win32_token_998811';
    const callbackUrl = `https://login.live.com/oauth20_desktop.srf?code=${authCode}&state=${expectedState}`;

    // Emit will-navigate event simulating redirect
    win.webContents.emit('will-navigate', {}, callbackUrl);

    const result = await authPromise;
    expect(result.success).toBe(true);
    expect(result.storefrontId).toBe('xbox');
    expect(result.accountName).toBe('SyntheticPlayer01');
    expect(result.xuid).toBe('2533274790000001');
    expect(result.games).toHaveLength(1);
    expect(result.authoritativeComplete).toBe(true);

    // Verify window was safely closed
    expect(win.destroyed).toBe(true);

    // Verify webContents.setUserAgent was called with clean browser UA
    expect(win.webContents.setUserAgent).toHaveBeenCalled();

    // Verify result returns 'xbox_token_broker' sentinel so UI knows tokens were exchanged in main
    expect(result.code).toBe('xbox_token_broker');

    // Verify loginXbox was invoked with extracted code payload including expectedState
    expect(mockStoreSync.loginXbox).toHaveBeenCalledWith({
      code: authCode,
      state: expectedState,
      expectedState,
      url: callbackUrl,
    });
  });

  it('3. Rejects CSRF state mismatch with explicit security failure and closes auth window', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const attackerState = '000000000000000000000000000000000000000000000000000000000attacker';
    const forgedRedirect = `https://login.live.com/oauth20_desktop.srf?code=M.FORGED_CODE&state=${attackerState}`;

    // Emit redirect with invalid state
    win.webContents.emit('will-redirect', {}, forgedRedirect);

    const result = await authPromise;
    expect(result.success).toBe(false);
    expect(result.storefrontId).toBe('xbox');
    expect(result.error).toMatch(/CSRF validation failed/i);
    expect(win.destroyed).toBe(true);
    expect(mockStoreSync.loginXbox).not.toHaveBeenCalled();
  });

  it('4. Handles user cancellation / access_denied gracefully without throwing', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const cancelRedirect =
      'https://login.live.com/oauth20_desktop.srf?error=access_denied&error_description=The+user+has+denied+the+request';

    win.webContents.emit('will-redirect', {}, cancelRedirect);

    const result = await authPromise;
    expect(result.success).toBe(false);
    expect(result.storefrontId).toBe('xbox');
    expect(result.error).toMatch(/Microsoft sign-in cancelled/i);
    expect(win.destroyed).toBe(true);
  });

  it('5. Fallback works when getXboxAuthProvider is unavailable, still generating CSRF state and clean LiveSDK URL', async () => {
    setupIpc('win32');
    mockStoreSync.getXboxAuthProvider = null; // No provider instance
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const parsed = new URL(win.loadedUrls[0].url);
    expect(parsed.origin).toBe('https://login.live.com');
    expect(parsed.pathname).toBe('/oauth20_authorize.srf');
    expect(parsed.searchParams.get('client_id')).toBe('00000000402b5328');
    const state = parsed.searchParams.get('state');
    expect(state).toHaveLength(64);

    win.close();
    await authPromise;
  });

  it('6. Supports redirect detection across will-redirect, will-navigate, did-navigate, and did-finish-load', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');

    // Test detection on did-finish-load
    const authPromise = authHandler!({}, 'xbox');
    const win = lastCreatedWindow!;
    const parsedAuthUrl = new URL(win.loadedUrls[0].url);
    const expectedState = parsedAuthUrl.searchParams.get('state')!;

    win.currentUrl = `https://login.live.com/oauth20_desktop.srf?code=M.FINISH_LOAD_CODE&state=${expectedState}`;
    win.webContents.emit('did-finish-load');

    const result = await authPromise;
    expect(result.success).toBe(true);
    expect(mockStoreSync.loginXbox).toHaveBeenCalledWith({
      code: 'M.FINISH_LOAD_CODE',
      state: expectedState,
      expectedState,
      url: win.currentUrl,
    });
  });

  it('7. Universal portability: Works identically across win32, darwin, and linux', async () => {
    for (const testPlatform of ['win32', 'darwin', 'linux']) {
      setupIpc(testPlatform);
      const authHandler = handlers.get('auth:storefront');
      const authPromise = authHandler!({}, 'xbox');
      const win = lastCreatedWindow!;

      expect(win.webPreferences.userAgent).not.toContain('MSAppHost/3.0');
      const parsed = new URL(win.loadedUrls[0].url);
      expect(parsed.origin).toBe('https://login.live.com');
      expect(parsed.pathname).toBe('/oauth20_authorize.srf');

      win.close();
      await authPromise;
    }
  });

  it('8. Tolerates trailing slash on oauth20_desktop.srf redirect URI', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const parsedAuthUrl = new URL(win.loadedUrls[0].url);
    const expectedState = parsedAuthUrl.searchParams.get('state')!;

    const trailingSlashUrl = `https://login.live.com/oauth20_desktop.srf/?code=M.TRAILING_SLASH_CODE&state=${expectedState}`;
    win.webContents.emit('will-navigate', {}, trailingSlashUrl);

    const result = await authPromise;
    expect(result.success).toBe(true);
    expect(mockStoreSync.loginXbox).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'M.TRAILING_SLASH_CODE',
        state: expectedState,
      })
    );
  });

  it('9. Supports code and state delivered in URL hash fragment', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const parsedAuthUrl = new URL(win.loadedUrls[0].url);
    const expectedState = parsedAuthUrl.searchParams.get('state')!;

    const fragmentUrl = `https://login.live.com/oauth20_desktop.srf#code=M.FRAGMENT_CODE&state=${expectedState}`;
    win.webContents.emit('will-redirect', {}, fragmentUrl);

    const result = await authPromise;
    expect(result.success).toBe(true);
    expect(mockStoreSync.loginXbox).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'M.FRAGMENT_CODE',
        state: expectedState,
      })
    );
  });

  it('10. Accepts redirect from any trusted host in XBOX_TRUSTED_AUTH_HOSTS (e.g. login.microsoft.com)', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const parsedAuthUrl = new URL(win.loadedUrls[0].url);
    const expectedState = parsedAuthUrl.searchParams.get('state')!;

    const altHostUrl = `https://login.microsoft.com/oauth20_desktop.srf?code=M.MS_HOST_CODE&state=${expectedState}`;
    win.webContents.emit('will-navigate', {}, altHostUrl);

    const result = await authPromise;
    expect(result.success).toBe(true);
    expect(mockStoreSync.loginXbox).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'M.MS_HOST_CODE',
        state: expectedState,
      })
    );
  });

  it('11. storeSync.loginXbox bypasses exchangeAuthCode when passed xbox_token_broker sentinel', async () => {
    const storeSyncModule = nodeRequire('../../electron/storeSync.cjs');
    const mockExchangeAuthCode = vi.fn();
    const customProvider = {
      exchangeAuthCode: mockExchangeAuthCode,
      getValidXboxSession: vi.fn(async () => ({
        xuid: '2533274790000001',
        uhs: 'synthetic_uhs',
        gamertag: 'SyntheticPlayer01',
        authorizationHeader: 'XBL3.0 x=synthetic_uhs;synthetic_token',
      })),
      getStoreMsaToken: vi.fn(async () => 'synthetic_store_token'),
    };

    // Invoke loginXbox with 'xbox_token_broker'
    const res = await storeSyncModule.loginXbox('xbox_token_broker', {
      authProviderOverride: customProvider,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    });

    // exchangeAuthCode must NOT have been called with 'xbox_token_broker'
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('12. storeSync.loginXbox bypasses exchangeAuthCode when passed an object with code: "xbox_token_broker"', async () => {
    const storeSyncModule = nodeRequire('../../electron/storeSync.cjs');
    const mockExchangeAuthCode = vi.fn();
    const customProvider = {
      exchangeAuthCode: mockExchangeAuthCode,
      getValidXboxSession: vi.fn(async () => ({
        xuid: '2533274790000001',
        uhs: 'synthetic_uhs',
        gamertag: 'SyntheticPlayer01',
        authorizationHeader: 'XBL3.0 x=synthetic_uhs;synthetic_token',
      })),
      getStoreMsaToken: vi.fn(async () => 'synthetic_store_token'),
    };

    const res = await storeSyncModule.loginXbox({ code: 'xbox_token_broker' }, {
      authProviderOverride: customProvider,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    });

    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('13. extractAuthCodeFromInput extracts code and verifies state when code is delivered in URL hash fragment', () => {
    const state = generateXboxOAuthState();
    const code = 'M.FRAGMENT_VERIFIED_AUTH_CODE_123';
    const fragmentUrl = `https://login.live.com/oauth20_desktop.srf#code=${code}&state=${state}`;

    // Test with URL string
    const extracted = extractAuthCodeFromInput(fragmentUrl, { expectedState: state });
    expect(extracted).toBe(code);

    // Test with bare fragment
    const extractedBare = extractAuthCodeFromInput(`#code=${code}&state=${state}`, { expectedState: state });
    expect(extractedBare).toBe(code);

    // Test with structured payload object
    const extractedObj = extractAuthCodeFromInput({
      code,
      state,
      expectedState: state,
      url: fragmentUrl,
    });
    expect(extractedObj).toBe(code);
  });

  it('14. extractAuthCodeFromInput strictly rejects mismatched CSRF state delivered in URL hash fragment', () => {
    const state = generateXboxOAuthState();
    const forgedState = generateXboxOAuthState();
    const fragmentUrl = `https://login.live.com/oauth20_desktop.srf#code=M.ATTACKER&state=${forgedState}`;

    expect(() => {
      extractAuthCodeFromInput(fragmentUrl, { expectedState: state });
    }).toThrow(/CSRF state/i);

    expect(() => {
      extractAuthCodeFromInput({
        code: 'M.ATTACKER',
        state: forgedState,
        expectedState: state,
        url: fragmentUrl,
      });
    }).toThrow(/CSRF state/i);
  });

  it('15. extractAuthCodeFromInput surfaces OAuth error parameters in URL hash fragment', () => {
    const fragmentUrl = 'https://login.live.com/oauth20_desktop.srf#error=access_denied&error_description=cancelled';
    expect(() => {
      extractAuthCodeFromInput(fragmentUrl);
    }).toThrow(/cancelled or denied/i);
  });

  it('16. extractAuthCodeFromInput handles state in query and code in hash fragment', () => {
    const state = generateXboxOAuthState();
    const code = 'M.SPLIT_QUERY_HASH_CODE_1';
    const splitUrl = `https://login.live.com/oauth20_desktop.srf?state=${state}#code=${code}`;

    const extracted = extractAuthCodeFromInput(splitUrl, { expectedState: state });
    expect(extracted).toBe(code);
  });

  it('17. extractAuthCodeFromInput handles code in query and state in hash fragment', () => {
    const state = generateXboxOAuthState();
    const code = 'M.SPLIT_QUERY_HASH_CODE_2';
    const splitUrl = `https://login.live.com/oauth20_desktop.srf?code=${code}#state=${state}`;

    const extracted = extractAuthCodeFromInput(splitUrl, { expectedState: state });
    expect(extracted).toBe(code);
  });

  it('18. extractAuthCodeFromInput recovers state from embedded URL in object payload when object.state is undefined', () => {
    const state = generateXboxOAuthState();
    const code = 'M.EMBEDDED_STATE_CODE';
    const callbackUrl = `https://login.live.com/oauth20_desktop.srf?code=${code}&state=${state}`;

    const extracted = extractAuthCodeFromInput(
      {
        code,
        url: callbackUrl,
      },
      { expectedState: state }
    );
    expect(extracted).toBe(code);
  });

  it('19. extractAuthCodeFromInput surfaces error parameter from object payload', () => {
    expect(() => {
      extractAuthCodeFromInput({
        error: 'access_denied',
        error_description: 'User rejected authentication',
      });
    }).toThrow(/cancelled or denied \(access_denied\)/i);
  });

  it('20. extractAuthCodeFromInput handles relative path callback URLs', () => {
    const state = generateXboxOAuthState();
    const code = 'M.RELATIVE_PATH_CODE';
    const relativeUrl = `/oauth20_desktop.srf?code=${code}&state=${state}`;

    const extracted = extractAuthCodeFromInput(relativeUrl, { expectedState: state });
    expect(extracted).toBe(code);
  });

  it('21. storeSyncIpcHandlers checkUrlForCode detects code and state when split between query and hash', async () => {
    setupIpc('win32');
    const authHandler = handlers.get('auth:storefront');
    const authPromise = authHandler!({}, 'xbox');

    const win = lastCreatedWindow!;
    const parsedAuthUrl = new URL(win.loadedUrls[0].url);
    const expectedState = parsedAuthUrl.searchParams.get('state')!;

    // Query has state, hash has code
    const splitUrl = `https://login.live.com/oauth20_desktop.srf?state=${expectedState}#code=M.SPLIT_IPC_CODE`;
    win.webContents.emit('will-navigate', {}, splitUrl);

    const result = await authPromise;
    expect(result.success).toBe(true);
    expect(mockStoreSync.loginXbox).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'M.SPLIT_IPC_CODE',
        state: expectedState,
      })
    );
  });

  it('22. storeSync.loginXbox handles whitespace-padded xbox_token_broker sentinels', async () => {
    const storeSyncModule = nodeRequire('../../electron/storeSync.cjs');
    const mockExchangeAuthCode = vi.fn();
    const customProvider = {
      exchangeAuthCode: mockExchangeAuthCode,
      getValidXboxSession: vi.fn(async () => ({
        xuid: '2533274790000001',
        uhs: 'synthetic_uhs',
        gamertag: 'SyntheticPlayer01',
        authorizationHeader: 'XBL3.0 x=synthetic_uhs;synthetic_token',
      })),
      getStoreMsaToken: vi.fn(async () => 'synthetic_store_token'),
    };

    // Test string sentinel with whitespace
    const resString = await storeSyncModule.loginXbox('  xbox_token_broker  ', {
      authProviderOverride: customProvider,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    });
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
    expect(resString).toBeDefined();

    // Test object sentinel with whitespace
    const resObject = await storeSyncModule.loginXbox({ code: '  xbox_token_broker  ' }, {
      authProviderOverride: customProvider,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    });
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
    expect(resObject).toBeDefined();
  });

  it('23. normalizeXblRpsTicket rewrites 5-segment Compact JWE d=eyJ... (RST2 TOKEN_BROKER) to t=eyJ... while preserving opaque d= tickets', () => {
    const jweHeader = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM' })).toString(
      'base64url'
    );
    const compactJwe = `${jweHeader}.encryptedKeySeg.ivSegment123.ciphertextPayloadSeg.authTagSeg`;

    // Live XASU rejects `d=<jwe>` from RST2 TOKEN_BROKER (`urn:passport:delegationcompact`) with HTTP 400
    expect(normalizeXblRpsTicket(`d=${compactJwe}`)).toBe(`t=${compactJwe}`);
    expect(normalizeXblRpsTicket(`t=${compactJwe}`)).toBe(`t=${compactJwe}`);
    expect(normalizeXblRpsTicket(compactJwe)).toBe(`t=${compactJwe}`);

    // Legacy non-JWE opaque delegation tickets retain explicit `d=` / `t=`
    expect(normalizeXblRpsTicket('d=EwB4Aq1BAAA_opaque_delegation')).toBe(
      'd=EwB4Aq1BAAA_opaque_delegation'
    );
    expect(normalizeXblRpsTicket('t=EwB4Aq1BAAA_opaque_compact')).toBe(
      't=EwB4Aq1BAAA_opaque_compact'
    );
  });

  it('24. createXboxAuthProvider authenticates d=eyJ... Compact JWE with t= prefix on first XASU attempt (no HTTP 400)', async () => {
    const jweHeader = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM' })).toString(
      'base64url'
    );
    const compactJwe = `${jweHeader}.encryptedKeySeg.ivSegment123.ciphertextPayloadSeg.authTagSeg`;

    let vaultStore: Record<string, any> = {
      xbox: {
        xblAccessToken: `d=${compactJwe}`,
        access_token: `d=${compactJwe}`,
        msaExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    const memoryVault = {
      loadSavedTokens: () => vaultStore,
      loadSavedTokensAsync: async () => vaultStore,
      saveTokens: (key: string, val: any) => {
        vaultStore[key] = { ...(vaultStore[key] || {}), ...val };
      },
      saveTokensAsync: async (key: string, val: any) => {
        vaultStore[key] = { ...(vaultStore[key] || {}), ...val };
      },
    };

    const seenRpsTickets: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://user.auth.xboxlive.com/user/authenticate') {
        const parsed = JSON.parse(String(init?.body || '{}'));
        const ticket = String(parsed?.Properties?.RpsTicket || '');
        seenRpsTickets.push(ticket);
        // Mirror live Microsoft XASU server: reject `d=<jwe>` with HTTP 400, accept `t=<jwe>` with HTTP 200
        if (ticket.startsWith('d=')) {
          return new Response('', { status: 400, headers: { 'ms-cv': 'test.cv.400' } });
        }
        return new Response(
          JSON.stringify({
            Token: 'xbl_user_token_ok',
            NotAfter: new Date(Date.now() + 3600_000).toISOString(),
            DisplayClaims: { xui: [{ uhs: 'synthuhs01' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
        return new Response(
          JSON.stringify({
            Token: 'xsts_token_ok',
            NotAfter: new Date(Date.now() + 3600_000).toISOString(),
            DisplayClaims: {
              xui: [
                {
                  uhs: 'synthuhs01',
                  xid: '2533274790000099',
                  gtg: 'SyntheticPlayer01',
                  mgt: 'SyntheticPlayer01',
                  umg: 'SyntheticPlayer01',
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ profileUsers: [] }), { status: 200 });
    });

    const provider = createXboxAuthProvider({
      tokenVault: memoryVault,
      fetchImpl: fetchMock,
    });

    const session = await provider.getValidXboxSession({ forceRefresh: false });
    expect(session.gamertag).toBe('SyntheticPlayer01');
    expect(seenRpsTickets).toEqual([`t=${compactJwe}`]);
  });

  it('25. authenticateXblUser deterministically retries alternate RPS prefix (t= <-> d=) if XASU returns HTTP 400 on opaque ticket', async () => {
    let vaultStore: Record<string, any> = {};
    const memoryVault = {
      loadSavedTokens: () => vaultStore,
      loadSavedTokensAsync: async () => vaultStore,
      saveTokens: (key: string, val: any) => {
        vaultStore[key] = { ...(vaultStore[key] || {}), ...val };
      },
      saveTokensAsync: async (key: string, val: any) => {
        vaultStore[key] = { ...(vaultStore[key] || {}), ...val };
      },
    };

    const seenRpsTickets: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://login.live.com/oauth20_token.srf') {
        return new Response(
          JSON.stringify({
            access_token: 'EwB4Aq1BAAA_opaque_delegation_requiring_d_prefix',
            refresh_token: 'M.SYNTHETIC_REFRESH_TOKEN',
            expires_in: 86400,
            user_id: 'synth_msa_uid',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://user.auth.xboxlive.com/user/authenticate') {
        const parsed = JSON.parse(String(init?.body || '{}'));
        const ticket = String(parsed?.Properties?.RpsTicket || '');
        seenRpsTickets.push(ticket);
        if (ticket.startsWith('t=')) {
          return new Response('', { status: 400, headers: { 'ms-cv': 'test.opaque.400' } });
        }
        return new Response(
          JSON.stringify({
            Token: 'xbl_user_token_after_prefix_flip',
            NotAfter: new Date(Date.now() + 3600_000).toISOString(),
            DisplayClaims: { xui: [{ uhs: 'synthuhs02' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
        return new Response(
          JSON.stringify({
            Token: 'xsts_token_ok_2',
            NotAfter: new Date(Date.now() + 3600_000).toISOString(),
            DisplayClaims: {
              xui: [{ uhs: 'synthuhs02', xid: '2533274790000098', gtg: 'SyntheticPlayer02' }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ profileUsers: [] }), { status: 200 });
    });

    const provider = createXboxAuthProvider({
      tokenVault: memoryVault,
      fetchImpl: fetchMock,
    });
    const authReq = provider.beginOAuthAuthorization();
    const res = await provider.exchangeAuthCode({
      code: 'M.SYNTHETIC_AUTH_CODE',
      state: authReq.state,
    });

    expect(res.gamertag).toBe('SyntheticPlayer02');
    expect(seenRpsTickets).toEqual([
      't=EwB4Aq1BAAA_opaque_delegation_requiring_d_prefix',
      'd=EwB4Aq1BAAA_opaque_delegation_requiring_d_prefix',
    ]);
  });

  it('26. Closing auth:storefront window clears pendingOAuthState so subsequent manual code exchange is not blocked', async () => {
    let vaultStore: Record<string, any> = {};
    const memoryVault = {
      loadSavedTokens: () => vaultStore,
      loadSavedTokensAsync: async () => vaultStore,
      saveTokens: (key: string, val: any) => {
        vaultStore[key] = { ...(vaultStore[key] || {}), ...val };
      },
      saveTokensAsync: async (key: string, val: any) => {
        vaultStore[key] = { ...(vaultStore[key] || {}), ...val };
      },
    };
    const realProvider = createXboxAuthProvider({
      tokenVault: memoryVault,
      fetchImpl: vi.fn(async (url: string) => {
        if (url === 'https://login.live.com/oauth20_token.srf') {
          return new Response(
            JSON.stringify({
              access_token: 't=EwB4Aq1BAAA_manual_ok',
              refresh_token: 'M.MANUAL_REFRESH',
              expires_in: 86400,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url === 'https://user.auth.xboxlive.com/user/authenticate') {
          return new Response(
            JSON.stringify({
              Token: 'xbl_manual_tok',
              NotAfter: new Date(Date.now() + 3600_000).toISOString(),
              DisplayClaims: { xui: [{ uhs: 'manualuhs' }] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
          return new Response(
            JSON.stringify({
              Token: 'xsts_manual_tok',
              NotAfter: new Date(Date.now() + 3600_000).toISOString(),
              DisplayClaims: {
                xui: [{ uhs: 'manualuhs', xid: '2533274790000077', gtg: 'SyntheticManual01' }],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ profileUsers: [] }), { status: 200 });
      }),
    });

    mockStoreSync.getXboxAuthProvider = vi.fn(() => realProvider);
    setupIpc('win32');

    const authHandler = handlers.get('auth:storefront')!;
    const popupPromise = authHandler({}, 'xbox');
    lastCreatedWindow!.close();
    const closedRes = await popupPromise;
    expect(closedRes.success).toBe(false);

    // Subsequent manual redirect URL without state should succeed cleanly because pendingOAuthState was cleared
    const manualSession = await realProvider.exchangeAuthCode(
      'https://login.live.com/oauth20_desktop.srf?code=M.MANUAL_FALLBACK_CODE'
    );
    expect(manualSession.gamertag).toBe('SyntheticManual01');
  });

  it('27. recoverXboxStoreLicenseSession forwards fresh cxh-* extraHeaders on Leg-2 inlineAuthUrl consent redirect', async () => {
    let capturedRecoveryHook: ((ctx?: any) => Promise<any>) | null = null;
    let cxhNotifyListener: ((event: any, payload: string) => void) | null = null;

    mockIpcMain.on = vi.fn((channel: string, listener: any) => {
      if (channel === 'one-launcher:xbox-cxh-notify') {
        cxhNotifyListener = listener;
      }
    });

    const exchangeTokenBrokerMock = vi
      .fn()
      .mockResolvedValueOnce({
        completed: false,
        requiresInlineConsent: true,
        inlineAuthUrl:
          'https://login.live.com/ppsecure/InlineLogin.srf?id=80604&clientid=000000004424da1f&leg=2',
      })
      .mockResolvedValueOnce({
        completed: true,
        requiresInlineConsent: false,
        storeTicket: 't=minted_store_ticket',
      });

    mockStoreSync.getXboxAuthProvider = vi.fn(() => ({
      ensureDeviceContext: vi.fn(async () => ({})),
      exchangeTokenBrokerDaProperty: exchangeTokenBrokerMock,
      getStoreMsaToken: vi.fn(async () => 't=minted_store_ticket'),
    }));
    mockStoreSync.xboxStorefront.buildInlineLoginRequest = vi.fn((opts?: any) => ({
      url:
        opts?.urlOverride ||
        'https://login.live.com/ppsecure/InlineLogin.srf?id=80604&scid=3&Platform=Windows10',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; MSAppHost/3.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edge/18.26100',
      headers: { hostapp: 'CloudExperienceHost', 'cxh-protocol': 'TokenBroker' },
      extraHeadersString: 'hostapp: CloudExperienceHost\r\ncxh-protocol: TokenBroker\r\n',
    }));

    class BrowserWindowMock extends MockBrowserWindow {
      constructor(opts: any) {
        super(opts);
        lastCreatedWindow = this;
      }
    }

    registerStoreSyncIpcHandlers({
      ipcMain: mockIpcMain,
      BrowserWindow: BrowserWindowMock,
      session: {
        fromPartition: vi.fn(() => ({
          clearStorageData: vi.fn(async () => {}),
          clearCache: vi.fn(async () => {}),
          clearAuthCache: vi.fn(async () => {}),
          getUserAgent: () => '',
        })),
      },
      getMainWindow: () => null,
      storeSync: mockStoreSync,
      launcherEngine: {
        isStoreDisconnectedTombstoned: () => false,
        clearStoreDisconnectedTombstone: vi.fn(),
        setXboxStoreLicenseRecoveryHook: (fn: any) => {
          capturedRecoveryHook = fn;
        },
      },
    });

    expect(capturedRecoveryHook).toBeTypeOf('function');
    const recoveryPromise = capturedRecoveryHook!({ title: 'Synthetic Title' });
    await new Promise((r) => setTimeout(r, 10));

    const win = lastCreatedWindow!;
    expect(cxhNotifyListener).toBeTypeOf('function');

    // Leg 1 notify triggers requiresInlineConsent -> loads Leg 2 with fresh extraHeaders
    cxhNotifyListener!(
      { sender: win.webContents },
      JSON.stringify({ sDAToken: '<EncryptedData>leg1</EncryptedData>' })
    );
    await new Promise((r) => setTimeout(r, 15));

    expect(win.loadedUrls).toHaveLength(2);
    expect(win.loadedUrls[1].url).toContain('leg=2');
    expect(win.loadedUrls[1].options?.extraHeaders).toContain('cxh-protocol: TokenBroker');

    // Leg 2 notify resolves recovery cleanly
    cxhNotifyListener!(
      { sender: win.webContents },
      JSON.stringify({ sDAToken: '<EncryptedData>leg2</EncryptedData>' })
    );
    const recOutcome = await recoveryPromise;
    expect(recOutcome).toEqual({ recovered: true });
  });
});
