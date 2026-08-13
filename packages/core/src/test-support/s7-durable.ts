// Non-production seam for executing durable recovery scenarios without
// widening the package's production authority surface.
export { AnchorWorksceneRegistry } from "../workscene/authority-registry.js";
export { IncrementalWorksceneActivityProjection } from "../workscene/activity-projection.js";

import { WORKSPACE_BINDING_ROOT_DURABLE_CONTRACT } from "../environment/workspace-binding-catalog.js";
import { WORKSPACE_BINDING_DURABLE_CONTRACT } from "../environment/workspace-bindings.js";
import { WORKSPACE_PROBE_DURABLE_CONTRACT } from "../environment/workspace-probe.js";
import { WORKSCENE_ACTIVITY_DURABLE_CONTRACT } from "../workscene/activity-projection.js";
import { WORKSCENE_REGISTRY_DURABLE_CONTRACT } from "../workscene/global-state-adapter.js";
import {
  executeWorksceneActivityProjectionCase,
  executeWorksceneRegistryCase,
  executeWorkspaceBindingCase,
  executeWorkspaceBindingRootCase,
  executeWorkspaceProbeCase,
} from "./s7-durable-scenarios.js";
import {
  defineS7DurableScenarios,
  type S7ExecutableScenarioObservation,
} from "./s7-durable-harness.js";

export function createCoreS7DurableScenarios(): ReadonlyMap<
  string,
  () => Promise<S7ExecutableScenarioObservation>
> {
  return mergeScenarioMaps(
    defineS7DurableScenarios(WORKSCENE_REGISTRY_DURABLE_CONTRACT, {
      "variant:established": () => executeWorksceneRegistryCase("variant", "established"),
      "variant:control-applied": () => executeWorksceneRegistryCase("variant", "control-applied"),
      "variant:deletion-projected": () => executeWorksceneRegistryCase("variant", "deletion-projected"),
      "rejection:principal-method": () => executeWorksceneRegistryCase("rejection", "principal-method"),
      "rejection:request-conflict": () => executeWorksceneRegistryCase("rejection", "request-conflict"),
      "rejection:revision-conflict": () => executeWorksceneRegistryCase("rejection", "revision-conflict"),
      "rejection:deletion-pending": () => executeWorksceneRegistryCase("rejection", "deletion-pending"),
      "corruption:unknown-record": () => executeWorksceneRegistryCase("corruption", "unknown-record"),
      "corruption:non-contiguous-revision": () => executeWorksceneRegistryCase("corruption", "non-contiguous-revision"),
      "corruption:broken-deletion-confirmation": () => executeWorksceneRegistryCase("corruption", "broken-deletion-confirmation"),
    }),
    defineS7DurableScenarios(WORKSPACE_BINDING_DURABLE_CONTRACT, {
      "variant:directory-established": () => executeWorkspaceBindingCase("variant", "directory-established"),
      "variant:catalog-reset": () => executeWorkspaceBindingCase("variant", "catalog-reset"),
      "variant:binding-created": () => executeWorkspaceBindingCase("variant", "binding-created"),
      "variant:binding-updated": () => executeWorkspaceBindingCase("variant", "binding-updated"),
      "variant:binding-removed": () => executeWorkspaceBindingCase("variant", "binding-removed"),
      "variant:request-recorded": () => executeWorkspaceBindingCase("variant", "request-recorded"),
      "variant:legacy-binding-staged": () => executeWorkspaceBindingCase("variant", "legacy-binding-staged"),
      "variant:legacy-migration-activated": () => executeWorkspaceBindingCase("variant", "legacy-migration-activated"),
      "variant:legacy-migration-abandoned": () => executeWorkspaceBindingCase("variant", "legacy-migration-abandoned"),
      "rejection:control-lease": () => executeWorkspaceBindingCase("rejection", "control-lease"),
      "rejection:name-conflict": () => executeWorkspaceBindingCase("rejection", "name-conflict"),
      "rejection:revision-conflict": () => executeWorkspaceBindingCase("rejection", "revision-conflict"),
      "rejection:tombstoned-reference": () => executeWorkspaceBindingCase("rejection", "tombstoned-reference"),
      "corruption:missing-establishment": () => executeWorkspaceBindingCase("corruption", "missing-establishment"),
      "corruption:invalid-record": () => executeWorkspaceBindingCase("corruption", "invalid-record"),
      "corruption:broken-log-tail": () => executeWorkspaceBindingCase("corruption", "broken-log-tail"),
    }),
    defineS7DurableScenarios(WORKSPACE_BINDING_ROOT_DURABLE_CONTRACT, {
      "variant:healthy": () => executeWorkspaceBindingRootCase("variant", "healthy"),
      "variant:degraded": () => executeWorkspaceBindingRootCase("variant", "degraded"),
      "variant:pending-reset": () => executeWorkspaceBindingRootCase("variant", "pending-reset"),
      "rejection:healthy-reset": () => executeWorkspaceBindingRootCase("rejection", "healthy-reset"),
      "rejection:confirmation-mismatch": () => executeWorkspaceBindingRootCase("rejection", "confirmation-mismatch"),
      "rejection:generation-conflict": () => executeWorkspaceBindingRootCase("rejection", "generation-conflict"),
      "rejection:reservation-conflict": () => executeWorkspaceBindingRootCase("rejection", "reservation-conflict"),
      "corruption:malformed-manifest": () => executeWorkspaceBindingRootCase("corruption", "malformed-manifest"),
      "corruption:missing-active-log": () => executeWorkspaceBindingRootCase("corruption", "missing-active-log"),
      "corruption:invalid-reset-genesis": () => executeWorkspaceBindingRootCase("corruption", "invalid-reset-genesis"),
      "corruption:broken-generation-link": () => executeWorkspaceBindingRootCase("corruption", "broken-generation-link"),
    }),
    defineS7DurableScenarios(WORKSPACE_PROBE_DURABLE_CONTRACT, {
      "variant:log-established": () => executeWorkspaceProbeCase("variant", "log-established"),
      "variant:started": () => executeWorkspaceProbeCase("variant", "started"),
      "variant:completed": () => executeWorkspaceProbeCase("variant", "completed"),
      "variant:retired": () => executeWorkspaceProbeCase("variant", "retired"),
      "rejection:grant-binding": () => executeWorkspaceProbeCase("rejection", "grant-binding"),
      "rejection:lease-binding": () => executeWorkspaceProbeCase("rejection", "lease-binding"),
      "rejection:expired-fresh-request": () => executeWorkspaceProbeCase("rejection", "expired-fresh-request"),
      "rejection:request-conflict": () => executeWorkspaceProbeCase("rejection", "request-conflict"),
      "corruption:invalid-result": () => executeWorkspaceProbeCase("corruption", "invalid-result"),
      "corruption:request-result-mismatch": () => executeWorkspaceProbeCase("corruption", "request-result-mismatch"),
      "corruption:broken-replay-index": () => executeWorkspaceProbeCase("corruption", "broken-replay-index"),
    }),
    defineS7DurableScenarios(WORKSCENE_ACTIVITY_DURABLE_CONTRACT, {
      "variant:put": () => executeWorksceneActivityProjectionCase("variant", "put"),
      "variant:tombstone": () => executeWorksceneActivityProjectionCase("variant", "tombstone"),
      "variant:stale-contribution": () => executeWorksceneActivityProjectionCase("variant", "stale-contribution"),
      "variant:checkpoint-mismatch": () => executeWorksceneActivityProjectionCase("variant", "checkpoint-mismatch"),
      "rejection:wrong-scene": () => executeWorksceneActivityProjectionCase("rejection", "wrong-scene"),
      "rejection:wrong-conversation": () => executeWorksceneActivityProjectionCase("rejection", "wrong-conversation"),
      "corruption:invalid-contribution": () => executeWorksceneActivityProjectionCase("corruption", "invalid-contribution"),
      "corruption:invalid-aggregate": () => executeWorksceneActivityProjectionCase("corruption", "invalid-aggregate"),
    }),
  );
}

function mergeScenarioMaps(
  ...sources: readonly ReadonlyMap<string, () => Promise<S7ExecutableScenarioObservation>>[]
): ReadonlyMap<string, () => Promise<S7ExecutableScenarioObservation>> {
  const scenarios = new Map<string, () => Promise<S7ExecutableScenarioObservation>>();
  for (const source of sources) {
    for (const [key, execute] of source) {
      if (scenarios.has(key)) throw new TypeError(`Duplicate S7 scenario: ${key}`);
      scenarios.set(key, execute);
    }
  }
  return scenarios;
}
