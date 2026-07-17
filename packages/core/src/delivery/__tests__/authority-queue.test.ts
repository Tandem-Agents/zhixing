import { describe, expect, it, vi } from "vitest";
import { AuthorityDeliveryQueue } from "../authority-queue.js";
import { createDeliveryTestHarness } from "./delivery-test-harness.js";

vi.setConfig({ testTimeout: 15_000 });

describe("AuthorityDeliveryQueue projection", () => {
  it("rebuilds queued items from the authority log", async () => {
    const fixture = await createDeliveryTestHarness();
    await fixture.enqueue();
    const queue = new AuthorityDeliveryQueue({ authority: fixture.authority });

    await expect(queue.load()).resolves.toBe(1);
    expect(queue.getReady(fixture.now())).toHaveLength(1);
  });

  it("never owns or mutates delivery facts", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    const queue = new AuthorityDeliveryQueue({ authority: fixture.authority });
    await queue.load();

    expect("enqueue" in queue).toBe(false);
    expect("remove" in queue).toBe(false);
    expect(queue.all[0]?.id).toBe(itemId);
  });

  it("projects terminal items but excludes them from pending and ready", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    const claim = await fixture.authority.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    if (claim.kind !== "send") throw new Error("fixture claim failed");
    await fixture.authority.recordOutcome({
      itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: { kind: "sent" },
    });
    const queue = new AuthorityDeliveryQueue({ authority: fixture.authority });

    await queue.load();
    expect(queue.all[0]?.state).toBe("sent");
    expect(queue.pending).toHaveLength(0);
    expect(queue.getReady(fixture.now())).toHaveLength(0);
  });

  it("keeps uncertain items observable without making them sendable", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    await fixture.authority.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    await fixture.authority.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    const queue = new AuthorityDeliveryQueue({ authority: fixture.authority });

    await queue.load();
    expect(queue.pending[0]?.state).toBe("uncertain");
    expect(queue.getReady(fixture.now())).toHaveLength(0);
  });
});
