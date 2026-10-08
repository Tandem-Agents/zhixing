import { describe, expect, it } from "vitest";
import {
  reloadCoreHostAfterConfig,
  settleConfigPostCommitEffects,
} from "../configuration-application.js";



describe("settleConfigPostCommitEffects", () => {
  it.each([
    [false, false, ["reload", "reconcile"]],
    [true, false, ["reload", "reconcile"]],
    [false, true, ["reload", "reconcile"]],
    [true, true, ["reload", "reconcile"]],
  ] as const)(
    "terminates reload failure=%s and reconcile failure=%s independently",
    async (reloadFails, reconcileFails, expectedOrder) => {
      const order: string[] = [];
      const result = await settleConfigPostCommitEffects({
        launchSelectionChanged: true,
        reload: async (options) => {
          order.push("reload");
          expect(options).toEqual({ launchSelectionChanged: true });
          if (reloadFails) throw new Error("reload response lost");
          return { channels: [] };
        },
        reconcile: async () => {
          order.push("reconcile");
          if (reconcileFails) throw new Error("reconcile failed");
        },
      });

      expect(order).toEqual(expectedOrder);
      expect(result.reload.status).toBe(reloadFails ? "failed" : "succeeded");
      expect(result.reconcile.status).toBe(reconcileFails ? "failed" : "succeeded");
    },
  );

  it("does not reconcile when the durable launch selection is unchanged", async () => {
    const order: string[] = [];
    const result = await settleConfigPostCommitEffects({
      launchSelectionChanged: false,
      reload: async (options) => {
        order.push("reload");
        expect(options).toEqual({ launchSelectionChanged: false });
      },
      reconcile: async () => {
        order.push("reconcile");
      },
    });

    expect(order).toEqual(["reload"]);
    expect(result.reconcile).toEqual({ status: "not-required" });
  });
});

describe("reloadCoreHostAfterConfig", () => {
  it("drains, disables future launch before exact turnover, then refreshes the successor", async () => {
    const order: string[] = [];
    await expect(reloadCoreHostAfterConfig({
      options: { launchSelectionChanged: true },
      requestDrainShutdown: async () => { order.push("drain-request"); },
      reconnect: async ({ beforeTurnover }) => {
        order.push("old-client-closed");
        await beforeTurnover?.();
        order.push("old-endpoint-turnover");
        order.push("successor-connected");
      },
      prepareManagedServiceTurnover: async () => { order.push("future-disabled"); },
      refresh: async () => {
        order.push("refresh");
        return { channels: [] };
      },
    })).resolves.toEqual({ channels: [] });
    expect(order).toEqual([
      "drain-request",
      "old-client-closed",
      "future-disabled",
      "old-endpoint-turnover",
      "successor-connected",
      "refresh",
    ]);
  });

  it("preserves a lost shutdown response while still completing future and turnover effects", async () => {
    const order: string[] = [];
    const lost = new Error("shutdown response lost");
    await expect(reloadCoreHostAfterConfig({
      options: { launchSelectionChanged: true },
      requestDrainShutdown: async () => {
        order.push("drain-request");
        throw lost;
      },
      reconnect: async ({ beforeTurnover }) => {
        await beforeTurnover?.();
        order.push("turnover");
      },
      prepareManagedServiceTurnover: async () => { order.push("future-disabled"); },
      refresh: async () => { order.push("refresh"); },
    })).rejects.toBe(lost);
    expect(order).toEqual(["drain-request", "future-disabled", "turnover", "refresh"]);
  });

  it("does not run the future-only step when launch selection is unchanged", async () => {
    let prepared = false;
    await reloadCoreHostAfterConfig({
      options: { launchSelectionChanged: false },
      requestDrainShutdown: async () => {},
      reconnect: async ({ beforeTurnover }) => {
        expect(beforeTurnover).toBeUndefined();
      },
      prepareManagedServiceTurnover: async () => { prepared = true; },
      refresh: async () => {},
    });
    expect(prepared).toBe(false);
  });
});
