import { describe, expect, it, vi } from "vitest";
import { DedupCache } from "./dedup.js";

describe("DedupCache", () => {
  it("returns false on first occurrence, true on duplicate", () => {
    const cache = new DedupCache();
    expect(cache.isDuplicate("msg-1")).toBe(false);
    expect(cache.isDuplicate("msg-1")).toBe(true);
  });

  it("tracks distinct messages independently", () => {
    const cache = new DedupCache();
    expect(cache.isDuplicate("a")).toBe(false);
    expect(cache.isDuplicate("b")).toBe(false);
    expect(cache.size).toBe(2);
  });

  it("evicts oldest when maxSize reached", () => {
    const cache = new DedupCache({ maxSize: 2 });
    cache.isDuplicate("a");
    cache.isDuplicate("b");
    cache.isDuplicate("c"); // evicts "a"
    expect(cache.size).toBe(2);
    expect(cache.isDuplicate("a")).toBe(false); // "a" was evicted, treated as new
  });

  it("evicts expired entries", () => {
    const cache = new DedupCache({ ttlMs: 100 });
    cache.isDuplicate("old");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
    expect(cache.isDuplicate("old")).toBe(false); // expired, treated as new
    vi.restoreAllMocks();
  });

  it("clear() empties the cache", () => {
    const cache = new DedupCache();
    cache.isDuplicate("x");
    cache.isDuplicate("y");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.isDuplicate("x")).toBe(false);
  });
});
