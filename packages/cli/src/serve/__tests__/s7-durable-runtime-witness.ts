import { LOCAL_WORKSPACE_OPERATION_OUTBOX_DURABLE_CONTRACT } from "../../runtime/local-workspace-operation-outbox.js";
import { LEGACY_WORKSCENE_MIGRATION_DURABLE_CONTRACT } from "../workscene-legacy-migration.js";
import { defineS7DurableScenarios, type S7ExecutableScenarioObservation } from "@zhixing/core/test-support/s7-durable-harness";
import {
  executeLegacyWorksceneMigrationCase,
  executeLocalWorkspaceOutboxCase,
} from "./s7-durable-cli-scenarios.js";

export function createCliS7DurableScenarios(): ReadonlyMap<
  string,
  () => Promise<S7ExecutableScenarioObservation>
> {
  return mergeScenarioMaps(
    defineS7DurableScenarios(LEGACY_WORKSCENE_MIGRATION_DURABLE_CONTRACT, {
      "variant:open": () => executeLegacyWorksceneMigrationCase("variant", "open"),
      "variant:activated": () => executeLegacyWorksceneMigrationCase("variant", "activated"),
      "variant:abandoned": () => executeLegacyWorksceneMigrationCase("variant", "abandoned"),
      "variant:terminal-revival": () => executeLegacyWorksceneMigrationCase("variant", "terminal-revival"),
      "rejection:source-changed": () => executeLegacyWorksceneMigrationCase("rejection", "source-changed"),
      "rejection:import-set-mismatch": () => executeLegacyWorksceneMigrationCase("rejection", "import-set-mismatch"),
      "rejection:post-cutover-write": () => executeLegacyWorksceneMigrationCase("rejection", "post-cutover-write"),
      "corruption:malformed-report": () => executeLegacyWorksceneMigrationCase("corruption", "malformed-report"),
      "corruption:broken-terminal": () => executeLegacyWorksceneMigrationCase("corruption", "broken-terminal"),
      "corruption:source-pages-mismatch": () => executeLegacyWorksceneMigrationCase("corruption", "source-pages-mismatch"),
      "corruption:cutover-marker-mismatch": () => executeLegacyWorksceneMigrationCase("corruption", "cutover-marker-mismatch"),
    }),
    defineS7DurableScenarios(LOCAL_WORKSPACE_OPERATION_OUTBOX_DURABLE_CONTRACT, {
      "variant:prepared": () => executeLocalWorkspaceOutboxCase("variant", "prepared"),
      "variant:committed": () => executeLocalWorkspaceOutboxCase("variant", "committed"),
      "variant:completed": () => executeLocalWorkspaceOutboxCase("variant", "completed"),
      "variant:abandoned": () => executeLocalWorkspaceOutboxCase("variant", "abandoned"),
      "rejection:identity-mismatch": () => executeLocalWorkspaceOutboxCase("rejection", "identity-mismatch"),
      "rejection:confirmation-hole": () => executeLocalWorkspaceOutboxCase("rejection", "confirmation-hole"),
      "corruption:checkpoint-chain": () => executeLocalWorkspaceOutboxCase("corruption", "checkpoint-chain"),
      "corruption:establishment-marker": () => executeLocalWorkspaceOutboxCase("corruption", "establishment-marker"),
    }),
  );
}

function mergeScenarioMaps(
  ...sources: readonly ReadonlyMap<string, () => Promise<S7ExecutableScenarioObservation>>[]
): ReadonlyMap<string, () => Promise<S7ExecutableScenarioObservation>> {
  return new Map(sources.flatMap((source) => [...source]));
}
