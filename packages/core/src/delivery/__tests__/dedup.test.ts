import { describe, it, expect, vi, afterEach } from "vitest";
import { DedupFilter } from "../dedup.js";
import type { DeliveryItem } from "../types.js";

function makeItem(overrides?: Partial<DeliveryItem>): DeliveryItem {
  return {
    id: "dlv_test",
    target: { channelId: "feishu", to: "user1" },
    content: { text: "hello world" },
    priority: "normal",
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("DedupFilter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes first occurrence", () => {
    const dedup = new DedupFilter();
    const item = makeItem();
    expect(dedup.check(item)).toEqual({ pass: true });
  });

  it("rejects duplicate after record", () => {
    const dedup = new DedupFilter();
    const item = makeItem();

    dedup.record(item);
    const verdict = dedup.check(item);
    expect(verdict.pass).toBe(false);
  });

  it("passes same content to different targets", () => {
    const dedup = new DedupFilter();
    const item1 = makeItem({ target: { channelId: "feishu", to: "user1" } });
    const item2 = makeItem({ target: { channelId: "feishu", to: "user2" } });

    dedup.record(item1);
    expect(dedup.check(item2)).toEqual({ pass: true });
  });

  it("passes different content to same target", () => {
    const dedup = new DedupFilter();
    const item1 = makeItem({ content: { text: "message A" } });
    const item2 = makeItem({ content: { text: "message B" } });

    dedup.record(item1);
    expect(dedup.check(item2)).toEqual({ pass: true });
  });

  it("evicts entries outside the window", () => {
    const dedup = new DedupFilter({ windowMs: 1000 });
    const item = makeItem();

    dedup.record(item);
    expect(dedup.check(item).pass).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    expect(dedup.check(item)).toEqual({ pass: true });
  });
});
