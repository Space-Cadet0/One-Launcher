import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';

const DB_NAME = 'one-launcher-db';
const STORE_NAME = 'kv';

let cachedStore: UseStore | null = null;
let cachedIndexedDbRef: IDBFactory | null = null;

function getGlobalIndexedDb(): IDBFactory | null {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.indexedDB) {
      return globalThis.indexedDB;
    }
    if (typeof indexedDB !== 'undefined' && indexedDB !== null) {
      return indexedDB;
    }
  } catch {
    // Ignore restricted global access
  }
  return null;
}

function resetStoreOnTransientHandleError(err: unknown): void {
  const errName =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name?: unknown }).name || '')
      : '';
  if (errName === 'InvalidStateError' || errName === 'UnknownError' || errName === 'AbortError') {
    cachedStore = null;
    cachedIndexedDbRef = null;
  }
}

export function isIndexedDbAvailable(): boolean {
  return getGlobalIndexedDb() !== null;
}

function getVaultStore(): UseStore | null {
  const currentIdb = getGlobalIndexedDb();
  if (!currentIdb) {
    cachedStore = null;
    cachedIndexedDbRef = null;
    return null;
  }
  if (!cachedStore || cachedIndexedDbRef !== currentIdb) {
    try {
      cachedStore = createStore(DB_NAME, STORE_NAME);
      cachedIndexedDbRef = currentIdb;
    } catch {
      cachedStore = null;
      cachedIndexedDbRef = null;
    }
  }
  return cachedStore;
}

export async function vaultGet<T>(key: string): Promise<T | undefined> {
  const store = getVaultStore();
  if (!store) return undefined;
  try {
    return await get<T>(key, store);
  } catch (err) {
    resetStoreOnTransientHandleError(err);
    return undefined;
  }
}

export async function vaultSet<T>(key: string, value: T): Promise<boolean> {
  const store = getVaultStore();
  if (!store) return false;
  try {
    await set(key, value, store);
    return true;
  } catch (err) {
    resetStoreOnTransientHandleError(err);
    return false;
  }
}

export async function vaultDelete(key: string): Promise<boolean> {
  const store = getVaultStore();
  if (!store) return false;
  try {
    await del(key, store);
    return true;
  } catch (err) {
    resetStoreOnTransientHandleError(err);
    return false;
  }
}

export async function vaultEntries<
  K extends IDBValidKey = IDBValidKey,
  V = unknown,
>(): Promise<Array<[K, V]>> {
  const store = getVaultStore();
  if (!store) return [];
  try {
    return await entries<K, V>(store);
  } catch (err) {
    resetStoreOnTransientHandleError(err);
    return [];
  }
}
