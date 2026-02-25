export class TTLCache {
  constructor({ ttlMs = 60000, max = 500 } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.max = Math.max(1, Number(max) || 500);
    this.store = new Map();
  }

  _isExpired(entry) {
    return !!entry && entry.expAt <= Date.now();
  }

  _pruneExpired() {
    for (const [k, v] of this.store.entries()) {
      if (this._isExpired(v)) this.store.delete(k);
    }
  }

  _trimToMax() {
    while (this.store.size > this.max) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    const ttl = Math.max(0, Number(ttlMs) || 0);
    const expAt = Date.now() + ttl;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expAt });
    this._pruneExpired();
    this._trimToMax();
    return value;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}
