import { describe, expect, it } from "vitest";
import {
  S7_DURABLE_CONTRACT_LEDGER,
  assertExactS7ScenarioSet,
  requiredS7DurableScenarios,
} from "./s7-durable-contract-ledger.js";

describe("S7 production durable contract registry", () => {
  it("aggregates every production-owned descriptor exactly once", () => {
    expect(S7_DURABLE_CONTRACT_LEDGER.map(({ recordFamily }) => recordFamily).sort()).toEqual([
      "legacy-workscene-migration",
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
    const complete = new Map(requiredS7DurableScenarios().map((scenario) => [
      scenario.key,
      async () => ({ reasonCode: scenario.expectedReasonCode }),
    ]));
    expect(() => assertExactS7ScenarioSet(complete)).not.toThrow();
    const missing = new Map(complete);
    missing.delete(requiredS7DurableScenarios()[0]!.key);
    expect(() => assertExactS7ScenarioSet(missing)).toThrow("missing=");
    const extra = new Map(complete).set("not-production:variant:ghost", async () => ({ reasonCode: "GHOST" }));
    expect(() => assertExactS7ScenarioSet(extra)).toThrow("extra=");
  });
});
