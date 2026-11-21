/**
 * Generic O(1) Map-backed Least Recently Used (LRU) cache and bounded Set primitives.
 * Pure Layer 0 foundation utility (`services-foundation`) with zero upward dependencies.
 */

function normalizeMaxEntries(maxEntries: number): number {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    return 0;
  }
  return Math.floor(maxEntries);
}

/**
 * O(1) Map-backed LRU cache maintaining recency order via Map insertion order.
 */
export class LruMap<K, V> implements Iterable<[K, V]> {
  private readonly store = new Map<K, V>();
  private readonly capacity: number;

  constructor(maxEntries: number) {
    this.capacity = normalizeMaxEntries(maxEntries);
  }

  get maxEntries(): number {
    return this.capacity;
  }

  get size(): number {
    return this.store.size;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  /**
   * Returns the value for `key` and marks it as most-recently-used.
   */
  get(key: K): V | undefined {
    if (!this.store.has(key)) {
      return undefined;
    }
    const value = this.store.get(key) as V;
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  /**
   * Returns the value for `key` without modifying recency order.
   */
  peek(key: K): V | undefined {
    return this.store.get(key);
  }

  /**
   * Inserts or updates `key` as most-recently-used, evicting the oldest entries if over capacity.
   */
  set(key: K, value: V): this {
    if (this.capacity <= 0) {
      this.store.clear();
      return this;
    }
    if (this.store.has(key)) {
      this.store.delete(key);
    } else {
      while (this.store.size >= this.capacity) {
        const oldest = this.store.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.store.delete(oldest);
      }
    }
    this.store.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  keys(): IterableIterator<K> {
    return this.store.keys();
  }

  values(): IterableIterator<V> {
    return this.store.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.store.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.store.entries();
  }

  forEach(callbackfn: (value: V, key: K, map: LruMap<K, V>) => void): void {
    this.store.forEach((value, key) => {
      callbackfn(value, key, this);
    });
  }

  /**
   * Evicts entries from the cache:
   * - When given a predicate `(value, key) => boolean`, deletes every matching entry.
   * - When given a target size `number`, evicts least-recently-used entries until `size <= target`.
   * - When omitted, trims oldest entries to enforce `maxEntries`.
   *
   * Returns the count of evicted entries.
   */
  prune(predicateOrTargetSize?: number | ((value: V, key: K) => boolean)): number {
    let removed = 0;
    if (typeof predicateOrTargetSize === 'function') {
      const keysToDelete: K[] = [];
      for (const [key, value] of this.store.entries()) {
        if (predicateOrTargetSize(value, key)) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        if (this.store.delete(key)) {
          removed += 1;
        }
      }
      return removed;
    }

    const targetSize =
      predicateOrTargetSize === undefined
        ? this.capacity
        : normalizeMaxEntries(predicateOrTargetSize);

    while (this.store.size > targetSize) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      if (this.store.delete(oldest)) {
        removed += 1;
      } else {
        break;
      }
    }
    return removed;
  }
}

/**
 * O(1) Set-backed bounded LRU set preserving recency order.
 */
export class LruSet<T> implements Iterable<T> {
  private readonly store = new Set<T>();
  private readonly capacity: number;

  constructor(maxEntries: number) {
    this.capacity = normalizeMaxEntries(maxEntries);
  }

  get maxEntries(): number {
    return this.capacity;
  }

  get size(): number {
    return this.store.size;
  }

  has(value: T): boolean {
    return this.store.has(value);
  }

  add(value: T): this {
    if (this.capacity <= 0) {
      this.store.clear();
      return this;
    }
    if (this.store.has(value)) {
      this.store.delete(value);
    } else {
      while (this.store.size >= this.capacity) {
        const oldest = this.store.values().next().value;
        if (oldest === undefined) {
          break;
        }
        this.store.delete(oldest);
      }
    }
    this.store.add(value);
    return this;
  }

  delete(value: T): boolean {
    return this.store.delete(value);
  }

  clear(): void {
    this.store.clear();
  }

  values(): IterableIterator<T> {
    return this.store.values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.store.values();
  }

  prune(predicateOrTargetSize?: number | ((value: T) => boolean)): number {
    let removed = 0;
    if (typeof predicateOrTargetSize === 'function') {
      const toDelete: T[] = [];
      for (const value of this.store.values()) {
        if (predicateOrTargetSize(value)) {
          toDelete.push(value);
        }
      }
      for (const value of toDelete) {
        if (this.store.delete(value)) {
          removed += 1;
        }
      }
      return removed;
    }

    const targetSize =
      predicateOrTargetSize === undefined
        ? this.capacity
        : normalizeMaxEntries(predicateOrTargetSize);

    while (this.store.size > targetSize) {
      const oldest = this.store.values().next().value;
      if (oldest === undefined) {
        break;
      }
      if (this.store.delete(oldest)) {
        removed += 1;
      } else {
        break;
      }
    }
    return removed;
  }
}
