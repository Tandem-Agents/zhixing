import {
  WORKSCENE_ACTIVITY_DURABLE_CONTRACT,
  WORKSCENE_REGISTRY_DURABLE_CONTRACT,
  WORKSPACE_BINDING_DURABLE_CONTRACT,
  WORKSPACE_BINDING_ROOT_DURABLE_CONTRACT,
  WORKSPACE_PROBE_DURABLE_CONTRACT,
} from "@zhixing/core";
import type { DurableRuntimeContractDescriptor } from "@zhixing/core/contracts";
import {
  ADVANCEMENT_DURABLE_CONTRACT,
  SESSION_ACTIVITY_DURABLE_CONTRACT,
} from "@zhixing/owner-kernel";
import { LOCAL_WORKSPACE_OPERATION_OUTBOX_DURABLE_CONTRACT } from "../runtime/local-workspace-operation-outbox.js";

export const S7_DURABLE_CONTRACT_LEDGER = [
  WORKSCENE_REGISTRY_DURABLE_CONTRACT,
  WORKSPACE_BINDING_DURABLE_CONTRACT,
  WORKSPACE_BINDING_ROOT_DURABLE_CONTRACT,
  WORKSPACE_PROBE_DURABLE_CONTRACT,
  SESSION_ACTIVITY_DURABLE_CONTRACT,
  ADVANCEMENT_DURABLE_CONTRACT,
  WORKSCENE_ACTIVITY_DURABLE_CONTRACT,
  LOCAL_WORKSPACE_OPERATION_OUTBOX_DURABLE_CONTRACT,
] as const satisfies readonly DurableRuntimeContractDescriptor[];

export interface S7DurableScenarioAdapter {
  readonly key: string;
  readonly family: string;
  readonly caseKey: string;
  readonly kind: "variant" | "rejection" | "corruption";
  readonly expectedReasonCode?: string;
}

export interface S7DurableScenarioObservation {
  readonly family: string;
  readonly kind: "variant" | "rejection" | "corruption";
  readonly caseKey: string;
  readonly reasonCode?: string;
  readonly evidence: string;
}

/**
 * Scenario identities are derived from production-owned descriptors. Test
 * implementations must register against these exact keys; no handwritten
 * family or branch inventory exists in the conformance layer.
 */
export function requiredS7DurableScenarios(): readonly S7DurableScenarioAdapter[] {
  return S7_DURABLE_CONTRACT_LEDGER.flatMap((descriptor) =>
    descriptor.cases.map((entry) => ({
      key: `${descriptor.recordFamily}:${entry.kind}:${entry.key}`,
      family: descriptor.recordFamily,
      caseKey: entry.key,
      kind: entry.kind,
      expectedReasonCode: entry.kind === "variant" ? undefined : entry.reasonCode,
    })),
  ).sort((left, right) => left.key.localeCompare(right.key, "en-US"));
}

export function assertExactS7ScenarioSet(
  implementations: ReadonlyMap<string, () => Promise<S7DurableScenarioObservation>>,
): void {
  const required = requiredS7DurableScenarios();
  const expected = required.map(({ key }) => key);
  const actual = [...implementations.keys()].sort((left, right) => left.localeCompare(right, "en-US"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((key) => !implementations.has(key));
    const extra = actual.filter((key) => !expected.includes(key));
    throw new Error(`S7 durable scenarios differ from production descriptors; missing=${missing.join("|")}; extra=${extra.join("|")}`);
  }
}

/**
 * Compares an independently observed production result with the canonical
 * descriptor entry. Scenario implementations never receive these expected
 * values, so they cannot pass by echoing the registry they are meant to test.
 */
export function assertS7DurableScenarioObservation(
  required: S7DurableScenarioAdapter,
  observation: S7DurableScenarioObservation,
): void {
  const expected = {
    family: required.family,
    kind: required.kind,
    caseKey: required.caseKey,
    reasonCode: required.expectedReasonCode,
  };
  const actual = {
    family: observation.family,
    kind: observation.kind,
    caseKey: observation.caseKey,
    reasonCode: observation.reasonCode,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `S7 durable scenario observation is not bound to ${required.key}; expected=${JSON.stringify(expected)}; actual=${JSON.stringify(actual)}`,
    );
  }
  if (typeof observation.evidence !== "string" || observation.evidence.trim().length === 0) {
    throw new Error(`S7 durable scenario ${required.key} has no production evidence`);
  }
}
