import { describe, expect, it } from "vitest";
import { StartupRollback } from "../startup-rollback.js";

describe("StartupRollback", () => {
  it("releases acquired resources in reverse order and continues after failure", async () => {
    const order: string[] = [];
    const rollback = new StartupRollback();
    rollback.register("first", () => order.push("first"));
    rollback.register("second", () => {
      order.push("second");
      throw new Error("second failed");
    });
    rollback.register("third", async () => {
      order.push("third");
    });

    await expect(rollback.rollback()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("shares one idempotent cleanup between startup rollback and normal shutdown", async () => {
    let calls = 0;
    const rollback = new StartupRollback();
    const handle = rollback.register("resource", () => {
      calls += 1;
    });

    await handle.run();
    await rollback.rollback();
    await handle.run();

    expect(calls).toBe(1);
  });

  it("drops rollback ownership only after commit", async () => {
    let calls = 0;
    const rollback = new StartupRollback();
    const handle = rollback.register("resource", () => {
      calls += 1;
    });

    rollback.commit();
    await rollback.rollback();
    expect(calls).toBe(0);

    await handle.run();
    expect(calls).toBe(1);
  });
});
