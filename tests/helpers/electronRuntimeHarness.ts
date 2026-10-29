import path from 'node:path';
import Module from 'node:module';

export interface MockBrowserWindowInstance {
  id: number;
  options: Record<string, any>;
  destroyed: boolean;
  minimized: boolean;
  maximized: boolean;
  fullScreen: boolean;
  visible: boolean;
  listeners: Map<string, Array<(...args: any[]) => void>>;
  webContents: {
    id: number;
    sent: Array<{ channel: string; args: any[] }>;
    listeners: Map<string, Array<(...args: any[]) => void>>;
    session: {
      clearCache: () => Promise<void>;
    };
    send: (channel: string, ...args: any[]) => void;
    on: (event: string, fn: (...args: any[]) => void) => void;
    removeAllListeners: () => void;
    setWindowOpenHandler: (fn: (details: { url: string }) => any) => void;
    windowOpenHandler?: (details: { url: string }) => any;
    setAudioMuted: (muted: boolean) => void;
    reload: () => void;
    reloadIgnoringCache: () => void;
    toggleDevTools: () => void;
    getZoomLevel: () => number;
    setZoomLevel: (level: number) => void;
  };
  isDestroyed: () => boolean;
  destroy: () => void;
  close: () => void;
  minimize: () => void;
  restore: () => void;
  maximize: () => void;
  unmaximize: () => void;
  isMinimized: () => boolean;
  isMaximized: () => boolean;
  isFullScreen: () => boolean;
  setFullScreen: (flag: boolean) => void;
  isVisible: () => boolean;
  show: () => void;
  hide: () => void;
  focus: () => void;
  setMenuBarVisibility: (visible: boolean) => void;
  loadFile: (filePath: string) => Promise<void>;
  loadURL: (url: string) => Promise<void>;
  on: (event: string, fn: (...args: any[]) => void) => void;
  once: (event: string, fn: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
}

export interface PreloadRuntimeHarness {
  api: Record<string, any>;
  invoked: Array<{ channel: string; args: any[] }>;
  listeners: Map<string, Set<(...args: any[]) => void>>;
  clearCacheCalls: number;
  emitIpcEvent: (channel: string, ...args: any[]) => void;
}

export function loadPreloadApi(options?: {
  platform?: NodeJS.Platform;
  invokeHandler?: (channel: string, ...args: any[]) => any;
}): PreloadRuntimeHarness {
  const preloadPath = path.resolve(__dirname, '../../electron/preload.cjs');
  const origLoad = (Module as any)._load;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  let exposedApi: Record<string, any> = {};
  const invoked: Array<{ channel: string; args: any[] }> = [];
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let clearCacheCalls = 0;

  const mockElectron = {
    contextBridge: {
      exposeInMainWorld: (_name: string, api: Record<string, any>) => {
        exposedApi = api;
      },
    },
    ipcRenderer: {
      invoke: (channel: string, ...args: any[]) => {
        invoked.push({ channel, args });
        if (options?.invokeHandler) {
          return Promise.resolve(options.invokeHandler(channel, ...args));
        }
        return Promise.resolve({ success: true });
      },
      on: (channel: string, fn: (...args: any[]) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(fn);
      },
      removeListener: (channel: string, fn: (...args: any[]) => void) => {
        listeners.get(channel)?.delete(fn);
      },
    },
    webFrame: {
      clearCache: () => {
        clearCacheCalls++;
      },
    },
  };

  if (options?.platform) {
    Object.defineProperty(process, 'platform', { value: options.platform, configurable: true });
  }

  (Module as any)._load = function patchedLoad(request: string, parent: any, isMain: boolean) {
    if (request === 'electron') return mockElectron;
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    const req = Module.createRequire(preloadPath);
    delete req.cache[preloadPath];
    req(preloadPath);
  } finally {
    (Module as any)._load = origLoad;
    if (options?.platform && origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  }

  return {
    api: exposedApi,
    invoked,
    listeners,
    get clearCacheCalls() {
      return clearCacheCalls;
    },
    emitIpcEvent(channel: string, ...args: any[]) {
      const fns = listeners.get(channel);
      if (!fns) return;
      for (const fn of Array.from(fns)) {
        fn({}, ...args);
      }
    },
  };
}

export interface MainProcessRuntimeHarness {
  switches: Array<{ name: string; value?: string }>;
  ipcHandlers: Map<string, (event: any, ...args: any[]) => any>;
  createdWindows: MockBrowserWindowInstance[];
  externalOpenedUrls: string[];
  triggerReady: () => Promise<void>;
  invokeIpc: (channel: string, ...args: any[]) => Promise<any>;
  dispose: () => void;
}

export function loadMainProcessHarness(options?: {
  platform?: NodeJS.Platform;
  version?: string;
  argv?: string[];
  isPackaged?: boolean;
}): MainProcessRuntimeHarness {
  const mainPath = path.resolve(__dirname, '../../electron/main.cjs');
  const ipcDir = path.resolve(__dirname, '../../electron/ipc');
  const origLoad = (Module as any)._load;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const origArgv = process.argv;

  const switches: Array<{ name: string; value?: string }> = [];
  const ipcHandlers = new Map<string, (event: any, ...args: any[]) => any>();
  const createdWindows: MockBrowserWindowInstance[] = [];
  const externalOpenedUrls: string[] = [];
  const appListeners = new Map<string, Array<(...args: any[]) => void>>();

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  let nextWinId = 1;
  class MockBrowserWindow implements MockBrowserWindowInstance {
    id = nextWinId++;
    options: Record<string, any>;
    destroyed = false;
    minimized = false;
    maximized = false;
    fullScreen = false;
    visible = true;
    listeners = new Map<string, Array<(...args: any[]) => void>>();
    zoomLevel = 0;
    webContents: MockBrowserWindowInstance['webContents'];

    static getAllWindows() {
      return createdWindows.filter((w) => !w.destroyed);
    }

    constructor(opts: Record<string, any> = {}) {
      this.options = opts;
      const wcId = this.id;
      const wcListeners = new Map<string, Array<(...args: any[]) => void>>();
      const sent: Array<{ channel: string; args: any[] }> = [];
      this.webContents = {
        id: wcId,
        sent,
        listeners: wcListeners,
        session: {
          clearCache: async () => {},
        },
        send: (channel: string, ...args: any[]) => {
          sent.push({ channel, args });
        },
        on: (ev: string, fn: (...args: any[]) => void) => {
          if (!wcListeners.has(ev)) wcListeners.set(ev, []);
          wcListeners.get(ev)!.push(fn);
        },
        removeAllListeners: () => {
          wcListeners.clear();
        },
        setWindowOpenHandler: (fn) => {
          this.webContents.windowOpenHandler = fn;
        },
        setAudioMuted: () => {},
        reload: () => {},
        reloadIgnoringCache: () => {},
        toggleDevTools: () => {},
        getZoomLevel: () => this.zoomLevel,
        setZoomLevel: (lvl: number) => {
          this.zoomLevel = lvl;
        },
      };
      createdWindows.push(this);
    }

    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    close() {
      this.destroy();
    }
    minimize() {
      this.minimized = true;
    }
    restore() {
      this.minimized = false;
    }
    maximize() {
      this.maximized = true;
      this.emit('maximize');
    }
    unmaximize() {
      this.maximized = false;
      this.emit('unmaximize');
    }
    isMinimized() {
      return this.minimized;
    }
    isMaximized() {
      return this.maximized;
    }
    isFullScreen() {
      return this.fullScreen;
    }
    setFullScreen(flag: boolean) {
      this.fullScreen = Boolean(flag);
      this.emit(this.fullScreen ? 'enter-full-screen' : 'leave-full-screen');
    }
    isVisible() {
      return this.visible;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    setMenuBarVisibility() {}
    async loadFile() {}
    async loadURL() {}
    on(event: string, fn: (...args: any[]) => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event)!.push(fn);
    }
    once(event: string, fn: (...args: any[]) => void) {
      const wrapper = (...args: any[]) => {
        const list = this.listeners.get(event) || [];
        this.listeners.set(
          event,
          list.filter((f) => f !== wrapper)
        );
        fn(...args);
      };
      this.on(event, wrapper);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.listeners.get(event) || []) {
        fn(...args);
      }
    }
  }

  const mockElectron = {
    app: {
      isPackaged: Boolean(options?.isPackaged ?? false),
      commandLine: {
        appendSwitch: (name: string, value?: string) => {
          switches.push({ name, value });
        },
      },
      dock: {
        show: () => Promise.resolve(),
        hide: () => {},
        setIcon: () => {},
      },
      requestSingleInstanceLock: () => true,
      whenReady: () => readyPromise,
      on: (event: string, fn: (...args: any[]) => void) => {
        if (!appListeners.has(event)) appListeners.set(event, []);
        appListeners.get(event)!.push(fn);
      },
      quit: () => {},
      getVersion: () => options?.version || '0.1.0',
      getPath: (name: string) => `/tmp/one-launcher-mock-${name}`,
    },
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle: (channel: string, fn: (event: any, ...args: any[]) => any) => {
        ipcHandlers.set(channel, fn);
      },
      on: () => {},
      removeHandler: (channel: string) => {
        ipcHandlers.delete(channel);
      },
    },
    session: {
      defaultSession: {
        webRequest: {
          onBeforeSendHeaders: () => {},
          onHeadersReceived: () => {},
        },
      },
      fromPartition: () => ({
        clearStorageData: async () => {},
        clearCache: async () => {},
        cookies: { get: async () => [] },
      }),
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        resize: () => ({ isEmpty: () => false }),
      }),
      createEmpty: () => ({ isEmpty: () => true }),
    },
    Menu: {
      buildFromTemplate: (tpl: any) => tpl,
      setApplicationMenu: () => {},
    },
    Tray: class MockTray {
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    shell: {
      openExternal: async (url: string) => {
        externalOpenedUrls.push(url);
      },
      openPath: async () => '',
      showItemInFolder: () => {},
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0 }),
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8'),
    },
  };

  if (options?.platform) {
    Object.defineProperty(process, 'platform', { value: options.platform, configurable: true });
  }
  if (options?.argv) {
    process.argv = options.argv;
  }

  (Module as any)._load = function patchedLoad(request: string, parent: any, isMain: boolean) {
    if (request === 'electron') return mockElectron;
    return origLoad.call(this, request, parent, isMain);
  };

  const req = Module.createRequire(mainPath);
  for (const key of Object.keys(req.cache)) {
    if (key === mainPath || key.startsWith(ipcDir)) {
      delete req.cache[key];
    }
  }
  req(mainPath);

  return {
    switches,
    ipcHandlers,
    createdWindows,
    externalOpenedUrls,
    async triggerReady() {
      resolveReady();
      await readyPromise;
      await new Promise((r) => setTimeout(r, 0));
    },
    async invokeIpc(channel: string, ...args: any[]) {
      const handler = ipcHandlers.get(channel);
      if (!handler) {
        throw new Error(`IPC channel not registered: ${channel}`);
      }
      return await handler({ sender: createdWindows[0]?.webContents }, ...args);
    },
    dispose() {
      (Module as any)._load = origLoad;
      if (options?.platform && origPlatform) {
        Object.defineProperty(process, 'platform', origPlatform);
      }
      if (options?.argv) {
        process.argv = origArgv;
      }
      for (const key of Object.keys(req.cache)) {
        if (key === mainPath || key.startsWith(ipcDir)) {
          delete req.cache[key];
        }
      }
    },
  };
}
