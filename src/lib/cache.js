/**
 * Small in-memory TTL + LRU cache with in-flight request de-duplication.
 * Keeps upstream API usage (and latency) low when many users ask about the same city.
 */
export class TtlCache {
  #store = new Map();
  #inflight = new Map();
  #ttlMs;
  #maxEntries;
  #now;

  /**
   * @param {{ ttlMs: number, maxEntries?: number, now?: () => number }} options
   */
  constructor({ ttlMs, maxEntries = 500, now = Date.now }) {
    if (!(ttlMs > 0)) throw new TypeError('ttlMs must be a positive number');
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  get size() {
    return this.#store.size;
  }

  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#store.delete(key);
      return undefined;
    }
    // Refresh recency for LRU eviction.
    this.#store.delete(key);
    this.#store.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#store.has(key)) {
      this.#store.delete(key);
    } else if (this.#store.size >= this.#maxEntries) {
      const oldestKey = this.#store.keys().next().value;
      this.#store.delete(oldestKey);
    }
    this.#store.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
  }

  /**
   * Return the cached value or compute it once, sharing the pending promise
   * between concurrent callers. Failures are never cached.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} producer
   * @returns {Promise<T>}
   */
  async wrap(key, producer) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.#inflight.has(key)) return this.#inflight.get(key);

    const pending = (async () => {
      try {
        const value = await producer();
        this.set(key, value);
        return value;
      } finally {
        this.#inflight.delete(key);
      }
    })();
    this.#inflight.set(key, pending);
    return pending;
  }
}
