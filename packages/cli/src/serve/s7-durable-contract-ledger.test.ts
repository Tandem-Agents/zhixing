import { readFile } from "node:fs/promises";
import { withS7TemporaryDirectoryRoot } from "@zhixing/core/test-support/s7-durable-harness";
import { createTempDir } from "@zhixing/test-utils";
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
      "advancement-event",
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
    expect(
      requiredS7DurableScenarios()
        .filter(({ kind }) => kind === "variant")
        .every(({ expectedReasonCode }) => expectedReasonCode === undefined),
    ).toBe(true);
    expect(
      requiredS7DurableScenarios()
        .filter(({ kind }) => kind !== "variant")
        .every(({ expectedReasonCode }) => typeof expectedReasonCode === "string"),
    ).toBe(true);
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
      evidence: "ghost",
    }));
    expect(() => assertExactS7ScenarioSet(extra)).toThrow("extra=");
  });

  it("keeps descriptor expectations out of executable scenario observations", async () => {
    const [source, harness, coreScenarios, ownerScenarios, cliScenarios, coreCases, ownerCases, cliCases] =
      await Promise.all([
        "./__tests__/s7-durable-scenario-adapters.ts",
        "../../../core/src/test-support/s7-durable-harness.ts",
        "../../../core/src/test-support/s7-durable.ts",
        "../../../owner-kernel/src/test-support/s7-durable.ts",
        "./__tests__/s7-durable-runtime-witness.ts",
        "../../../core/src/test-support/s7-durable-scenarios.ts",
        "../../../owner-kernel/src/test-support/s7-durable-scenarios.ts",
        "./__tests__/s7-durable-cli-scenarios.ts",
      ].map((relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8")));
    expect(source).not.toContain("expectedReasonCode");
    expect(source).not.toContain("DURABLE_DESCRIPTORS");
    expect(source).not.toContain("descriptorScenarios");
    expect(source).not.toContain("reasonPrefix");
    expect(source).not.toContain("observeFamilyCase");
    expect(source).not.toContain("ScenarioRuntimeBinding");
    expect(source).not.toMatch(/const\s+[A-Z0-9_]+_CASES\s*=/u);
    expect(source).not.toContain("RECOVERY_OWNER_BY_RUNTIME");
    expect(source).not.toMatch(/entry\.reasonCode|descriptor\.(producer|recoveryOwner|resourceIdentity)/u);
    expect(source).not.toContain("observeOutcome(kind, caseKey)");
    expect(source).not.toContain("reasonCodeForOutcome(kind, caseKey)");
    expect(source).not.toContain(":observed");
    expect(source).toContain("@zhixing/core/test-support/s7-durable");

    for (const packageRegistry of [coreScenarios, ownerScenarios, cliScenarios]) {
      expect(packageRegistry).toContain("defineS7DurableScenarios");
      expect(packageRegistry).not.toContain("descriptor.cases.map");
      expect(packageRegistry).not.toContain("for (const item of descriptor.cases)");
      expect(packageRegistry).not.toContain("observedExecutor");
    }
    for (const scenarioSource of [harness, coreCases, ownerCases, cliCases]) {
      expect(scenarioSource).not.toContain("constructor.name");
      expect(scenarioSource).not.toContain("FAMILY_WITNESS");
      expect(scenarioSource).not.toContain("RECOVERY_OWNER_BY");
      expect(scenarioSource).not.toContain("commitObservedProductionWitnesses");
      expect(scenarioSource).not.toMatch(/observeProducer\s*\(/u);
      expect(scenarioSource).not.toMatch(/observeRecoveryOwner\s*\(/u);
      expect(scenarioSource).not.toMatch(/observeResource\s*\(/u);
      expect(scenarioSource).not.toMatch(/observeOutcome\s*\(\s*\{\s*kind\s*,\s*caseKey/u);
      expect(scenarioSource).not.toMatch(/observeProducerHandle\s*\(\s*[A-Z0-9_]+_DURABLE_CONTRACT/u);
      expect(scenarioSource).not.toMatch(/observeRecoveryOwnerHandle\s*\(\s*[A-Z0-9_]+_DURABLE_CONTRACT/u);
      expect(scenarioSource).not.toContain("observeProducerHandle");
      expect(scenarioSource).not.toContain("observeRecoveryOwnerHandle");
    }

    const mainWorksceneExports = await readFile(
      new URL("../../../core/src/workscene/index.ts", import.meta.url),
      "utf8",
    );
    expect(mainWorksceneExports).not.toContain("AnchorWorksceneRegistry,");
    expect(mainWorksceneExports).not.toContain("IncrementalWorksceneActivityProjection,");
  });

  it.each(S7_DURABLE_CONTRACT_LEDGER.map(({ recordFamily }) => recordFamily))(
    "executes every %s durable branch through its real witness",
    async (family) => {
    const temporaryDirectoryRoot = await createTempDir("s7-durable-ledger");
    const implementations = createS7DurableScenarioAdapters();
    assertExactS7ScenarioSet(implementations);
    for (const required of requiredS7DurableScenarios().filter(
      ({ family: candidate }) => candidate === family,
    )) {
      const execute = implementations.get(required.key);
      if (!execute) throw new Error(`Missing S7 scenario ${required.key}`);
      assertS7DurableScenarioObservation(
        required,
        await withS7TemporaryDirectoryRoot(temporaryDirectoryRoot, execute),
      );
    }
    },
    120_000,
  );

  it("rejects forged case, reason and empty evidence independently", async () => {
    const temporaryDirectoryRoot = await createTempDir("s7-durable-ledger-forgery");
    const required = requiredS7DurableScenarios()[0]!;
    const execute = createS7DurableScenarioAdapters().get(required.key)!;
    const observed = await withS7TemporaryDirectoryRoot(temporaryDirectoryRoot, execute);
    for (const mutation of [
      { ...observed, caseKey: `${observed.caseKey}-forged` },
      { ...observed, reasonCode: `${observed.reasonCode}_FORGED` },
      { ...observed, evidence: "" },
    ]) {
      expect(() => assertS7DurableScenarioObservation(required, mutation)).toThrow();
    }
    for (const forgedExpectation of [
      {
        ...required,
        expectedReasonCode: `${required.expectedReasonCode}_FORGED`,
      },
    ]) {
      expect(() =>
        assertS7DurableScenarioObservation(forgedExpectation, observed),
      ).toThrow();
    }
  });
});
