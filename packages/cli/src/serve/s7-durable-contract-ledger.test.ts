import { describe, expect, it } from "vitest";
import {
  S7_DURABLE_CONTRACT_LEDGER,
  assertExactS7ScenarioSet,
  requiredS7DurableScenarios,
} from "./s7-durable-contract-ledger.js";
import { createS7DurableScenarioAdapters } from "./__tests__/s7-durable-scenario-adapters.js";

describe("S7 production durable contract registry", () => {
  it("aggregates every production-owned descriptor exactly once", () => {
    expect(S7_DURABLE_CONTRACT_LEDGER.map(({ recordFamily }) => recordFamily).sort()).toEqual([
      "legacy-workscene-migration",
      "local-workspace-operation-outbox",
      "session-activity",
      "workscene-activity-projection",
      "workscene-registry",
      "workspace-binding",
      "workspace-binding-root",
      "workspace-probe",
    ]);
    expect(new Set(requiredS7DurableScenarios().map(({ key }) => key)).size)
      .toBe(requiredS7DurableScenarios().length);
  });

  it("fails closed for either a missing or an extra executable scenario", () => {
    const complete = createS7DurableScenarioAdapters();
    expect(() => assertExactS7ScenarioSet(complete)).not.toThrow();
    const missing = new Map(complete);
    missing.delete(requiredS7DurableScenarios()[0]!.key);
    expect(() => assertExactS7ScenarioSet(missing)).toThrow("missing=");
    const extra = new Map(complete).set("not-production:variant:ghost", async () => ({ reasonCode: "GHOST" }));
    expect(() => assertExactS7ScenarioSet(extra)).toThrow("extra=");
  });

  it("executes every production durable branch through its real witness", async () => {
    const implementations = createS7DurableScenarioAdapters();
    assertExactS7ScenarioSet(implementations);
    for (const required of requiredS7DurableScenarios()) {
      const execute = implementations.get(required.key);
      if (!execute) throw new Error(`Missing S7 scenario ${required.key}`);
      await expect(execute()).resolves.toEqual({
        reasonCode: required.expectedReasonCode,
      });
    }
  }, 120_000);

  it("executes the local workspace durable branches directly", async () => {
    const implementations = createS7DurableScenarioAdapters();
    for (const required of requiredS7DurableScenarios().filter(({ family }) =>
      family === "workspace-binding" ||
      family === "local-workspace-operation-outbox")) {
      const execute = implementations.get(required.key);
      if (!execute) throw new Error(`Missing S7 scenario ${required.key}`);
      await expect(execute()).resolves.toEqual({
        reasonCode: required.expectedReasonCode,
      });
    }
  }, 30_000);
});
