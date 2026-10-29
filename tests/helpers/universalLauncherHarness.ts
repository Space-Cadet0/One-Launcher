import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

export const mockStorage = new MockStorage();

export function installUniversalLauncherBrowserMocks(): void {
  if (typeof (globalThis as any).localStorage === 'undefined') {
    (globalThis as any).localStorage = mockStorage;
  }

  if (typeof (globalThis as any).CustomEvent === 'undefined') {
    (globalThis as any).CustomEvent = class CustomEvent {
      type: string;
      detail: any;
      constructor(type: string, init?: any) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }

  const windowEventListeners: Record<string, Function[]> = {};
  if (typeof (globalThis as any).window === 'undefined') {
    (globalThis as any).window = {
      localStorage: mockStorage,
      location: { hostname: '' },
      addEventListener: (event: string, fn: Function) => {
        windowEventListeners[event] = windowEventListeners[event] || [];
        windowEventListeners[event].push(fn);
      },
      removeEventListener: (event: string, fn: Function) => {
        if (windowEventListeners[event]) {
          windowEventListeners[event] = windowEventListeners[event].filter((f) => f !== fn);
        }
      },
      dispatchEvent: (event: any) => {
        const fns = (windowEventListeners[event.type] || []).slice();
        fns.forEach((f) => f(event));
        return true;
      },
    };
  } else if (!(globalThis as any).window.localStorage) {
    (globalThis as any).window.localStorage = mockStorage;
  }
}

export function writeTempFile(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
  if (mode !== undefined && process.platform !== 'win32') {
    fs.chmodSync(filePath, mode);
  }
}

const cjsRequire = createRequire(import.meta.url);
export const launcherEngine = cjsRequire('../../electron/launcherEngine.cjs');
