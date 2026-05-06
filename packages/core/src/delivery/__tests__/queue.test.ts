import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { DeliveryQueue } from "../queue.js";
import type { DeliveryItem } from "../types.js";

function makeItem(overrides?: Partial<DeliveryItem>): DeliveryItem {
  return {
    id: `dlv_test_${Math.random().toString(36).slice(2, 6)}`,
    target: { channelId: "feishu", to: "user1" },
    content: { text: "hello" },
    priority: "normal",
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("DeliveryQueue", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("dq");
    filePath = join(tempDir, "queue.json");
  });

  it("starts empty when file does not exist", async () => {
    const queue = new DeliveryQueue({ filePath });
    const loaded = await queue.load();
    expect(loaded).toBe(0);
    expect(queue.size).toBe(0);
  });

  it("enqueue and save persists to disk", async () => {
    const queue = new DeliveryQueue({ filePath });
    await queue.load();

    const item = makeItem();
    queue.enqueue(item);
    expect(queue.size).toBe(1);

    await queue.save();
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(item.id);
  });

  it("load restores persisted items", async () => {
    const q1 = new DeliveryQueue({ filePath });
    await q1.load();
    q1.enqueue(makeItem({ id: "a" }));
    q1.enqueue(makeItem({ id: "b" }));
    await q1.save();

    const q2 = new DeliveryQueue({ filePath });
    const loaded = await q2.load();
    expect(loaded).toBe(2);
    expect(q2.size).toBe(2);
  });

  it("remove deletes item by id", async () => {
    const queue = new DeliveryQueue({ filePath });
    await queue.load();
    queue.enqueue(makeItem({ id: "keep" }));
    queue.enqueue(makeItem({ id: "remove" }));

    expect(queue.remove("remove")).toBe(true);
    expect(queue.size).toBe(1);
    expect(queue.all[0]!.id).toBe("keep");
  });

  it("remove returns false for unknown id", async () => {
    const queue = new DeliveryQueue({ filePath });
    await queue.load();
    expect(queue.remove("nonexistent")).toBe(false);
  });

  it("getReady returns items without nextAttemptAt", async () => {
    const queue = new DeliveryQueue({ filePath });
    await queue.load();
    queue.enqueue(makeItem({ id: "ready" }));
    queue.enqueue(makeItem({ id: "waiting", nextAttemptAt: "2099-01-01T00:00:00Z" }));

    const ready = queue.getReady(new Date());
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe("ready");
  });

  it("getReady returns items whose nextAttemptAt is past", async () => {
    const queue = new DeliveryQueue({ filePath });
    await queue.load();
    queue.enqueue(makeItem({ id: "past", nextAttemptAt: "2020-01-01T00:00:00Z" }));

    const ready = queue.getReady(new Date());
    expect(ready).toHaveLength(1);
  });

  it("save is no-op when not dirty", async () => {
    const queue = new DeliveryQueue({ filePath });
    await queue.load();
    await queue.save();

    // File should not exist since queue is empty and not dirty
    try {
      await readFile(filePath, "utf-8");
      expect.fail("File should not exist");
    } catch {
      // expected
    }
  });

  it("markDirty forces save", async () => {
    const queue = new DeliveryQueue({ filePath });
    await queue.load();
    queue.enqueue(makeItem());
    await queue.save();

    // Load into new queue, mark dirty, save again
    const q2 = new DeliveryQueue({ filePath });
    await q2.load();
    q2.markDirty();
    await q2.save();

    const raw = await readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toHaveLength(1);
  });
});
