import { createStore, del, get, set, type UseStore } from 'idb-keyval';

const DB_NAME = 'one-launcher-db';
const STORE_NAME = 'kv';

let cachedStore: UseStore | null = null;

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function getVaultStore(): UseStore | null {
  if (!isIndexedDbAvailable()) return null;
  if (!cachedStore) {
    try {
      cachedStore = createStore(DB_NAME, STORE_NAME);
    } catch {
      cachedStore = null;
    }
  }
  return cachedStore;
}

export async function vaultGet<T>(key: string): Promise<T | undefined> {
  const store = getVaultStore();
  if (!store) return undefined;
  try {
    return await get<T>(key, store);
  } catch {
    return undefined;
  }
}

export async function vaultSet<T>(key: string, value: T): Promise<boolean> {
  const store = getVaultStore();
  if (!store) return false;
  try {
    await set(key, value, store);
    return true;
  } catch {
    return false;
  }
}

export async function vaultDelete(key: string): Promise<boolean> {
  const store = getVaultStore();
  if (!store) return false;
  try {
    await del(key, store);
    return true;
  } catch {
    return false;
  }
}
