import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileAuthorityCommitLog } from "../../authority/index.js";
import { DeliveryAuthority } from "../index.js";
import { createDeliveryTestHarness } from "./delivery-test-harness.js";

vi.setConfig({ testTimeout: 15_000 });

/** 按优先级与种类取一页可领取条目的条目号。 */
async function claimableIds(
  authority: DeliveryAuthority,
  now: string,
  kind: "ready" | "retry" = "ready",
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (const priority of ["high", "normal", "low"] as const) {
    const page = await authority.claimablePage({ priority, kind, now, limit: 32 });
    ids.push(...page.items.map(({ item }) => item.id));
  }
  return ids;
}

describe("DeliveryAuthority directories", () => {
  it("rebuilds the claimable directory from the authority log on a cold instance", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    await fixture.log.stopStorageMaintenance();

    const coldLog = new FileAuthorityCommitLog(path.join(fixture.root, "authority"), fixture.artifacts);
    const cold = new DeliveryAuthority({ log: coldLog, anchorEpoch: 7 });
    try {
      await expect(claimableIds(cold, fixture.now().toISOString())).resolves.toEqual([itemId]);
      await expect(cold.stats()).resolves.toMatchObject({ pending: 1, queued: 1 });
    } finally {
      await coldLog.stopStorageMaintenance();
    }
  });

  it("exposes read-only directories that never own or mutate delivery facts", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;

    const page = await fixture.authority.claimablePage({
      priority: "normal",
      kind: "ready",
      now: fixture.now().toISOString(),
      limit: 8,
    });
    expect(page.items.map(({ item }) => item.id)).toEqual([itemId]);
    expect("enqueue" in fixture.authority).toBe(false);
    expect("remove" in fixture.authority).toBe(false);
    await expect(fixture.authority.get(itemId)).resolves.toMatchObject({ state: "queued" });
  });

  it("keeps terminal items readable but out of pending and claimable directories", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    const claim = await fixture.lifecycle.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    if (claim.kind !== "send") throw new Error("fixture claim failed");
    await fixture.lifecycle.recordOutcome({
      itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: { kind: "sent" },
    });

    await expect(fixture.authority.get(itemId)).resolves.toMatchObject({ state: "sent" });
    await expect(fixture.authority.pendingItems()).resolves.toHaveLength(0);
    await expect(claimableIds(fixture.authority, fixture.now().toISOString())).resolves.toEqual([]);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 0, delivered: 1 });
  });

  it("keeps uncertain items observable without making them claimable", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    await fixture.lifecycle.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    await fixture.lifecycle.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });

    const uncertain = await fixture.authority.uncertainPage(undefined, 8);
    expect(uncertain.items.map(({ item }) => [item.id, item.state])).toEqual([[itemId, "uncertain"]]);
    await expect(fixture.authority.pendingItems()).resolves.toEqual([
      expect.objectContaining({ id: itemId, state: "uncertain" }),
    ]);
    const now = fixture.now().toISOString();
    await expect(claimableIds(fixture.authority, now)).resolves.toEqual([]);
    await expect(claimableIds(fixture.authority, now, "retry")).resolves.toEqual([]);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 1, uncertain: 1 });
  });

  it("makes a retry claimable only once its next attempt is due", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    const claim = await fixture.lifecycle.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    if (claim.kind !== "send") throw new Error("fixture claim failed");
    const outcome = await fixture.lifecycle.recordOutcome({
      itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: {
        kind: "failed",
        error: { code: "unavailable", message: "temporarily unavailable", retryable: true },
      },
    });
    if (!outcome.accepted || !outcome.retryAt) throw new Error("fixture retry was not scheduled");

    const before = new Date(Date.parse(outcome.retryAt) - 1).toISOString();
    await expect(claimableIds(fixture.authority, before, "retry")).resolves.toEqual([]);
    await expect(claimableIds(fixture.authority, before)).resolves.toEqual([]);
    await expect(claimableIds(fixture.authority, outcome.retryAt, "retry")).resolves.toEqual([itemId]);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 1, retrying: 1 });
  });
});
