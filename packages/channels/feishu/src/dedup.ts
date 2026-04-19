export interface DedupCacheOptions {
  ttlMs?: number;
  maxSize?: number;
}

export class DedupCache {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly entries = new Map<string, number>();

  constructor(options?: DedupCacheOptions) {
    this.ttlMs = options?.ttlMs ?? 86_400_000;
    this.maxSize = options?.maxSize ?? 2048;
  }

  isDuplicate(messageId: string): boolean {
    this.evictExpired();

    if (this.entries.has(messageId)) {
      return true;
    }

    if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
    }

    this.entries.set(messageId, Date.now());
    return false;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.entries) {
      if (ts > cutoff) break;
      this.entries.delete(id);
    }
  }
}
