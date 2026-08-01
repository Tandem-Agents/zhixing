import { SESSION_ACTIVITY_DURABLE_CONTRACT } from "../conversation-assignment.js";
import { defineS7DurableScenarios, type S7ExecutableScenarioObservation } from "@zhixing/core/test-support/s7-durable-harness";
import { executeSessionActivityCase } from "./s7-durable-scenarios.js";

export function createOwnerKernelS7DurableScenarios(): ReadonlyMap<
  string,
  () => Promise<S7ExecutableScenarioObservation>
> {
  return defineS7DurableScenarios(SESSION_ACTIVITY_DURABLE_CONTRACT, {
    "variant:upsert": () => executeSessionActivityCase("variant", "upsert"),
    "variant:delete": () => executeSessionActivityCase("variant", "delete"),
    "rejection:conversation-scene-mismatch": () => executeSessionActivityCase("rejection", "conversation-scene-mismatch"),
    "rejection:external-construction": () => executeSessionActivityCase("rejection", "external-construction"),
    "rejection:non-monotonic-revision": () => executeSessionActivityCase("rejection", "non-monotonic-revision"),
    "corruption:wrong-stream": () => executeSessionActivityCase("corruption", "wrong-stream"),
    "corruption:invalid-time": () => executeSessionActivityCase("corruption", "invalid-time"),
    "corruption:identity-rebinding": () => executeSessionActivityCase("corruption", "identity-rebinding"),
  });
}
