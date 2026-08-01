import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  S7_DURABLE_CONTRACT_LEDGER,
  assertExactS7ScenarioSet,
  assertS7DurableScenarioObservation,
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
    const extra = new Map(complete).set("not-production:variant:ghost", async () => ({
      family: "not-production",
      kind: "variant" as const,
      caseKey: "ghost",
      reasonCode: "GHOST",
      producer: "ghost",
      recoveryOwner: "ghost",
      resourceIdentity: "ghost",
      evidence: "ghost",
    }));
    expect(() => assertExactS7ScenarioSet(extra)).toThrow("extra=");
  });

  it("keeps descriptor expectations out of executable scenario observations", async () => {
    const source = await readFile(
      new URL("./__tests__/s7-durable-scenario-adapters.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("expectedReasonCode");
    expect(source).not.toContain("DURABLE_DESCRIPTORS");
    expect(source).not.toContain("DURABLE_CONTRACT");
    expect(source).not.toContain("descriptorScenarios");
    expect(source).not.toContain("reasonPrefix");
    expect(source).not.toContain("observeFamilyCase");
    expect(source).not.toContain("ScenarioRuntimeBinding");
    expect(source).not.toMatch(/entry\.reasonCode|descriptor\.(producer|recoveryOwner|resourceIdentity)/u);
    expect(source).not.toContain(":observed");
  });

  it.each(S7_DURABLE_CONTRACT_LEDGER.map(({ recordFamily }) => recordFamily))(
    "executes every %s durable branch through its real witness",
    async (family) => {
    const implementations = createS7DurableScenarioAdapters();
    assertExactS7ScenarioSet(implementations);
    for (const required of requiredS7DurableScenarios().filter(
      ({ family: candidate }) => candidate === family,
    )) {
      const execute = implementations.get(required.key);
      if (!execute) throw new Error(`Missing S7 scenario ${required.key}`);
      assertS7DurableScenarioObservation(required, await execute());
    }
    },
    120_000,
  );

  it("rejects forged case, reason, owner and empty evidence independently", async () => {
    const required = requiredS7DurableScenarios()[0]!;
    const execute = createS7DurableScenarioAdapters().get(required.key)!;
    const observed = await execute();
    for (const mutation of [
      { ...observed, caseKey: `${observed.caseKey}-forged` },
      { ...observed, reasonCode: `${observed.reasonCode}_FORGED` },
      { ...observed, producer: `${observed.producer}-forged` },
      { ...observed, recoveryOwner: `${observed.recoveryOwner}-forged` },
      { ...observed, resourceIdentity: "not-the-required-resource" },
      { ...observed, evidence: "" },
    ]) {
      expect(() => assertS7DurableScenarioObservation(required, mutation)).toThrow();
    }
    for (const forgedExpectation of [
      {
        ...required,
        expectedReasonCode: `${required.expectedReasonCode}_FORGED`,
      },
      {
        ...required,
        expectedProducer: `${required.expectedProducer}-forged`,
      },
      {
        ...required,
        expectedRecoveryOwner: `${required.expectedRecoveryOwner}-forged`,
      },
      {
        ...required,
        expectedResourceIdentity: `${required.expectedResourceIdentity}-forged`,
      },
    ]) {
      expect(() =>
        assertS7DurableScenarioObservation(forgedExpectation, observed),
      ).toThrow();
    }
  });
});
