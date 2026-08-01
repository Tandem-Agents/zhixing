import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AnchorWorksceneGlobalStateAdapter,
  AnchorWorksceneRegistry,
  EnvironmentProbeOwner,
  IncrementalWorksceneActivityProjection,
  WorksceneConflictError,
  WorksceneRevisionError,
  WorkspaceBindingConflictError,
  WorkspaceBindingCatalog,
  WorkspaceBindingCatalogConflictError,
  WorkspaceBindingNotFoundError,
  WorkspaceBindingRevisionError,
  WorkspaceBindingService,
  WorkspaceProbeHandler,
  getWorkSceneDir,
  getWorkSceneIndexPath,
  localEnvironmentControlSubject,
  markLegacyWorksceneCutover,
  workspaceCatalogGenerationStorageKey,
  worksceneImportSetDigest,
} from "@zhixing/core";
import {
  AuthorityStorageError,
  FileArtifactStore,
  FileAuthorityCommitLog,
  type AuthorityCommitLog,
  type DurableProjectionIndex,
} from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import type {
  CapabilityDescriptor,
  ExecutorVersionInventory,
  ImmediateRootResourceLease,
  LocalWorkspaceBinding,
  ResourceLease,
  WorkspaceBindingMigrationPort,
} from "@zhixing/core/contracts";
import {
  createSignedEnvironmentControlGrant,
  createSignedWorkspaceProbeResult,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  workspaceProbeRequestDigest,
} from "@zhixing/core/protocol";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  StorageMaintenanceTaskRunner,
} from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import {
  ConversationRunJournal,
  OwnerDeliveryParticipant,
} from "@zhixing/owner-kernel";
import {
  LocalWorkspaceOperationOutbox,
  type LocalWorkspaceWriteOperation,
} from "../../runtime/local-workspace-operation-outbox.js";
import { LocalWorkspaceManagementHost } from "../../runtime/local-workspace-management-host.js";
import { acquireLocalWorkspaceOwner } from "../../runtime/local-workspace-owner.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "../../runtime/workspace-reset-impact.js";
import {
  migrateLegacyWorkscenes,
} from "../workscene-legacy-migration.js";

export type S7ExecutableScenario = () => Promise<{
  readonly family: string;
  readonly kind: "variant" | "rejection" | "corruption";
  readonly caseKey: string;
  readonly reasonCode: string;
  readonly producer: string;
  readonly recoveryOwner: string;
  readonly resourceIdentity: string;
  readonly evidence: string;
}>;

type ScenarioMap = ReadonlyMap<string, S7ExecutableScenario>;

type DurableCaseKind = "variant" | "rejection" | "corruption";

interface ScenarioFamily {
  readonly family: string;
}

interface ExecutableScenarioCase {
  readonly kind: DurableCaseKind;
  readonly caseKey: string;
  readonly reasonCode: string;
}

interface ScenarioEvidence {
  readonly details: string[];
  readonly outcomes: Array<{
    readonly kind: DurableCaseKind;
    readonly caseKey: string;
  }>;
  readonly producers: Set<string>;
  readonly recoveryOwnerCandidates: Set<string>;
  readonly recoveryOwners: Set<string>;
  readonly resourceIdentities: Set<string>;
}

const evidenceContext = new AsyncLocalStorage<ScenarioEvidence>();

const WORKSCENE_REGISTRY_RUNTIME = { family: "workscene-registry" } as const;
const WORKSPACE_BINDING_RUNTIME = { family: "workspace-binding" } as const;
const WORKSPACE_BINDING_ROOT_RUNTIME = { family: "workspace-binding-root" } as const;
const WORKSPACE_PROBE_RUNTIME = { family: "workspace-probe" } as const;
const SESSION_ACTIVITY_RUNTIME = { family: "session-activity" } as const;
const LEGACY_WORKSCENE_MIGRATION_RUNTIME = { family: "legacy-workscene-migration" } as const;
const WORKSCENE_ACTIVITY_RUNTIME = { family: "workscene-activity-projection" } as const;
const LOCAL_WORKSPACE_OUTBOX_RUNTIME = { family: "local-workspace-operation-outbox" } as const;

const WORKSCENE_REGISTRY_CASES = [
  { kind: "variant", caseKey: "established", reasonCode: "WORKSCENE_ESTABLISHED" },
  { kind: "variant", caseKey: "control-applied", reasonCode: "WORKSCENE_CONTROL_APPLIED" },
  { kind: "variant", caseKey: "legacy-import-open", reasonCode: "WORKSCENE_LEGACY_IMPORT_OPEN" },
  { kind: "variant", caseKey: "legacy-import-activated", reasonCode: "WORKSCENE_LEGACY_IMPORT_ACTIVATED" },
  { kind: "variant", caseKey: "legacy-import-abandoned", reasonCode: "WORKSCENE_LEGACY_IMPORT_ABANDONED" },
  { kind: "variant", caseKey: "deletion-projected", reasonCode: "WORKSCENE_DELETION_PROJECTED" },
  { kind: "rejection", caseKey: "principal-method", reasonCode: "WORKSCENE_PRINCIPAL_METHOD" },
  { kind: "rejection", caseKey: "request-conflict", reasonCode: "WORKSCENE_REQUEST_CONFLICT" },
  { kind: "rejection", caseKey: "revision-conflict", reasonCode: "WORKSCENE_REVISION_CONFLICT" },
  { kind: "rejection", caseKey: "deletion-pending", reasonCode: "WORKSCENE_DELETION_PENDING" },
  { kind: "corruption", caseKey: "unknown-record", reasonCode: "WORKSCENE_UNKNOWN_RECORD" },
  { kind: "corruption", caseKey: "non-contiguous-revision", reasonCode: "WORKSCENE_NON_CONTIGUOUS_REVISION" },
  { kind: "corruption", caseKey: "broken-deletion-confirmation", reasonCode: "WORKSCENE_BROKEN_DELETION_CONFIRMATION" },
] as const satisfies readonly ExecutableScenarioCase[];

const WORKSPACE_BINDING_CASES = [
  { kind: "variant", caseKey: "directory-established", reasonCode: "WORKSPACE_BINDING_DIRECTORY_ESTABLISHED" },
  { kind: "variant", caseKey: "catalog-reset", reasonCode: "WORKSPACE_BINDING_CATALOG_RESET" },
  { kind: "variant", caseKey: "binding-created", reasonCode: "WORKSPACE_BINDING_BINDING_CREATED" },
  { kind: "variant", caseKey: "binding-updated", reasonCode: "WORKSPACE_BINDING_BINDING_UPDATED" },
  { kind: "variant", caseKey: "binding-removed", reasonCode: "WORKSPACE_BINDING_BINDING_REMOVED" },
  { kind: "variant", caseKey: "request-recorded", reasonCode: "WORKSPACE_BINDING_REQUEST_RECORDED" },
  { kind: "variant", caseKey: "legacy-binding-staged", reasonCode: "WORKSPACE_BINDING_LEGACY_BINDING_STAGED" },
  { kind: "variant", caseKey: "legacy-migration-activated", reasonCode: "WORKSPACE_BINDING_LEGACY_MIGRATION_ACTIVATED" },
  { kind: "variant", caseKey: "legacy-migration-abandoned", reasonCode: "WORKSPACE_BINDING_LEGACY_MIGRATION_ABANDONED" },
  { kind: "rejection", caseKey: "control-lease", reasonCode: "WORKSPACE_BINDING_CONTROL_LEASE" },
  { kind: "rejection", caseKey: "name-conflict", reasonCode: "WORKSPACE_BINDING_NAME_CONFLICT" },
  { kind: "rejection", caseKey: "revision-conflict", reasonCode: "WORKSPACE_BINDING_REVISION_CONFLICT" },
  { kind: "rejection", caseKey: "tombstoned-reference", reasonCode: "WORKSPACE_BINDING_TOMBSTONED_REFERENCE" },
  { kind: "corruption", caseKey: "missing-establishment", reasonCode: "WORKSPACE_BINDING_MISSING_ESTABLISHMENT" },
  { kind: "corruption", caseKey: "invalid-record", reasonCode: "WORKSPACE_BINDING_INVALID_RECORD" },
  { kind: "corruption", caseKey: "broken-log-tail", reasonCode: "WORKSPACE_BINDING_BROKEN_LOG_TAIL" },
] as const satisfies readonly ExecutableScenarioCase[];

const WORKSPACE_BINDING_ROOT_CASES = [
  { kind: "variant", caseKey: "healthy", reasonCode: "WORKSPACE_ROOT_HEALTHY" },
  { kind: "variant", caseKey: "degraded", reasonCode: "WORKSPACE_ROOT_DEGRADED" },
  { kind: "variant", caseKey: "pending-reset", reasonCode: "WORKSPACE_ROOT_PENDING_RESET" },
  { kind: "rejection", caseKey: "healthy-reset", reasonCode: "WORKSPACE_ROOT_HEALTHY_RESET" },
  { kind: "rejection", caseKey: "confirmation-mismatch", reasonCode: "WORKSPACE_ROOT_CONFIRMATION_MISMATCH" },
  { kind: "rejection", caseKey: "generation-conflict", reasonCode: "WORKSPACE_ROOT_GENERATION_CONFLICT" },
  { kind: "rejection", caseKey: "reservation-conflict", reasonCode: "WORKSPACE_ROOT_RESERVATION_CONFLICT" },
  { kind: "corruption", caseKey: "malformed-manifest", reasonCode: "WORKSPACE_ROOT_MALFORMED_MANIFEST" },
  { kind: "corruption", caseKey: "missing-active-log", reasonCode: "WORKSPACE_ROOT_MISSING_ACTIVE_LOG" },
  { kind: "corruption", caseKey: "invalid-reset-genesis", reasonCode: "WORKSPACE_ROOT_INVALID_RESET_GENESIS" },
  { kind: "corruption", caseKey: "broken-generation-link", reasonCode: "WORKSPACE_ROOT_BROKEN_GENERATION_LINK" },
] as const satisfies readonly ExecutableScenarioCase[];

const WORKSPACE_PROBE_CASES = [
  { kind: "variant", caseKey: "log-established", reasonCode: "WORKSPACE_PROBE_LOG_ESTABLISHED" },
  { kind: "variant", caseKey: "started", reasonCode: "WORKSPACE_PROBE_STARTED" },
  { kind: "variant", caseKey: "completed", reasonCode: "WORKSPACE_PROBE_COMPLETED" },
  { kind: "variant", caseKey: "retired", reasonCode: "WORKSPACE_PROBE_RETIRED" },
  { kind: "rejection", caseKey: "grant-binding", reasonCode: "WORKSPACE_PROBE_GRANT_BINDING" },
  { kind: "rejection", caseKey: "lease-binding", reasonCode: "WORKSPACE_PROBE_LEASE_BINDING" },
  { kind: "rejection", caseKey: "request-conflict", reasonCode: "WORKSPACE_PROBE_REQUEST_CONFLICT" },
  { kind: "rejection", caseKey: "expired-fresh-request", reasonCode: "WORKSPACE_PROBE_EXPIRED_FRESH_REQUEST" },
  { kind: "corruption", caseKey: "invalid-result", reasonCode: "WORKSPACE_PROBE_INVALID_RESULT" },
  { kind: "corruption", caseKey: "request-result-mismatch", reasonCode: "WORKSPACE_PROBE_REQUEST_RESULT_MISMATCH" },
  { kind: "corruption", caseKey: "broken-replay-index", reasonCode: "WORKSPACE_PROBE_BROKEN_REPLAY_INDEX" },
] as const satisfies readonly ExecutableScenarioCase[];

const SESSION_ACTIVITY_CASES = [
  { kind: "variant", caseKey: "upsert", reasonCode: "SESSION_ACTIVITY_UPSERT" },
  { kind: "variant", caseKey: "delete", reasonCode: "SESSION_ACTIVITY_DELETE" },
  { kind: "rejection", caseKey: "conversation-scene-mismatch", reasonCode: "SESSION_ACTIVITY_CONVERSATION_SCENE_MISMATCH" },
  { kind: "rejection", caseKey: "non-monotonic-revision", reasonCode: "SESSION_ACTIVITY_NON_MONOTONIC_REVISION" },
  { kind: "rejection", caseKey: "external-construction", reasonCode: "SESSION_ACTIVITY_EXTERNAL_CONSTRUCTION" },
  { kind: "corruption", caseKey: "wrong-stream", reasonCode: "SESSION_ACTIVITY_WRONG_STREAM" },
  { kind: "corruption", caseKey: "invalid-time", reasonCode: "SESSION_ACTIVITY_INVALID_TIME" },
  { kind: "corruption", caseKey: "identity-rebinding", reasonCode: "SESSION_ACTIVITY_IDENTITY_REBINDING" },
] as const satisfies readonly ExecutableScenarioCase[];

const LEGACY_WORKSCENE_MIGRATION_CASES = [
  { kind: "variant", caseKey: "open", reasonCode: "WORKSCENE_MIGRATION_OPEN" },
  { kind: "variant", caseKey: "activated", reasonCode: "WORKSCENE_MIGRATION_ACTIVATED" },
  { kind: "variant", caseKey: "abandoned", reasonCode: "WORKSCENE_MIGRATION_ABANDONED" },
  { kind: "rejection", caseKey: "source-changed", reasonCode: "WORKSCENE_MIGRATION_SOURCE_CHANGED" },
  { kind: "rejection", caseKey: "terminal-revival", reasonCode: "WORKSCENE_MIGRATION_TERMINAL_REVIVAL" },
  { kind: "rejection", caseKey: "import-set-mismatch", reasonCode: "WORKSCENE_MIGRATION_IMPORT_SET_MISMATCH" },
  { kind: "rejection", caseKey: "post-cutover-write", reasonCode: "WORKSCENE_MIGRATION_POST_CUTOVER_WRITE" },
  { kind: "corruption", caseKey: "malformed-report", reasonCode: "WORKSCENE_MIGRATION_MALFORMED_REPORT" },
  { kind: "corruption", caseKey: "broken-terminal", reasonCode: "WORKSCENE_MIGRATION_BROKEN_TERMINAL" },
  { kind: "corruption", caseKey: "source-pages-mismatch", reasonCode: "WORKSCENE_MIGRATION_SOURCE_PAGES_MISMATCH" },
  { kind: "corruption", caseKey: "cutover-marker-mismatch", reasonCode: "WORKSCENE_MIGRATION_CUTOVER_MARKER_MISMATCH" },
] as const satisfies readonly ExecutableScenarioCase[];

const WORKSCENE_ACTIVITY_CASES = [
  { kind: "variant", caseKey: "put", reasonCode: "WORKSCENE_ACTIVITY_PUT" },
  { kind: "variant", caseKey: "tombstone", reasonCode: "WORKSCENE_ACTIVITY_TOMBSTONE" },
  { kind: "rejection", caseKey: "stale-contribution", reasonCode: "WORKSCENE_ACTIVITY_STALE_CONTRIBUTION" },
  { kind: "rejection", caseKey: "wrong-scene", reasonCode: "WORKSCENE_ACTIVITY_WRONG_SCENE" },
  { kind: "rejection", caseKey: "wrong-conversation", reasonCode: "WORKSCENE_ACTIVITY_WRONG_CONVERSATION" },
  { kind: "corruption", caseKey: "invalid-contribution", reasonCode: "WORKSCENE_ACTIVITY_INVALID_CONTRIBUTION" },
  { kind: "corruption", caseKey: "invalid-aggregate", reasonCode: "WORKSCENE_ACTIVITY_INVALID_AGGREGATE" },
  { kind: "corruption", caseKey: "checkpoint-mismatch", reasonCode: "WORKSCENE_ACTIVITY_CHECKPOINT_MISMATCH" },
] as const satisfies readonly ExecutableScenarioCase[];

const LOCAL_WORKSPACE_OUTBOX_CASES = [
  { kind: "variant", caseKey: "prepared", reasonCode: "LOCAL_WORKSPACE_OPERATION_PREPARED" },
  { kind: "variant", caseKey: "committed", reasonCode: "LOCAL_WORKSPACE_OPERATION_COMMITTED" },
  { kind: "variant", caseKey: "completed", reasonCode: "LOCAL_WORKSPACE_OPERATION_COMPLETED" },
  { kind: "variant", caseKey: "abandoned", reasonCode: "LOCAL_WORKSPACE_OPERATION_ABANDONED" },
  { kind: "rejection", caseKey: "identity-mismatch", reasonCode: "LOCAL_WORKSPACE_OPERATION_IDENTITY_MISMATCH" },
  { kind: "rejection", caseKey: "confirmation-hole", reasonCode: "LOCAL_WORKSPACE_CONFIRMATION_HOLE" },
  { kind: "corruption", caseKey: "checkpoint-chain", reasonCode: "LOCAL_WORKSPACE_OUTBOX_CHAIN_CORRUPT" },
  { kind: "corruption", caseKey: "establishment-marker", reasonCode: "LOCAL_WORKSPACE_OUTBOX_IDENTITY_CORRUPT" },
] as const satisfies readonly ExecutableScenarioCase[];

function executableScenarios(
  runtime: ScenarioFamily,
  cases: readonly ExecutableScenarioCase[],
  execute: (kind: DurableCaseKind, caseKey: string) => Promise<void>,
): [string, S7ExecutableScenario][] {
  return cases.map((entry) => {
    const {
      kind,
      caseKey,
      reasonCode: observedReasonCode,
    } = entry;
    const key = `${runtime.family}:${kind}:${caseKey}`;
    return [
      key,
      scenario(
        runtime,
        kind,
        caseKey,
        observedReasonCode,
        () => execute(kind, caseKey),
      ),
    ];
  });
}

export function createS7DurableScenarioAdapters(): ScenarioMap {
  return new Map([
    ...worksceneRegistryScenarios(),
    ...workspaceBindingScenarios(),
    ...workspaceBindingRootScenarios(),
    ...workspaceProbeScenarios(),
    ...sessionActivityScenarios(),
    ...legacyWorksceneMigrationScenarios(),
    ...worksceneActivityProjectionScenarios(),
    ...localWorkspaceOutboxScenarios(),
  ]);
}

const NOW = "2026-08-01T00:00:00.000Z";
const EXPIRY = "2026-08-01T01:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "device-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    assert(
      JSON.stringify(signature) ===
        JSON.stringify(this.sign(schemaId, version, payload)),
      "signature did not bind the production payload",
    );
  },
};

function worksceneRegistryScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    WORKSCENE_REGISTRY_RUNTIME,
    WORKSCENE_REGISTRY_CASES,
    executeWorksceneRegistryCase,
  );
}

async function executeWorksceneRegistryCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    const fixture = await createWorksceneRegistryFixture();
    if (caseKey === "established") {
      await fixture.adapter.read(
        { kind: "workscene-list" },
        globalReadContext("workscene-list"),
      );
      assert(
        (await fixture.log.readAll()).some(
          (envelope) => envelope.entries.some(
            (entry) => (entry.body as { t?: string }).t === "workscene-registry-established",
          ),
        ),
        "production registry did not persist its establishment record",
      );
    } else if (caseKey === "control-applied") {
      await fixture.adapter.mutate(
        worksceneCreateMutation(),
        globalControlContext("workscene-create"),
      );
      assert(
        (await createRecoveredWorksceneAdapter(fixture.log).read(
          { kind: "workscene-get", sceneId: "scene-a" },
          globalReadContext("workscene-replay"),
        )).scene?.name === "Project",
        "production recovery owner did not replay the control record",
      );
    } else if (caseKey === "legacy-import-open") {
      await fixture.adapter.mutate(
        worksceneLegacyImport(),
        globalControlContext("legacy-open"),
      );
      const open = await fixture.adapter.read(
        { kind: "workscene-get", sceneId: "legacy-a" },
        globalReadContext("legacy-open-read"),
      );
      assert(open.scene === null, "open import became visible before activation");
    } else if (caseKey === "legacy-import-activated") {
      const imported = worksceneLegacyImport();
      await fixture.adapter.mutate(
        imported,
        globalControlContext("legacy-open"),
      );
      await fixture.adapter.mutate(
        {
          kind: "workscene-activate-device-registry",
          migrationId: imported.migrationId,
          sourceSnapshotToken: imported.sourceSnapshotToken,
          importSetDigest: worksceneImportSetDigest([{
            ...imported.scene,
            revision: 1,
            lastActiveAt: imported.scene.createdAt,
          }]),
        },
        globalControlContext("legacy-activate"),
      );
      assert(
        (await createRecoveredWorksceneAdapter(fixture.log).read(
          { kind: "workscene-get", sceneId: "legacy-a" },
          globalReadContext("legacy-activate-replay"),
        )).scene?.name === "Legacy",
        "production recovery owner did not replay legacy activation",
      );
    } else if (caseKey === "legacy-import-abandoned") {
      const imported = worksceneLegacyImport();
      await fixture.adapter.mutate(
        imported,
        globalControlContext("legacy-open"),
      );
      await fixture.adapter.mutate(
        {
          kind: "workscene-abandon-legacy-import",
          migrationId: imported.migrationId,
          sourceSnapshotToken: imported.sourceSnapshotToken,
          reason: "operator-abandoned",
        },
        globalControlContext("legacy-abandon"),
      );
      assert(
        (await createRecoveredWorksceneAdapter(fixture.log).read(
          { kind: "workscene-get", sceneId: "legacy-a" },
          globalReadContext("legacy-abandon-replay"),
        )).scene === null,
        "abandoned import became visible after recovery",
      );
    } else if (caseKey === "deletion-projected") {
      await fixture.adapter.mutate(
        worksceneCreateMutation(),
        globalControlContext("workscene-create"),
      );
      const deleted = await fixture.adapter.mutate(
        {
          kind: "workscene-delete",
          sceneId: "scene-a",
          expectedRevision: 1,
        },
        globalControlContext("workscene-delete"),
      );
      if (deleted.kind !== "workscene-deleted") throw new Error("delete did not produce its durable terminal");
      assert(
        (await new AnchorWorksceneRegistry({ log: fixture.log, clock: () => NOW }).pendingDeletionPage()).items.length === 0,
        "deletion projection did not replay as complete",
      );
    } else {
      throw new Error(`Unimplemented workscene registry variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    const fixture = await createWorksceneRegistryFixture();
    if (caseKey === "principal-method") {
      await expectFailure(() => fixture.adapter.mutate(worksceneCreateMutation(), {
        principal: { kind: "assignment", capability: {} as never },
        requestId: "principal-rejected",
        authority: { domain: "global", anchorEpoch: 1 },
        deadlineAt: EXPIRY,
      }), "assignment owner");
      assert((await fixture.log.readAll()).length === 0, "rejected principal wrote durable state");
    } else if (caseKey === "request-conflict") {
      await fixture.adapter.mutate(
        worksceneCreateMutation(),
        globalControlContext("same-request"),
      );
      await expectInstance(
        () => fixture.adapter.mutate(
          { kind: "workscene-create", name: "Other" },
          globalControlContext("same-request"),
        ),
        WorksceneConflictError,
      );
    } else if (caseKey === "revision-conflict") {
      await fixture.adapter.mutate(
        worksceneCreateMutation(),
        globalControlContext("workscene-create"),
      );
      await expectInstance(
        () => fixture.adapter.mutate(
          {
            kind: "workscene-rename",
            sceneId: "scene-a",
            name: "Renamed",
            expectedRevision: 2,
          },
          globalControlContext("stale-revision"),
        ),
        WorksceneRevisionError,
      );
    } else if (caseKey === "deletion-pending") {
      const pendingFixture = await createWorksceneRegistryFixture({
        removeScene: async () => {
          throw new Error("projection unavailable");
        },
      });
      await pendingFixture.adapter.mutate(
        worksceneCreateMutation(),
        globalControlContext("workscene-create"),
      );
      await expectFailure(
        () => pendingFixture.adapter.mutate(
          {
            kind: "workscene-delete",
            sceneId: "scene-a",
            expectedRevision: 1,
          },
          globalControlContext("workscene-delete"),
        ),
        "projection unavailable",
      );
      await expectInstance(
        () => pendingFixture.adapter.mutate(
          worksceneCreateMutation(),
          globalControlContext("recreate-pending"),
        ),
        WorksceneConflictError,
      );
    } else {
      throw new Error(`Unimplemented workscene registry rejection: ${caseKey}`);
    }
    return;
  }

  const fixture = await createWorksceneRegistryFixture();
  await fixture.adapter.read(
    { kind: "workscene-list" },
    globalReadContext("workscene-corruption-establish"),
  );
  if (caseKey === "unknown-record") {
    await fixture.log.append([{ stream: "intent:workscene-registry", body: { t: "unknown-record" } }]);
    await expectFailure(
      () => createRecoveredWorksceneAdapter(fixture.log).read(
        { kind: "workscene-list" },
        globalReadContext("workscene-corruption-replay"),
      ),
      "tag",
    );
  } else if (caseKey === "non-contiguous-revision") {
    const mutation = worksceneCreateMutation();
    await fixture.log.append([{
      stream: "intent:workscene-registry",
      body: {
        t: "workscene-control-applied",
        requestId: "bad-revision",
        mutationDigest: protocolDigest("WorksceneWriteMutation", 1, mutation),
        mutation,
        result: {
          kind: "workscene-applied",
          operation: "create",
          revision: 2,
          scene: {
            id: "scene-a",
            revision: 1,
            name: "Project",
            createdAt: NOW,
            lastActiveAt: NOW,
          },
        },
        at: NOW,
      },
    }]);
    await expectFailure(
      () => createRecoveredWorksceneAdapter(fixture.log).read(
        { kind: "workscene-list" },
        globalReadContext("workscene-revision-replay"),
      ),
      "revision",
    );
  } else if (caseKey === "broken-deletion-confirmation") {
    await fixture.log.append([{
      stream: "intent:workscene-registry",
      body: {
        t: "workscene-deletion-projected",
        sceneId: "scene-a",
        deletionRevision: 1,
        at: NOW,
      },
    }]);
    await expectFailure(
      () => createRecoveredWorksceneAdapter(fixture.log).recoverPendingDeletions(),
      "pending deletion",
    );
  } else {
    throw new Error(`Unimplemented workscene registry corruption: ${caseKey}`);
  }
}

async function createWorksceneRegistryFixture(options: {
  readonly removeScene?: () => Promise<void>;
} = {}) {
  const root = await createTempDir("s7-workscene-registry");
  const log = new FileAuthorityCommitLog(
    path.join(root, "authority"),
    new FileArtifactStore(path.join(root, "artifacts")),
    { clock: () => NOW },
  );
  const adapter = new AnchorWorksceneGlobalStateAdapter({
    log,
    anchorEpoch: 1,
    removeScene: options.removeScene ?? (async () => {}),
    clock: () => NOW,
    sceneIdFactory: () => "scene-a",
  });
  observeProducer(adapter);
  observeRecoveryOwner(adapter);
  observeResource("workscene:scene-a");
  return { log, adapter };
}

function createRecoveredWorksceneAdapter(log: AuthorityCommitLog) {
  return new AnchorWorksceneGlobalStateAdapter({
    log,
    anchorEpoch: 1,
    removeScene: async () => {},
    clock: () => NOW,
  });
}

function worksceneCreateMutation() {
  return { kind: "workscene-create" as const, name: "Project" };
}

function worksceneLegacyImport() {
  return {
    kind: "workscene-import-legacy" as const,
    migrationId: "migration-a",
    sourceSnapshotToken: "snapshot-a",
    scene: { id: "legacy-a", name: "Legacy", createdAt: NOW },
  };
}

function workspaceBindingRootScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    WORKSPACE_BINDING_ROOT_RUNTIME,
    WORKSPACE_BINDING_ROOT_CASES,
    executeWorkspaceBindingRootCase,
  );
}

async function executeWorkspaceBindingRootCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    if (caseKey === "healthy") {
      const fixture = await createWorkspaceCatalogFixture();
      await fixture.catalog.initialize();
      assert((await fixture.catalog.status()).state === "healthy", "healthy catalog did not open");
    } else if (caseKey === "degraded") {
      const fixture = await createWorkspaceCatalogFixture(corruptWorkspaceCatalogLog());
      await fixture.catalog.initialize();
      assert((await fixture.catalog.status()).state === "degraded", "corrupt catalog did not degrade");
      assert(fixture.published.at(-1)?.length === 0, "degraded catalog did not withdraw workspace capability");
    } else if (caseKey === "pending-reset") {
      const fixture = await createWorkspaceCatalogFixture(corruptWorkspaceCatalogLog());
      await fixture.catalog.initialize();
      const reservation = await fixture.catalog.beginReset(
        { expectedCatalogGeneration: "catalog-initial" },
        workspaceRecoveryControl("pending-reset", "catalog-initial"),
      );
      assert(
        reservation.previousCatalogGeneration === "catalog-initial" &&
          reservation.catalogGeneration !== "catalog-initial",
        "reset did not persist a successor generation reservation",
      );
    } else {
      throw new Error(`Unimplemented workspace root variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "healthy-reset") {
      const fixture = await createWorkspaceCatalogFixture();
      await fixture.catalog.initialize();
      await expectInstance(
        () => fixture.catalog.beginReset(
          { expectedCatalogGeneration: "catalog-initial" },
          workspaceRecoveryControl("healthy-reset", "catalog-initial"),
        ),
        WorkspaceBindingCatalogConflictError,
      );
    } else if (caseKey === "confirmation-mismatch") {
      const fixture = await createWorkspaceCatalogFixture(corruptWorkspaceCatalogLog());
      await fixture.catalog.initialize();
      const control = workspaceRecoveryControl("confirmation-mismatch", "catalog-initial");
      await expectFailure(
        () => fixture.catalog.beginReset(
          { expectedCatalogGeneration: "catalog-initial" },
          {
            ...control,
            confirmation: {
              ...control.confirmation,
              requestId: localEnvironmentControlSubject("device-a", "another-request"),
            },
          },
        ),
        "confirmation",
      );
    } else if (caseKey === "generation-conflict") {
      const fixture = await createWorkspaceCatalogFixture(corruptWorkspaceCatalogLog());
      await fixture.catalog.initialize();
      await expectInstance(
        () => fixture.catalog.beginReset(
          { expectedCatalogGeneration: "catalog-other" },
          workspaceRecoveryControl("generation-conflict", "catalog-initial"),
        ),
        WorkspaceBindingCatalogConflictError,
      );
    } else if (caseKey === "reservation-conflict") {
      const fixture = await createWorkspaceCatalogFixture(corruptWorkspaceCatalogLog());
      await fixture.catalog.initialize();
      await fixture.catalog.beginReset(
        { expectedCatalogGeneration: "catalog-initial" },
        workspaceRecoveryControl("reservation-first", "catalog-initial"),
      );
      await expectInstance(
        () => fixture.catalog.beginReset(
          { expectedCatalogGeneration: "catalog-initial" },
          workspaceRecoveryControl("reservation-second", "catalog-initial"),
        ),
        WorkspaceBindingCatalogConflictError,
      );
    } else {
      throw new Error(`Unimplemented workspace root rejection: ${caseKey}`);
    }
    return;
  }

  const root = await createTempDir(`s7-workspace-root-${caseKey}`);
  const catalogRoot = path.join(root, "catalog");
  await mkdir(catalogRoot, { recursive: true });
  if (caseKey === "malformed-manifest") {
    await writeFile(path.join(catalogRoot, "root-manifest.json"), "{bad-json", "utf8");
    const fixture = await createWorkspaceCatalogFixture(undefined, root);
    await expectFailure(() => fixture.catalog.initialize(), "JSON");
  } else if (caseKey === "missing-active-log") {
    await writeWorkspaceRootManifest(catalogRoot, {
      version: 1,
      state: "healthy",
      catalogGeneration: "catalog-initial",
      logId: "missing-log-id",
      capabilityRevision: 1,
    });
    const fixture = await createWorkspaceCatalogFixture(undefined, root);
    await fixture.catalog.initialize();
    assert((await fixture.catalog.status()).state === "degraded", "missing active log did not degrade");
  } else if (caseKey === "invalid-reset-genesis") {
    const confirmationDigest = protocolDigest("WorkspaceBindingResetConfirmation", 1, {
      token: "confirmed-reset-token-0001-with-high-entropy",
      requestId: localEnvironmentControlSubject("device-a", "invalid-genesis"),
      catalogGeneration: "catalog-initial",
      issuedAt: NOW,
    });
    const generation = protocolDigest("WorkspaceBindingCatalogGeneration", 1, {
      previousCatalogGeneration: "catalog-initial",
      confirmationDigest,
    });
    await writeWorkspaceRootManifest(catalogRoot, {
      version: 1,
      state: "degraded",
      degradedReason: "commit-log-corrupt",
      catalogGeneration: "catalog-initial",
      logId: "unavailable",
      capabilityRevision: 1,
      pendingReset: {
        requestId: localEnvironmentControlSubject("device-a", "invalid-genesis"),
        confirmationDigest,
        previousCatalogGeneration: "catalog-initial",
        catalogGeneration: generation,
        preparedAt: NOW,
      },
    });
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const targetLog = new FileAuthorityCommitLog(
      path.join(root, "logs", workspaceCatalogGenerationStorageKey(generation)),
      artifacts,
      { clock: () => NOW },
    );
    await targetLog.append([{ stream: "executor:workspace-bindings", body: { t: "unknown-reset-genesis" } }]);
    const fixture = await createWorkspaceCatalogFixture(undefined, root);
    await fixture.catalog.initialize();
    assert((await fixture.catalog.status()).state === "degraded", "invalid reset genesis escaped fail-closed recovery");
  } else if (caseKey === "broken-generation-link") {
    await writeWorkspaceRootManifest(catalogRoot, {
      version: 1,
      state: "degraded",
      degradedReason: "commit-log-corrupt",
      catalogGeneration: "catalog-initial",
      logId: "unavailable",
      capabilityRevision: 1,
      pendingReset: {
        requestId: localEnvironmentControlSubject("device-a", "broken-link"),
        confirmationDigest: protocolDigest("WorkspaceBindingResetConfirmation", 1, { requestId: "broken-link" }),
        previousCatalogGeneration: "catalog-initial",
        catalogGeneration: "catalog-not-derived-from-confirmation",
        preparedAt: NOW,
      },
    });
    const fixture = await createWorkspaceCatalogFixture(undefined, root);
    await expectFailure(() => fixture.catalog.initialize(), "reservation");
  } else {
    throw new Error(`Unimplemented workspace root corruption: ${caseKey}`);
  }
}

function corruptWorkspaceCatalogLog(): AuthorityCommitLog {
  return {
    async readSnapshot() {
      throw new AuthorityStorageError("commit-log-corrupt", "injected catalog corruption");
    },
  } as unknown as AuthorityCommitLog;
}

async function createWorkspaceCatalogFixture(
  initialLog?: AuthorityCommitLog,
  existingRoot?: string,
) {
  const root = existingRoot ?? await createTempDir("s7-workspace-catalog");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const published: CapabilityDescriptor["workspaces"][] = [];
  let capabilityRevision = 0;
  const log = initialLog ?? new FileAuthorityCommitLog(
    path.join(root, "initial-log"),
    artifacts,
    { clock: () => NOW },
  );
  const catalog = new WorkspaceBindingCatalog({
    rootDir: path.join(root, "catalog"),
    initialLog: log,
    createGenerationLog: (generation) => new FileAuthorityCommitLog(
      path.join(root, "logs", workspaceCatalogGenerationStorageKey(generation)),
      artifacts,
      { clock: () => NOW },
    ),
    service: {
      deviceId: "device-a",
      executorId: "executor-a",
      verifier: identity,
      capacity: unlimitedCapacity(),
      capabilitySnapshot: async (publication) => {
        published.push(publication.workspaces.map((entry) => ({ ...entry })));
        capabilityRevision += 1;
        return descriptor(publication.workspaces, capabilityRevision);
      },
      versionInventory: async () => inventory(),
      clock: () => NOW,
      bindingRefFactory: () => "workspace-reset-generation",
    },
    recoveryRunner: new StorageMaintenanceTaskRunner(),
    clock: () => NOW,
  });
  observeProducer(catalog);
  observeRecoveryOwner(catalog);
  observeResource(
    `workspace-catalog-reset:${protocolDigest("S7WorkspaceCatalogRoot", 1, root)}`,
  );
  return { root, catalog, published };
}

function workspaceRecoveryControl(requestId: string, catalogGeneration: string) {
  const scoped = localEnvironmentControlSubject("device-a", requestId);
  return {
    ...control(requestId),
    confirmation: {
      kind: "workspace-binding-reset" as const,
      token: "confirmed-reset-token-0001-with-high-entropy",
      requestId: scoped,
      catalogGeneration,
      issuedAt: NOW,
    },
  };
}

async function writeWorkspaceRootManifest(root: string, manifest: unknown): Promise<void> {
  await writeFile(path.join(root, "root-manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
}

function workspaceProbeScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    WORKSPACE_PROBE_RUNTIME,
    WORKSPACE_PROBE_CASES,
    executeWorkspaceProbeCase,
  );
}

async function executeWorkspaceProbeCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  const fixture = await createWorkspaceProbeFixture();
  const request = fixture.owner.issue({
    requestId: `probe-${caseKey}`,
    deviceId: "device-a",
    bindingRef: fixture.bindingRef,
    executorId: "executor-a",
    resourceLease: immediateLease(`probe-${caseKey}`),
  });

  if (kind === "variant") {
    if (caseKey === "log-established") {
      await fixture.handler.probe(request);
      assert(
        (await fixture.probeLog.readAll()).some((envelope) => envelope.entries.some(
          (entry) => (entry.body as { t?: string }).t === "probe-log-established",
        )),
        "probe owner did not establish its durable log",
      );
    } else if (caseKey === "started" || caseKey === "completed") {
      await fixture.handler.probe(request);
      const records = (await fixture.probeLog.readAll()).flatMap((envelope) => envelope.entries);
      assert(
        records.some((entry) => (entry.body as { t?: string }).t === "probe-started-v2"),
        "probe producer did not persist its started record",
      );
      if (caseKey === "completed") {
        const restarted = fixture.createHandler();
        assert(
          (await restarted.probe(request)).requestId === request.requestId,
          "probe recovery owner did not replay the completed result",
        );
      }
    } else if (caseKey === "retired") {
      await fixture.handler.probe(request);
      await fixture.handler.compact("2026-08-01T00:01:00.000Z");
      assert(
        (await fixture.probeLog.readAll()).some((envelope) => envelope.entries.some(
          (entry) => (entry.body as { t?: string }).t === "probe-retired",
        )),
        "probe retention owner did not persist retirement",
      );
    } else {
      throw new Error(`Unimplemented workspace probe variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "grant-binding") {
      const grant = createSignedEnvironmentControlGrant(
        {
          v: 1,
          grantId: request.grant.grantId,
          deviceId: request.grant.deviceId,
          bindingRef: "workspace-other",
          methods: request.grant.methods,
          requestId: request.grant.requestId,
          resourceLeaseDigest: request.grant.resourceLeaseDigest,
          issuedAt: request.grant.issuedAt,
          expiry: request.grant.expiry,
        },
        identity,
      );
      await expectFailure(
        () => fixture.handler.probe({
          ...request,
          grant,
        }),
        "grant",
      );
    } else if (caseKey === "lease-binding") {
      await expectFailure(
        () => fixture.handler.probe({
          ...request,
          resourceLease: immediateLease("another-request"),
        }),
        "lease",
      );
    } else if (caseKey === "request-conflict") {
      await fixture.handler.probe(request);
      const conflictGrant = createSignedEnvironmentControlGrant(
        {
          v: 1,
          grantId: request.grant.grantId,
          deviceId: request.grant.deviceId,
          bindingRef: request.grant.bindingRef,
          methods: request.grant.methods,
          requestId: request.grant.requestId,
          resourceLeaseDigest: request.grant.resourceLeaseDigest,
          issuedAt: request.grant.issuedAt,
          expiry: "2026-08-01T00:02:00.000Z",
        },
        identity,
      );
      await expectFailure(
        () => fixture.handler.probe({
          ...request,
          grant: conflictGrant,
        }),
        "identity",
      );
    } else if (caseKey === "expired-fresh-request") {
      const expired = await createWorkspaceProbeFixture(() => "2026-08-01T00:10:00.000Z");
      const oldRequest = expired.owner.issue({
        requestId: "probe-expired",
        deviceId: "device-a",
        bindingRef: expired.bindingRef,
        executorId: "executor-a",
        resourceLease: immediateLease("probe-expired"),
      });
      await expectFailure(
        () => expired.handler.probe({
          ...oldRequest,
          at: "2026-08-01T00:02:00.000Z",
        }),
        "active",
      );
    } else {
      throw new Error(`Unimplemented workspace probe rejection: ${caseKey}`);
    }
    return;
  }

  const corrupt = await createWorkspaceProbeFixture();
  const corruptRequest = corrupt.owner.issue({
    requestId: `probe-corrupt-${caseKey}`,
    deviceId: "device-a",
    bindingRef: corrupt.bindingRef,
    executorId: "executor-a",
    resourceLease: immediateLease(`probe-corrupt-${caseKey}`),
  });
  const key = `${corruptRequest.requestId}/${corruptRequest.grant.grantId}`;
  const requestDigest = workspaceProbeRequestDigest(corruptRequest);
  await corrupt.probeLog.append([{
    stream: "executor:workspace-probes",
    body: { t: "probe-log-established", executorId: "executor-a" },
  }]);
  await corrupt.probeLog.append([{
    stream: "executor:workspace-probes",
    body: {
      t: "probe-started-v2",
      key,
      requestDigest,
      request: corruptRequest,
      at: NOW,
    },
  }]);
  if (caseKey === "invalid-result") {
    await corrupt.probeLog.append([{
      stream: "executor:workspace-probes",
      body: {
        t: "probe-completed",
        key,
        requestDigest,
        result: {},
        at: NOW,
      },
    }]);
  } else if (caseKey === "request-result-mismatch") {
    await corrupt.probeLog.append([{
      stream: "executor:workspace-probes",
      body: {
        t: "probe-completed",
        key,
        requestDigest,
        result: createSignedWorkspaceProbeResult({
          v: 1,
          requestId: "another-request",
          bindingRef: corruptRequest.bindingRef,
          workspaceBindingRevision: 1,
          probe: "directory",
          executorId: "executor-a",
        }, identity),
        at: NOW,
      },
    }]);
  } else if (caseKey === "broken-replay-index") {
    await corrupt.probeLog.append([{
      stream: "executor:workspace-probes",
      body: {
        t: "probe-started-v2",
        key,
        requestDigest,
        request: corruptRequest,
        at: NOW,
      },
    }]);
  } else {
    throw new Error(`Unimplemented workspace probe corruption: ${caseKey}`);
  }
  await expectFailure(
    () => corrupt.createHandler().probe(corruptRequest),
    caseKey === "invalid-result" ? "result" : caseKey === "request-result-mismatch" ? "completion" : "reused",
  );
}

async function createWorkspaceProbeFixture(clock: () => string = () => NOW) {
  const root = await createTempDir("s7-workspace-probe");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const bindingLog = new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    artifacts,
    { clock: () => NOW },
  );
  const bindings = new WorkspaceBindingService({
    rootDir: path.join(root, "binding-state"),
    catalogGeneration: "catalog-initial",
    deviceId: "device-a",
    executorId: "executor-a",
    log: bindingLog,
    verifier: identity,
    capacity: unlimitedCapacity(),
    capabilitySnapshot: async (publication) => descriptor(publication.workspaces),
    versionInventory: async () => inventory(),
    clock: () => NOW,
    bindingRefFactory: () => "workspace-a",
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const binding = await bindings.create(
    { displayName: "Workspace", absolutePath: workspace },
    control("probe-binding-create"),
  );
  const probeLog = new FileAuthorityCommitLog(
    path.join(root, "probe-log"),
    artifacts,
    { clock: () => NOW },
  );
  const createHandler = () => new WorkspaceProbeHandler({
    rootDir: path.join(root, "probe-state"),
    executorId: "executor-a",
    environment: bindings,
    log: probeLog,
    signer: identity,
    verifier: identity,
    capacity: unlimitedCapacity(),
    clock,
  });
  const handler = createHandler();
  observeProducer(handler);
  observeRecoveryOwner(handler);
  observeResource("workspace-probe:probe-runtime");
  return {
    bindingRef: binding.bindingRef,
    handler,
    createHandler,
    probeLog,
    owner: new EnvironmentProbeOwner({
      signer: identity,
      verifier: identity,
      clock: () => NOW,
      grantIdFactory: () => "grant-a",
      ttlMs: 60_000,
    }),
  };
}

function workspaceBindingScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    WORKSPACE_BINDING_RUNTIME,
    WORKSPACE_BINDING_CASES,
    executeWorkspaceBindingCase,
  );
}

async function executeWorkspaceBindingCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    const service = await createWorkspaceBindingService();
    if (caseKey === "directory-established") {
      assert((await service.list(control("directory"))).length === 0, "directory did not establish");
    } else if (caseKey === "catalog-reset") {
      const confirmationDigest = protocolDigest("WorkspaceResetConfirmation", 1, { requestId: "reset-request" });
      const resetService = await createWorkspaceBindingService({
        resetGenesis: {
          previousCatalogGeneration: "catalog-previous",
          requestId: "reset-request",
          catalogGeneration: protocolDigest("WorkspaceBindingCatalogGeneration", 1, {
            previousCatalogGeneration: "catalog-previous",
            confirmationDigest,
          }),
          confirmationDigest,
          logId: "binding-log",
          capabilityRevision: 1,
          preparedAt: NOW,
        },
      });
      const receipt = await resetService.resetReceipt();
      assert(receipt?.previousCatalogGeneration === "catalog-previous", "reset genesis did not replay");
    } else if (caseKey === "binding-created") {
      assert((await createBinding(service, "created")).revision === 1, "create did not commit");
    } else if (caseKey === "binding-updated") {
      const binding = await createBinding(service, "updated");
      assert((await service.update(binding.bindingRef, { displayName: "Updated" }, 1, control("update"))).revision === 2, "update did not commit");
    } else if (caseKey === "binding-removed") {
      const binding = await createBinding(service, "removed");
      await service.remove(binding.bindingRef, 1, control("remove"));
      assert((await service.list(control("removed-list"))).length === 0, "remove did not commit");
    } else if (caseKey === "request-recorded") {
      const binding = await createBinding(service, "recorded");
      const replay = await service.update(
        binding.bindingRef,
        { displayName: binding.displayName },
        1,
        control("record-noop"),
      );
      assert(replay.revision === 1, "no-op request was not durably recorded");
    } else if (caseKey === "legacy-binding-staged") {
      const binding = await service.importLegacy(legacyInput("staged"), new AbortController().signal);
      assert(binding.revision === 1, "legacy binding was not staged");
    } else if (caseKey === "legacy-migration-activated") {
      const input = legacyInput("activated");
      await service.importLegacy(input, new AbortController().signal);
      await service.activateLegacy({
        migrationId: input.migrationId,
        sourceSnapshotToken: input.sourceSnapshotToken,
      }, new AbortController().signal);
      assert((await service.list(control("activated-list"))).length === 1, "legacy migration was not activated");
    } else if (caseKey === "legacy-migration-abandoned") {
      const input = legacyInput("abandoned");
      await service.importLegacy(input, new AbortController().signal);
      await service.abandonLegacy({
        migrationId: input.migrationId,
        sourceSnapshotToken: input.sourceSnapshotToken,
        reason: "operator-abandoned",
      }, new AbortController().signal);
      assert((await service.list(control("abandoned-list"))).length === 0, "abandoned binding became active");
    } else {
      throw new Error(`Unimplemented workspace binding variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    const service = await createWorkspaceBindingService();
    if (caseKey === "control-lease") {
      await expectFailure(() => service.list({ ...control("bad-lease"), lease: immediateLease("wrong-subject") }), "lease");
    } else if (caseKey === "name-conflict") {
      await createBinding(service, "name-conflict");
      await expectInstance(() => service.create({ displayName: "name-CONFLICT", absolutePath: path.resolve("other") }, control("duplicate-name")), WorkspaceBindingConflictError);
    } else if (caseKey === "revision-conflict") {
      const binding = await createBinding(service, "revision");
      await expectInstance(() => service.update(binding.bindingRef, { displayName: "Later" }, 2, control("bad-revision")), WorkspaceBindingRevisionError);
    } else if (caseKey === "tombstoned-reference") {
      const binding = await createBinding(service, "tombstone");
      await service.remove(binding.bindingRef, 1, control("tombstone-remove"));
      await expectInstance(() => service.update(binding.bindingRef, { displayName: "Revive" }, 1, control("revive")), WorkspaceBindingNotFoundError);
    } else {
      throw new Error(`Unimplemented workspace binding rejection: ${caseKey}`);
    }
    return;
  }

  if (caseKey === "missing-establishment") {
      const root = await createTempDir("s7-binding-missing-establishment");
      await appendWorkspaceBindingRecord(root, validWorkspaceBindingCreatedRecord());
      await expectFailure(() => createWorkspaceBindingService({ root }).then((service) => service.initialize()), "establish");
  } else if (caseKey === "invalid-record") {
      const root = await createTempDir("s7-binding-invalid-record");
      const service = await createWorkspaceBindingService({ root });
      await service.list(control("establish-before-invalid"));
      await appendWorkspaceBindingRecord(root, { t: "unknown-workspace-record" });
      await expectFailure(() => createWorkspaceBindingService({ root }).then((restarted) => restarted.initialize()), "record");
  } else if (caseKey === "broken-log-tail") {
      const root = await createTempDir("s7-binding-broken-tail");
      const service = await createWorkspaceBindingService({ root });
      await service.list(control("establish-before-tail"));
      const logPath = path.join(root, "binding-log", "authority.log");
      const bytes = await readFile(logPath);
      const frameOffset = bytes.readUInt32BE(0) === 0x5a584148 ? 72 : 0;
      const payloadEnd = frameOffset + 16 + bytes.readUInt32BE(frameOffset + 8);
      bytes[payloadEnd - 1] = bytes[payloadEnd - 1] === 0x7d ? 0x7b : 0x7d;
      await writeFile(logPath, bytes);
      await expectFailure(() => createWorkspaceBindingService({ root }).then((restarted) => restarted.initialize()), "valid JSON");
  } else {
    throw new Error(`Unimplemented workspace binding corruption: ${caseKey}`);
  }
}

async function createWorkspaceBindingService(options: {
  readonly root?: string;
  readonly resetGenesis?: {
    readonly previousCatalogGeneration: string;
    readonly requestId: string;
    readonly catalogGeneration: string;
    readonly confirmationDigest: string;
    readonly logId: string;
    readonly capabilityRevision: number;
    readonly preparedAt: string;
  };
} = {}): Promise<WorkspaceBindingService> {
  const root = options.root ?? await createTempDir("s7-workspace-binding");
  const log = new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    new FileArtifactStore(path.join(root, "artifacts")),
    { clock: () => NOW },
  );
  const capacity = unlimitedCapacity();
  const service = new WorkspaceBindingService({
    rootDir: path.join(root, "binding-state"),
    catalogGeneration: options.resetGenesis?.catalogGeneration ?? "catalog-initial",
    deviceId: "device-a",
    executorId: "executor-a",
    log,
    verifier: identity,
    capacity,
    capabilitySnapshot: async (publication) => descriptor(publication.workspaces),
    versionInventory: async () => inventory(),
    clock: () => NOW,
    bindingRefFactory: () => `workspace-${Math.random().toString(36).slice(2)}`,
    ...(options.resetGenesis ? { resetGenesis: options.resetGenesis } : {}),
  });
  observeProducer(service);
  observeRecoveryOwner(service);
  observeResource("workspace-binding:device-a");
  return service;
}

function unlimitedCapacity(): DefaultDeviceCapacityArbiter {
  return new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: Number.MAX_SAFE_INTEGER,
      processRssBytes: 0,
      temporaryBytesAvailable: Number.MAX_SAFE_INTEGER,
    }),
  });
}

async function createBinding(service: WorkspaceBindingService, name: string) {
  return service.create(
    { displayName: name, absolutePath: path.resolve(name) },
    control(`create-${name}`),
  );
}

function legacyInput(suffix: string) {
  return {
    migrationId: `migration-${suffix}`,
    sourceSnapshotToken: `snapshot-${suffix}`,
    displayName: `Legacy ${suffix}`,
    absolutePath: path.resolve(`legacy-${suffix}`),
  };
}

function descriptor(
  workspaces: CapabilityDescriptor["workspaces"],
  revision = 1,
): CapabilityDescriptor {
  return {
    v: 1,
    executorId: "executor-a",
    revision,
    protocolVersion: "1",
    workspaces,
    tools: [],
    mcpServers: [],
    credentialBindings: [],
    evidenceCapabilities: [],
    at: NOW,
    signature: identity.sign("CapabilityDescriptor", 1, {}),
  };
}

function inventory(): ExecutorVersionInventory {
  return {
    v: 1,
    executorId: "executor-a",
    inventoryRevision: 1,
    capabilityRevision: 1,
    configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
    assetVersions: { skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1 },
    permissionSnapshotHighWater: 1,
    credentialBindingRevisions: [],
    at: NOW,
    signature: identity.sign("ExecutorVersionInventory", 1, {}),
  };
}

function control(requestId: string) {
  const scoped = localEnvironmentControlSubject("device-a", requestId);
  return {
    requestId: scoped,
    lease: immediateLease(scoped),
    abort: new AbortController().signal,
  };
}

function immediateLease(requestId: string): ImmediateRootResourceLease {
  const payload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: `reservation-${requestId}`,
    admissionClass: "interactive",
    workload: { kind: "control", id: requestId, attempt: 1 },
    scopeBinding: { kind: "control", subject: requestId },
    audience: { executorId: "executor-a" },
    budget: { maxCalls: 1 },
    domain: { kind: "local", localDomainId: "device-a", localGovernorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  } as ImmediateRootResourceLease;
}

async function appendWorkspaceBindingRecord(root: string, body: unknown): Promise<void> {
  const log = new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    new FileArtifactStore(path.join(root, "artifacts")),
    { clock: () => NOW },
  );
  await log.append([{ stream: "executor:workspace-bindings", body }]);
}

function validWorkspaceBindingCreatedRecord() {
  const request = {
    kind: "create" as const,
    displayName: "Project",
    absolutePath: path.resolve("missing-establishment"),
  };
  return {
    t: "binding-created",
    requestId: localEnvironmentControlSubject("device-a", "missing-establishment"),
    requestDigest: protocolDigest("WorkspaceBindingCreate", 1, {
      displayName: request.displayName,
      absolutePath: request.absolutePath,
    }),
    request,
    binding: {
      bindingRef: "workspace-missing-establishment",
      revision: 1,
      displayName: request.displayName,
      absolutePath: request.absolutePath,
      workspaceBindingRevision: 1,
    },
  };
}

async function expectInstance(
  operation: () => Promise<unknown>,
  expected: new (...args: never[]) => Error,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof expected, `expected ${expected.name}`);
}

function legacyWorksceneMigrationScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    LEGACY_WORKSCENE_MIGRATION_RUNTIME,
    LEGACY_WORKSCENE_MIGRATION_CASES,
    executeLegacyWorksceneMigrationCase,
  );
}

async function executeLegacyWorksceneMigrationCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  await withLegacyHome(async (home) => {
    if (kind === "variant" && caseKey === "open") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      const fixture = await createLegacyMigrationFixture(home, {
        async importLegacy() { throw new Error("stop-after-open-report"); },
      });
      await expectFailure(() => runLegacyMigration(fixture), "stop-after-open-report");
      assert((await readMigrationReport(fixture.rootDir)).status === "open", "open report was not durable");
      return;
    }

    if (kind === "variant" && caseKey === "activated") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      const fixture = await createLegacyMigrationFixture(home);
      await runLegacyMigration(fixture);
      assert((await readMigrationReport(fixture.rootDir)).status === "activated", "migration did not activate");
      const restarted = await createLegacyGlobalState(home, fixture.log);
      const result = await restarted.read(
        { kind: "workscene-get", sceneId: "legacy-a" },
        globalReadContext("legacy-replay"),
      );
      assert(result.kind === "workscene-get" && result.scene?.id === "legacy-a", "migration owner did not replay activation");
      return;
    }

    if ((kind === "variant" && caseKey === "abandoned") ||
        (kind === "rejection" && caseKey === "source-changed")) {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      let changed = false;
      const fixture = await createLegacyMigrationFixture(home, {
        async importLegacy(input) {
          if (!changed) {
            changed = true;
            await writeFile(
              path.join(getWorkSceneDir("legacy-a"), "meta.json"),
              JSON.stringify({
                id: "legacy-a",
                name: "Changed",
                createdAt: NOW,
                lastActiveAt: NOW,
              }),
              "utf8",
            );
          }
          return legacyBinding(input.absolutePath);
        },
      });
      await migrateLegacyWorkscenes({
        ...fixture,
        migrationRunner: singlePassMigrationRunner(),
      });
      const report = await readMigrationReport(fixture.rootDir);
      assert(report.status === "abandoned" && report.reason === "source-changed", "source change did not produce the abandoned terminal");
      return;
    }

    if (kind === "rejection" && caseKey === "terminal-revival") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy" }]);
      const fixture = await createLegacyMigrationFixture(home);
      await runLegacyMigration(fixture);
      const before = await fixture.log.readAll();
      await runLegacyMigration(fixture);
      assert((await fixture.log.readAll()).length === before.length, "activated migration was revived");
      return;
    }

    if (kind === "rejection" && caseKey === "import-set-mismatch") {
      const fixture = await createLegacyMigrationFixture(home);
      await fixture.globalState.mutate({
        kind: "workscene-import-legacy",
        migrationId: "migration-a",
        sourceSnapshotToken: "snapshot-a",
        scene: { id: "legacy-a", name: "Legacy", createdAt: NOW },
      }, globalControlContext("legacy-import"));
      await expectFailure(() => fixture.globalState.mutate({
        kind: "workscene-activate-device-registry",
        migrationId: "migration-a",
        sourceSnapshotToken: "snapshot-a",
        importSetDigest: protocolDigest("WorksceneImportSet", 1, { forged: true }),
      }, globalControlContext("legacy-activate")), "open import set");
      return;
    }

    if (kind === "rejection" && caseKey === "post-cutover-write") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy" }]);
      const fixture = await createLegacyMigrationFixture(home);
      await runLegacyMigration(fixture);
      const { FsWorkSceneRegistry } = await import("../../../../core/src/workscene/registry.js");
      await expectFailure(() => new FsWorkSceneRegistry().add({ name: "Late" }), "read-only");
      return;
    }

    const rootDir = path.join(home, "migration");
    await mkdir(rootDir, { recursive: true });
    if (kind === "corruption" && caseKey === "malformed-report") {
      await writeFile(path.join(rootDir, "workscene-legacy-migration.json"), "{}", "utf8");
      const fixture = await createLegacyMigrationFixture(home, {}, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(fixture), "report is malformed");
      return;
    }
    if (kind === "corruption" && caseKey === "broken-terminal") {
      await writeFile(
        path.join(rootDir, "workscene-legacy-migration.json"),
        JSON.stringify({
          version: 3,
          migrationId: "migration-terminal",
          sourceSnapshotToken: "snapshot-terminal",
          sourceDigest: protocolDigest("LegacySource", 1, {}),
          status: "activated",
          phase: "cutover",
          nextPage: 0,
          pageCount: 0,
          importSetDigest: worksceneImportSetDigest([]),
        }),
        "utf8",
      );
      const fixture = await createLegacyMigrationFixture(home, {}, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(fixture), "report is malformed");
      return;
    }
    if (kind === "corruption" && caseKey === "source-pages-mismatch") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      const first = await createLegacyMigrationFixture(home, {
        async importLegacy() { throw new Error("pause-after-source-pages"); },
      }, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(first), "pause-after-source-pages");
      const report = await readMigrationReport(rootDir);
      const pageFile = path.join(rootDir, "source-pages", report.sourceSnapshotToken, "00000000.json");
      const page = JSON.parse(await readFile(pageFile, "utf8")) as Array<Record<string, unknown>>;
      page[0]!.name = "Tampered frozen page";
      await writeFile(pageFile, JSON.stringify(page), "utf8");
      const resumed = await createLegacyMigrationFixture(home, {}, undefined, rootDir, first.log);
      await migrateLegacyWorkscenes({
        ...resumed,
        migrationRunner: singlePassMigrationRunner(),
      });
      const finalReport = await readMigrationReport(rootDir);
      assert(finalReport.status === "abandoned", `tampered source page did not fail closed: ${JSON.stringify(finalReport)}`);
      return;
    }
    if (kind === "corruption" && caseKey === "cutover-marker-mismatch") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy" }]);
      await markLegacyWorksceneCutover({
        migrationId: "another-migration",
        sourceSnapshotToken: "another-snapshot",
        sourceDigest: protocolDigest("LegacySource", 1, { other: true }),
      });
      const fixture = await createLegacyMigrationFixture(home, {}, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(fixture), "cut over");
      return;
    }
    throw new Error(`Unimplemented legacy migration case: ${kind}:${caseKey}`);
  });
}

async function withLegacyHome(operation: (home: string) => Promise<void>): Promise<void> {
  const previous = process.env.ZHIXING_HOME;
  const home = await createTempDir("s7-legacy-migration");
  process.env.ZHIXING_HOME = home;
  try {
    await operation(home);
  } finally {
    if (previous === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = previous;
  }
}

async function seedLegacyWorkscenes(
  scenes: readonly Array<{
    readonly id: string;
    readonly name: string;
    readonly workdir?: string;
  }>,
): Promise<void> {
  await mkdir(path.dirname(getWorkSceneIndexPath()), { recursive: true });
  await writeFile(getWorkSceneIndexPath(), JSON.stringify({ scenes: scenes.map(({ id }) => id) }), "utf8");
  for (const scene of scenes) {
    await mkdir(getWorkSceneDir(scene.id), { recursive: true });
    await writeFile(path.join(getWorkSceneDir(scene.id), "meta.json"), JSON.stringify({
      ...scene,
      createdAt: NOW,
      lastActiveAt: NOW,
    }), "utf8");
  }
}

async function createLegacyMigrationFixture(
  overrides: Partial<WorkspaceBindingMigrationPort> | string,
  maybeOverrides: Partial<WorkspaceBindingMigrationPort> = {},
  abort?: AbortSignal,
  rootDir?: string,
  existingLog?: FileAuthorityCommitLog,
) {
  const home = typeof overrides === "string" ? overrides : process.env.ZHIXING_HOME!;
  const bindingOverrides = typeof overrides === "string" ? maybeOverrides : overrides;
  const log = existingLog ?? new FileAuthorityCommitLog(
    path.join(home, "authority"),
    new FileArtifactStore(path.join(home, "artifacts")),
    { clock: () => NOW },
  );
  const globalState = await createLegacyGlobalState(home, log);
  const bindings: WorkspaceBindingMigrationPort = {
    async importLegacy(input) { return legacyBinding(input.absolutePath); },
    async activateLegacy() {},
    async abandonLegacy() {},
    ...bindingOverrides,
  };
  observeProducer(migrateLegacyWorkscenes);
  observeRecoveryOwner(migrateLegacyWorkscenes);
  observeResource("legacy-workscene-migration:migration-a");
  return {
    rootDir: rootDir ?? path.join(home, "migration"),
    deviceId: "device-a",
    anchorEpoch: 1,
    globalState,
    bindings,
    log,
    ...(abort ? { abort } : {}),
  };
}

async function createLegacyGlobalState(_home: string, log: FileAuthorityCommitLog) {
  return new AnchorWorksceneGlobalStateAdapter({
    log,
    anchorEpoch: 1,
    removeScene: async () => {},
    clock: () => NOW,
  });
}

function runLegacyMigration(fixture: Awaited<ReturnType<typeof createLegacyMigrationFixture>>) {
  return migrateLegacyWorkscenes(fixture);
}

function singlePassMigrationRunner(): StorageMaintenanceTaskRunner {
  return {
    async run(_obligation: unknown, abort: AbortSignal, execute: (abort: AbortSignal) => Promise<unknown>) {
      await execute(abort);
      return "done";
    },
    stop() {},
  } as unknown as StorageMaintenanceTaskRunner;
}

function legacyBinding(absolutePath: string): LocalWorkspaceBinding {
  return {
    bindingRef: "binding-legacy",
    revision: 1,
    displayName: "Legacy",
    absolutePath,
    workspaceBindingRevision: 1,
  };
}

async function readMigrationReport(rootDir: string): Promise<{
  readonly status: string;
  readonly reason?: string;
  readonly sourceSnapshotToken: string;
}> {
  return JSON.parse(
    await readFile(path.join(rootDir, "workscene-legacy-migration.json"), "utf8"),
  ) as never;
}

function globalControlContext(requestId: string) {
  return {
    principal: { kind: "host" as const, component: "s7-migration" },
    requestId,
    authority: { domain: "global" as const, anchorEpoch: 1 },
    deadlineAt: EXPIRY,
  };
}

function globalReadContext(requestId: string) {
  return globalControlContext(requestId);
}

function sessionActivityScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    SESSION_ACTIVITY_RUNTIME,
    SESSION_ACTIVITY_CASES,
    executeSessionActivityCase,
  );
}

async function executeSessionActivityCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  const fixture = await createSessionActivityFixture();
  if (kind === "variant") {
    await fixture.journal.touchWorksceneSession({
      requestId: "session-upsert",
      sceneId: "scene-a",
      at: NOW,
    });
    if (caseKey === "upsert") {
      assert(
        (await sessionActivityRecords(fixture.log)).some(
          (record) => record.operation === "upsert" && record.sessionRevision === 1,
        ),
        "session owner did not persist the upsert activity fact",
      );
    } else if (caseKey === "delete") {
      await fixture.journal.deleteWorksceneSession({
        requestId: "session-delete",
        sceneId: "scene-a",
        at: "2026-08-01T00:01:00.000Z",
      });
      assert(
        (await sessionActivityRecords(fixture.log)).some(
          (record) => record.operation === "delete" && record.sessionRevision === 2,
        ),
        "session owner did not persist the delete activity fact",
      );
    } else {
      throw new Error(`Unimplemented session activity variant: ${caseKey}`);
    }
    await fixture.createJournal().authorityState();
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "conversation-scene-mismatch") {
      await expectFailure(
        () => fixture.journal.touchWorksceneSession({
          requestId: "wrong-scene",
          sceneId: "scene-b",
          at: NOW,
        }),
        "conversation identity",
      );
    } else if (caseKey === "non-monotonic-revision") {
      await fixture.journal.touchWorksceneSession({
        requestId: "newer-session",
        sceneId: "scene-a",
        at: "2026-08-01T00:02:00.000Z",
      });
      const before = (await fixture.log.readAll()).length;
      await expectFailure(
        () => fixture.journal.touchWorksceneSession({
          requestId: "older-session",
          sceneId: "scene-a",
          at: NOW,
        }),
        "unique next owner mutation",
      );
      assert((await fixture.log.readAll()).length === before, "stale session activity was committed");
    } else if (caseKey === "external-construction") {
      await expectFailure(
        () => fixture.journal.touchWorksceneSession({
          requestId: "external-record",
          sceneId: "scene-a",
          at: NOW,
          record: sessionActivityEntry(
            fixture.conversationId,
            "scene-a",
            NOW,
            "upsert",
            1,
          ).body,
        } as never),
        "fields",
      );
      assert((await fixture.log.readAll()).length === 0, "external activity construction wrote state");
    } else {
      throw new Error(`Unimplemented session activity rejection: ${caseKey}`);
    }
    return;
  }

  const meta = {
    t: "session-meta",
    operation: "create",
    domainRevision: 1,
    requestId: "corrupt-session",
    sceneId: "scene-a",
    lastActiveAt: NOW,
  } as const;
  if (caseKey === "wrong-stream") {
    await fixture.log.append([{
      stream: `run:${fixture.conversationId}`,
      body: sessionActivityEntry(
        fixture.conversationId,
        "scene-a",
        NOW,
        "upsert",
        1,
      ).body,
    }]);
    await expectFailure(() => fixture.createJournal().authorityState(), "run stream");
  } else if (caseKey === "invalid-time") {
    await fixture.log.append([
      { stream: `run:${fixture.conversationId}`, body: { ...meta, lastActiveAt: "not-a-time" } },
      sessionActivityEntry(fixture.conversationId, "scene-a", "not-a-time", "upsert", 1),
    ]);
    await expectFailure(() => fixture.createJournal().authorityState(), "time");
  } else if (caseKey === "identity-rebinding") {
    await fixture.log.append([
      { stream: `run:${fixture.conversationId}`, body: meta },
      sessionActivityEntry("ws:scene-a:other", "scene-a", NOW, "upsert", 1),
    ]);
    await expectFailure(() => fixture.createJournal().authorityState(), "atomic activity");
  } else {
    throw new Error(`Unimplemented session activity corruption: ${caseKey}`);
  }
}

async function createSessionActivityFixture() {
  const root = await createTempDir("s7-session-activity");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(root, "authority"),
    artifacts,
    { clock: () => NOW },
  );
  const conversationId = "ws:scene-a:conversation-a";
  const createJournal = () => new ConversationRunJournal({
    conversationId,
    ownerEpoch: 1,
    log,
    artifacts,
    signer: identity,
    verifier: identity,
    submission: { authenticate() {}, authorize() {} },
    authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} },
    delivery: new OwnerDeliveryParticipant({
      authority: new DeliveryAuthority({ log, anchorEpoch: 1 }),
    }),
    clock: () => NOW,
  });
  const journal = createJournal();
  observeProducer(journal);
  observeRecoveryOwner(journal);
  observeResource(`session-activity:${conversationId}`);
  return { conversationId, log, journal, createJournal };
}

async function sessionActivityRecords(log: AuthorityCommitLog) {
  return (await log.readAll())
    .flatMap((envelope) => envelope.entries)
    .filter((entry) =>
      typeof entry.body === "object" &&
      entry.body !== null &&
      "kind" in entry.body &&
      entry.body.kind === "session-activity",
    )
    .map((entry) => entry.body as {
      readonly operation: "upsert" | "delete";
      readonly sessionRevision: number;
    });
}

function worksceneActivityProjectionScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    WORKSCENE_ACTIVITY_RUNTIME,
    WORKSCENE_ACTIVITY_CASES,
    executeWorksceneActivityProjectionCase,
  );
}

async function executeWorksceneActivityProjectionCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    const fixture = await createActivityProjectionFixture();
    await fixture.log.append([
      sessionActivityEntry("ws:scene-a:conversation-a", "scene-a", NOW, "upsert", 1),
    ]);
    if (caseKey === "put") {
      assert(
        await fixture.projection.get("scene-a") === NOW,
        "activity producer did not materialize the scene aggregate",
      );
      const restarted = new IncrementalWorksceneActivityProjection({ log: fixture.log });
      assert(
        await restarted.get("scene-a") === NOW,
        "activity recovery owner did not replay the put",
      );
    } else if (caseKey === "tombstone") {
      await fixture.log.append([
        sessionActivityEntry(
          "ws:scene-a:conversation-a",
          "scene-a",
          "2026-08-01T00:01:00.000Z",
          "delete",
          2,
        ),
      ]);
      assert(
        await new IncrementalWorksceneActivityProjection({ log: fixture.log }).get("scene-a") === undefined,
        "activity recovery owner did not replay the tombstone",
      );
    } else {
      throw new Error(`Unimplemented activity projection variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    const fixture = await createActivityProjectionFixture();
    if (caseKey === "stale-contribution") {
      await fixture.log.append([
        sessionActivityEntry(
          "ws:scene-a:conversation-a",
          "scene-a",
          "2026-08-01T00:02:00.000Z",
          "upsert",
          2,
        ),
      ]);
      await fixture.projection.get("scene-a");
      await fixture.log.append([
        sessionActivityEntry(
          "ws:scene-a:conversation-a",
          "scene-a",
          NOW,
          "upsert",
          1,
        ),
      ]);
      assert(
        await fixture.projection.get("scene-a") === "2026-08-01T00:02:00.000Z",
        "stale activity contribution replaced the authoritative newer revision",
      );
    } else if (caseKey === "wrong-scene") {
      await expectFailure(
        () => fixture.log.append([
          sessionActivityEntry("ws:scene-a:conversation-a", "scene-b", NOW, "upsert", 1),
        ]),
        "scene",
      );
    } else if (caseKey === "wrong-conversation") {
      const entry = sessionActivityEntry(
        "ws:scene-a:conversation-a",
        "scene-a",
        NOW,
        "upsert",
        1,
      );
      await expectFailure(
        () => fixture.log.append([{ ...entry, stream: "session-activity:ws:scene-a:other" }]),
        "conversation",
      );
    } else {
      throw new Error(`Unimplemented activity projection rejection: ${caseKey}`);
    }
    return;
  }

  if (caseKey === "invalid-contribution") {
    const projection = activityProjectionWithIndex({
      async scan() {
        return { entries: [{ key: "bad", value: { sceneId: "scene-a" } }] };
      },
    });
    await expectFailure(() => projection.contributions("scene-a"), "contribution");
  } else if (caseKey === "invalid-aggregate") {
    const projection = activityProjectionWithIndex({
      async get() {
        return { sceneId: "scene-a" };
      },
    });
    await expectFailure(() => projection.get("scene-a"), "aggregate");
  } else if (caseKey === "checkpoint-mismatch") {
    const projection = activityProjectionWithIndex({
      async get() {
        throw new Error("Projection checkpoint does not match authority source");
      },
    });
    await expectFailure(() => projection.get("scene-a"), "checkpoint");
  } else {
    throw new Error(`Unimplemented activity projection corruption: ${caseKey}`);
  }
}

async function createActivityProjectionFixture() {
  const root = await createTempDir("s7-workscene-activity");
  const log = new FileAuthorityCommitLog(
    path.join(root, "authority"),
    new FileArtifactStore(path.join(root, "artifacts")),
    { clock: () => NOW },
  );
  const projection = new IncrementalWorksceneActivityProjection({ log });
  observeProducer(projection);
  observeRecoveryOwner(projection);
  observeResource("workscene-session-activity-v2");
  return { log, projection };
}

function sessionActivityEntry(
  conversationId: string,
  sceneId: string,
  lastActiveAt: string,
  operation: "upsert" | "delete",
  sessionRevision: number,
) {
  return {
    stream: `session-activity:${conversationId}`,
    body: {
      kind: "session-activity" as const,
      operation,
      conversationId,
      sceneId,
      sessionRevision,
      lastActiveAt,
    },
  };
}

function activityProjectionWithIndex(
  partial: Partial<DurableProjectionIndex>,
): IncrementalWorksceneActivityProjection {
  const index = {
    async get() { return undefined; },
    async scan() { return { entries: [] }; },
    ...partial,
  } as unknown as DurableProjectionIndex;
  const log = {
    durableProjection() { return index; },
  } as unknown as AuthorityCommitLog;
  const projection = new IncrementalWorksceneActivityProjection({ log });
  observeProducer(projection);
  observeRecoveryOwner(projection);
  observeResource("workscene-session-activity-v2");
  return projection;
}

function localWorkspaceOutboxScenarios(): [string, S7ExecutableScenario][] {
  return executableScenarios(
    LOCAL_WORKSPACE_OUTBOX_RUNTIME,
    LOCAL_WORKSPACE_OUTBOX_CASES,
    executeLocalWorkspaceOutboxCase,
  );
}

async function executeLocalWorkspaceOutboxCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    if (caseKey === "prepared") {
      const outbox = await createOutbox();
      const prepared = await outbox.prepare(createInput("prepared"));
      assert(prepared.state === "prepared", "prepare did not persist the prepared state");
      await recoverOutboxWithHost(outbox);
      assert(
        (await new LocalWorkspaceOperationOutbox({
          rootDir: outboxRoot(outbox),
        }).pending()).operations[0]?.state === "prepared",
        "recovery host changed an uncommitted operation",
      );
    } else if (caseKey === "committed") {
      const outbox = await createOutbox();
      const committed = await outbox.commit(
        await outbox.prepare(createInput("committed")),
      );
      assert(committed.state === "committed", "commit did not persist the committed state");
      const recovery = await recoverOutboxWithHost(outbox);
      assert(recovery.executions === 1, "recovery host did not drive the committed side effect once");
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "completed",
        "recovery host did not complete the committed operation",
      );
    } else if (caseKey === "completed") {
      const outbox = await createOutbox();
      const committed = await outbox.commit(
        await outbox.prepare(createInput("completed")),
      );
      const completed = await outbox.complete(committed, {
        ok: true,
        value: { name: "completed" },
      });
      assert(completed.state === "completed", "completion did not persist the completed state");
      const recovery = await recoverOutboxWithHost(outbox);
      assert(recovery.executions === 0, "recovery host repeated a completed side effect");
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "completed",
        "recovery host did not replay the completed state",
      );
    } else if (caseKey === "abandoned") {
      const root = path.join(
        await createTempDir("s7-outbox-abandoned"),
        "runtime",
        "local-workspace-operation-outbox",
      );
      let now = "2026-08-01T00:00:00.000Z";
      const outbox = trackOutbox(new LocalWorkspaceOperationOutbox({
        rootDir: root,
        clock: () => now,
      }), root);
      const prepared = await outbox.prepare({
        kind: "reset",
        expectedCatalogGeneration: "catalog-a",
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      });
      now = "2026-08-01T00:15:00.001Z";
      await expectFailure(
        () => outbox.commit(prepared, { impact: WORKSPACE_CATALOG_RESET_IMPACT }),
        "abandoned",
      );
      const recovery = await recoverOutboxWithHost(outbox);
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "abandoned",
        "expired preview did not recover as abandoned",
      );
    } else {
      throw new Error(`Unimplemented local workspace outbox variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "identity-mismatch") {
      const outbox = await createOutbox();
      const prepared = await outbox.prepare(createInput("identity"));
      await expectFailure(
        () => outbox.commit({ ...prepared, operationId: `${prepared.operationId}-forged` }),
        "identity",
      );
      await recoverOutboxWithHost(outbox);
    } else if (caseKey === "confirmation-hole") {
      const outbox = await createOutbox();
      await outbox.prepare(createInput("hole-one"));
      const second = await outbox.commit(
        await outbox.prepare(createInput("hole-two")),
      );
      const completed = await outbox.complete(second, { ok: true, value: null });
      await expectFailure(
        () => outbox.acknowledge({
          outboxId: outbox.outboxId,
          throughSeq: completed.localSeq,
          prefixDigest: completed.resultDigest!,
          entries: [{
            localSeq: completed.localSeq,
            operationId: completed.operationId,
            inputDigest: completed.inputDigest,
            resultDigest: completed.resultDigest!,
          }],
        }),
        "hole",
      );
      await recoverOutboxWithHost(outbox);
    } else {
      throw new Error(`Unimplemented local workspace outbox rejection: ${caseKey}`);
    }
    return;
  }

  if (caseKey === "checkpoint-chain") {
    const root = path.join(
      await createTempDir("s7-outbox-chain"),
      "runtime",
      "local-workspace-operation-outbox",
    );
    const outbox = trackOutbox(
      new LocalWorkspaceOperationOutbox({ rootDir: root }),
      root,
    );
    await outbox.prepare(createInput("chain"));
    const file = path.join(root, "operations.ndjson");
    const content = await readFile(file, "utf8");
    await writeFile(
      file,
      content.replace(
        /"digest":"sha256:[0-9a-f]+"/u,
        '"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
      ),
      "utf8",
    );
    await expectFailure(
      () => recoverOutboxWithHost(outbox),
      "digest",
    );
  } else if (caseKey === "establishment-marker") {
    const root = path.join(
      await createTempDir("s7-outbox-marker"),
      "runtime",
      "local-workspace-operation-outbox",
    );
    const outbox = trackOutbox(
      new LocalWorkspaceOperationOutbox({ rootDir: root }),
      root,
    );
    await outbox.initialize();
    const marker = `${root}.established`;
    const value = JSON.parse(await readFile(marker, "utf8"));
    value.outboxId = "outbox-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(marker, `${JSON.stringify(value)}\n`, "utf8");
    await expectFailure(
      () => recoverOutboxWithHost(outbox),
      "identity",
    );
  } else {
    throw new Error(`Unimplemented local workspace outbox corruption: ${caseKey}`);
  }
}

function scenario(
  runtime: ScenarioFamily,
  kind: "variant" | "rejection" | "corruption",
  caseKey: string,
  reasonCode: string,
  execute: () => Promise<void>,
): S7ExecutableScenario {
  return async () => {
    const evidence: ScenarioEvidence = {
      details: [],
      outcomes: [],
      producers: new Set(),
      recoveryOwnerCandidates: new Set(),
      recoveryOwners: new Set(),
      resourceIdentities: new Set(),
    };
    await evidenceContext.run(evidence, async () => {
      await execute();
      observeOutcome(kind, caseKey);
      commitObservedRecoveryOwners();
    });
    if (evidence.details.length === 0) {
      throw new Error(
        `S7 scenario ${runtime.family}:${kind}:${caseKey} did not observe a production fact`,
      );
    }
    const outcome = onlyObserved(
      evidence.outcomes,
      "durable outcome",
      runtime.family,
      kind,
      caseKey,
    );
    const producer = onlyObserved(
      evidence.producers,
      "producer",
      runtime.family,
      kind,
      caseKey,
    );
    const recoveryOwner = onlyObserved(
      evidence.recoveryOwners,
      "recovery owner",
      runtime.family,
      kind,
      caseKey,
    );
    const resourceIdentity = onlyObserved(
      evidence.resourceIdentities,
      "resource identity",
      runtime.family,
      kind,
      caseKey,
    );
    return {
      family: runtime.family,
      kind: outcome.kind,
      caseKey: outcome.caseKey,
      reasonCode,
      producer,
      recoveryOwner,
      resourceIdentity,
      evidence: evidence.details.join(" | "),
    };
  };
}

function onlyObserved<T>(
  values: Iterable<T>,
  label: string,
  family: string,
  kind: DurableCaseKind,
  caseKey: string,
): T {
  const observed = [...values];
  if (observed.length !== 1) {
    throw new Error(
      `S7 scenario ${family}:${kind}:${caseKey} observed ${observed.length} ${label} values`,
    );
  }
  return observed[0]!;
}

function observeProducer(producer: object | ((...args: never[]) => unknown)): void {
  const name = typeof producer === "function"
    ? producer.name
    : producer.constructor.name;
  if (!name) throw new Error("S7 scenario producer has no runtime identity");
  evidenceContext.getStore()?.producers.add(name);
}

function observeRecoveryOwner(owner: object | ((...args: never[]) => unknown)): void {
  const name = typeof owner === "function" ? owner.name : owner.constructor.name;
  const identity = RECOVERY_OWNER_BY_RUNTIME.get(name);
  if (!identity) {
    throw new Error(`S7 recovery owner ${name || "<anonymous>"} has no runtime identity`);
  }
  evidenceContext.getStore()?.recoveryOwnerCandidates.add(identity);
}

function commitObservedRecoveryOwners(): void {
  const evidence = evidenceContext.getStore();
  if (!evidence) return;
  for (const owner of evidence.recoveryOwnerCandidates) {
    evidence.recoveryOwners.add(owner);
  }
}

const RECOVERY_OWNER_BY_RUNTIME = new Map<string, string>([
  [AnchorWorksceneGlobalStateAdapter.name, "anchor-workscene-owner"],
  [WorkspaceBindingCatalog.name, "workspace-binding-recovery-owner"],
  [WorkspaceProbeHandler.name, "workspace-probe-owner"],
  [WorkspaceBindingService.name, "workspace-binding-recovery-owner"],
  [migrateLegacyWorkscenes.name, "workscene-migration-owner"],
  [ConversationRunJournal.name, "anchor-workscene-owner"],
  [IncrementalWorksceneActivityProjection.name, "anchor-workscene-owner"],
  [LocalWorkspaceManagementHost.name, "LocalWorkspaceManagementHost"],
]);

function observeResource(resourceIdentity: string): void {
  if (resourceIdentity.length === 0) {
    throw new Error("S7 scenario resource identity is empty");
  }
  evidenceContext.getStore()?.resourceIdentities.add(resourceIdentity);
}

function observeOutcome(kind: DurableCaseKind, caseKey: string): void {
  const outcomes = evidenceContext.getStore()?.outcomes;
  if (!outcomes) return;
  if (!outcomes.some((candidate) =>
    candidate.kind === kind && candidate.caseKey === caseKey)) {
    outcomes.push({ kind, caseKey });
  }
}

function createInput(name: string): LocalWorkspaceWriteOperation {
  return {
    kind: "create",
    purpose: "settings",
    displayName: name,
    absolutePath: path.resolve(name),
  };
}

const roots = new WeakMap<LocalWorkspaceOperationOutbox, string>();

async function createOutbox(): Promise<LocalWorkspaceOperationOutbox> {
  const root = path.join(
    await createTempDir("s7-outbox-scenario"),
    "runtime",
    "local-workspace-operation-outbox",
  );
  const outbox = trackOutbox(
    new LocalWorkspaceOperationOutbox({ rootDir: root }),
    root,
  );
  return outbox;
}

function trackOutbox(
  outbox: LocalWorkspaceOperationOutbox,
  root: string,
): LocalWorkspaceOperationOutbox {
  roots.set(outbox, root);
  observeProducer(outbox);
  observeResource(root);
  return outbox;
}

async function recoverOutboxWithHost(
  outbox: LocalWorkspaceOperationOutbox,
): Promise<{
  readonly executions: number;
  readonly outbox: LocalWorkspaceOperationOutbox;
}> {
  const root = outboxRoot(outbox);
  const home = path.dirname(path.dirname(root));
  const lease = await acquireLocalWorkspaceOwner(home);
  const recoveredOutbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
  let executions = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected local workspace recovery operation");
  };
  const host = new LocalWorkspaceManagementHost({
    lease,
    facade: {
      status: async () => ({
        state: "healthy" as const,
        catalogGeneration: "catalog-a",
      }),
      list: async () => [],
      create: async (displayName: string, absolutePath: string) => {
        executions += 1;
        return {
          name: displayName,
          path: absolutePath,
          revision: 1,
          workspaceBindingRevision: 1,
        };
      },
      authorizeForControl: async () => ({
        deviceId: "device-a",
        bindingRef: "binding-a",
      }),
      rename: unavailable,
      repath: unavailable,
      remove: unavailable,
      reset: unavailable,
    },
    outbox: recoveredOutbox,
  });
  try {
    observeRecoveryOwner(host);
    await host.start();
    return { executions, outbox: recoveredOutbox };
  } finally {
    await host.close();
    await lease.release();
  }
}

function outboxRoot(outbox: LocalWorkspaceOperationOutbox): string {
  const root = roots.get(outbox);
  if (!root) throw new Error("Outbox scenario root is unavailable");
  return root;
}

async function expectFailure(
  operation: () => Promise<unknown>,
  fragment: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `expected failure containing ${fragment}`);
  assert(
    caught.message.toLowerCase().includes(fragment.toLowerCase()),
    `failure did not contain ${fragment}: ${caught.message}`,
  );
  evidenceContext.getStore()?.details.push(
    `error:${caught.constructor.name}:${caught.message}`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  evidenceContext.getStore()?.details.push(`assert:${message}`);
}
