import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../events/index.js";
import {
  LegacyDeliveryDrainer,
  type LegacyDeliveryDrainerConfig,
} from "../legacy-drainer.js";
import type { DeliveryEventMap, DeliveryItem } from "../types.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function item(): DeliveryItem {
  return {
    id: "legacy-item-1",
    target: { channelId: "feishu", to: "chat-1", threadId: "thread-1" },
    content: { text: "hello" },
    priority: "normal",
    source: { kind: "scheduler", taskId: "task-1", taskName: "task" },
    createdAt: "2026-08-02T00:00:00.000Z",
    attempts: 0,
    maxAttempts: 3,
  };
}

async function fixture(send: ReturnType<typeof vi.fn>) {
  const home = await mkdtemp(path.join(tmpdir(), "legacy-delivery-"));
  homes.push(home);
  const queueFilePath = path.join(home, "delivery-queue.json");
  await writeFile(queueFilePath, JSON.stringify([item()]), "utf8");
  const now = { value: new Date("2026-08-02T00:00:00.000Z") };
  const config: LegacyDeliveryDrainerConfig = {
    maxAttempts: 3,
    baseRetryDelayMs: 1,
    flushIntervalMs: 0,
    queueFilePath,
    itemTtlMs: 60_000,
  };
  const drainer = new LegacyDeliveryDrainer({
    sender: { send, isReady: () => true },
    eventBus: createEventBus<DeliveryEventMap>(),
    config,
    now: () => now.value,
  });
  return { drainer, queueFilePath, now };
}

describe("LegacyDeliveryDrainer", () => {
  it("drains the retired queue with the original item identity and removes it", async () => {
    const send = vi.fn(async () => ({ success: true, retryable: false }));
    const { drainer, queueFilePath } = await fixture(send);

    await drainer.start();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
      { text: "hello" },
      expect.objectContaining({
        itemId: "legacy-item-1",
        idempotencyKey: "legacy-item-1",
      }),
    );
    await expect(readFile(queueFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect("enqueue" in drainer).toBe(false);
    await drainer.stop();
  });

  it("redrives a response-loss retry with the same identity", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ success: true, retryable: false });
    const { drainer, now } = await fixture(send);

    await drainer.start();
    expect(drainer.stats().retrying).toBe(1);
    now.value = new Date("2026-08-02T00:00:00.010Z");
    await drainer.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[2]?.idempotencyKey)).toEqual([
      "legacy-item-1",
      "legacy-item-1",
    ]);
    expect(drainer.stats().queued).toBe(0);
    await drainer.stop();
  });

  it("fails closed without overwriting a corrupt legacy queue", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "legacy-delivery-corrupt-"));
    homes.push(home);
    const queueFilePath = path.join(home, "delivery-queue.json");
    await writeFile(queueFilePath, "{broken", "utf8");
    const drainer = new LegacyDeliveryDrainer({
      sender: { send: vi.fn(), isReady: () => true },
      eventBus: createEventBus<DeliveryEventMap>(),
      config: {
        maxAttempts: 3,
        baseRetryDelayMs: 1,
        flushIntervalMs: 0,
        queueFilePath,
        itemTtlMs: 60_000,
      },
    });

    await expect(drainer.start()).rejects.toThrow();
    await expect(readFile(queueFilePath, "utf8")).resolves.toBe("{broken");
  });
});
