import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WorkspaceBindingCatalog,
  WorkspaceBindingCatalogConflictError,
  WorkspaceBindingCatalogIntegrityError,
  WorkspaceBindingConflictError,
  WorkspaceBindingNotFoundError,
  WorkspaceBindingRevisionError,
  WorkspaceBindingService,
  EnvironmentProbeOwner,
  WorkspaceProbeHandler,
  localEnvironmentControlSubject,
  workspaceCatalogGenerationStorageKey,
} from "../environment/index.js";
import {
  AnchorWorksceneGlobalStateAdapter,
  WorksceneConflictError,
  WorksceneRevisionError,
  worksceneImportSetDigest,
} from "../workscene/index.js";
import { AnchorWorksceneRegistry } from "../workscene/authority-registry.js";
import { IncrementalWorksceneActivityProjection } from "../workscene/activity-projection.js";
import {
  AuthorityStorageError,
  bindDurableProjectionMutations,
  durableProjectionDirectoryName,
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileDurableProjectionIndex,
  type AuthorityCommitLog,
} from "../authority/index.js";
import type {
  CapabilityDescriptor,
  ExecutorVersionInventory,
  ImmediateRootResourceLease,
  ResourceLease,
} from "../contracts/index.js";
import {
  createSignedEnvironmentControlGrant,
  createSignedWorkspaceProbeResult,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  workspaceProbeRequestDigest,
} from "../protocol/index.js";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  StorageMaintenanceTaskRunner,
} from "../resources/index.js";

import {
  assert,
  createS7TempDir,
  expectFailure,
  observeError,
  observeOutcome,
  observeReasonCode,
  registerS7Cleanup,
  type DurableCaseKind,
} from "./s7-durable-harness.js";


const NOW = "2026-08-01T00:00:00.000Z";
const EXPIRY = "2026-08-01T01:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return { alg: "test-digest", keyId: "device-a", sig: protocolDigest(schemaId, version, payload) };
  },
  verify(schemaId, version, payload, signature) {
    assert(JSON.stringify(signature) === JSON.stringify(this.sign(schemaId, version, payload)), "signature did not bind the production payload");
  },
};

export async function executeWorksceneRegistryCase(
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
        { kind: "variant", caseKey: "established" },
      );
    } else if (caseKey === "control-applied") {
      await fixture.adapter.mutate(
        worksceneCreateMutation(),
        globalControlContext("workscene-create"),
      );
      const recovered = await createRecoveredWorksceneAdapter(fixture.log).read(
        { kind: "workscene-get", sceneId: "scene-a" },
        globalReadContext("workscene-replay"),
      );
      assert(
        recovered.kind === "workscene-get" && recovered.scene?.name === "Project",
        "production recovery owner did not replay the control record",
        { kind: "variant", caseKey: "control-applied" },
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
      assert(
        open.kind === "workscene-get" && open.scene === null,
        "open import became visible before activation",
        {
        kind: "variant",
        caseKey: "legacy-import-open",
        },
      );
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
      const recovered = await createRecoveredWorksceneAdapter(fixture.log).read(
        { kind: "workscene-get", sceneId: "legacy-a" },
        globalReadContext("legacy-activate-replay"),
      );
      assert(
        recovered.kind === "workscene-get" && recovered.scene?.name === "Legacy",
        "production recovery owner did not replay legacy activation",
        { kind: "variant", caseKey: "legacy-import-activated" },
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
      const recovered = await createRecoveredWorksceneAdapter(fixture.log).read(
        { kind: "workscene-get", sceneId: "legacy-a" },
        globalReadContext("legacy-abandon-replay"),
      );
      assert(
        recovered.kind === "workscene-get" && recovered.scene === null,
        "abandoned import became visible after recovery",
        { kind: "variant", caseKey: "legacy-import-abandoned" },
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
        { kind: "variant", caseKey: "deletion-projected" },
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
      assert((await fixture.log.readAll()).length === 0, "rejected principal wrote durable state", {
        kind: "rejection",
        caseKey: "principal-method",
      });
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
        { kind: "rejection", caseKey: "request-conflict" },
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
        { kind: "rejection", caseKey: "revision-conflict" },
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
        { kind: "rejection", caseKey: "deletion-pending" },
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
      { kind: "corruption", caseKey: "unknown-record" },
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
      { kind: "corruption", caseKey: "non-contiguous-revision" },
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
      { kind: "corruption", caseKey: "broken-deletion-confirmation" },
    );
  } else {
    throw new Error(`Unimplemented workscene registry corruption: ${caseKey}`);
  }
}

async function createWorksceneRegistryFixture(options: {
  readonly removeScene?: () => Promise<void>;
} = {}) {
  const root = await createS7TempDir("s7-workscene-registry");
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

export async function executeWorkspaceBindingRootCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    if (caseKey === "healthy") {
      const fixture = await createWorkspaceCatalogFixture();
      await fixture.catalog.initialize();
      assert((await fixture.catalog.status()).state === "healthy", "healthy catalog did not open", {
        kind: "variant",
        caseKey: "healthy",
      });
    } else if (caseKey === "degraded") {
      const fixture = await createWorkspaceCatalogFixture(corruptWorkspaceCatalogLog());
      await fixture.catalog.initialize();
      assert((await fixture.catalog.status()).state === "degraded", "corrupt catalog did not degrade");
      assert(fixture.published.at(-1)?.length === 0, "degraded catalog did not withdraw workspace capability", {
        kind: "variant",
        caseKey: "degraded",
      });
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
        { kind: "variant", caseKey: "pending-reset" },
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
        { kind: "rejection", caseKey: "healthy-reset" },
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
        { kind: "rejection", caseKey: "confirmation-mismatch" },
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
        { kind: "rejection", caseKey: "generation-conflict" },
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
        { kind: "rejection", caseKey: "reservation-conflict" },
      );
    } else {
      throw new Error(`Unimplemented workspace root rejection: ${caseKey}`);
    }
    return;
  }

  const root = await createS7TempDir(`s7-workspace-root-${caseKey}`);
  const catalogRoot = path.join(root, "catalog");
  await mkdir(catalogRoot, { recursive: true });
  if (caseKey === "malformed-manifest") {
    await writeFile(path.join(catalogRoot, "root-manifest.json"), "{bad-json", "utf8");
    const fixture = await createWorkspaceCatalogFixture(undefined, root);
    await expectInstance(() => fixture.catalog.initialize(), WorkspaceBindingCatalogIntegrityError, {
      kind: "corruption",
      caseKey: "malformed-manifest",
    });
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
    const status = await fixture.catalog.status();
    assert(status.state === "degraded", "missing active log did not degrade", {
      kind: "corruption",
      caseKey: "missing-active-log",
    });
    observeReasonCode(status.reason ?? "", "catalog status after missing active log recovery");
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
    const status = await fixture.catalog.status();
    assert(status.state === "degraded", "invalid reset genesis escaped fail-closed recovery", {
      kind: "corruption",
      caseKey: "invalid-reset-genesis",
    });
    observeReasonCode(status.reason ?? "", "catalog status after invalid reset genesis recovery");
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
    await expectInstance(() => fixture.catalog.initialize(), WorkspaceBindingCatalogIntegrityError, {
      kind: "corruption",
      caseKey: "broken-generation-link",
    });
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
  const root = existingRoot ?? await createS7TempDir("s7-workspace-catalog");
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
  registerS7Cleanup(() => catalog.stop());
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

export async function executeWorkspaceProbeCase(
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
        { kind: "variant", caseKey: "log-established" },
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
          { kind: "variant", caseKey: "completed" },
        );
      } else {
        observeOutcome({ kind: "variant", caseKey: "started" });
      }
    } else if (caseKey === "retired") {
      await fixture.handler.probe(request);
      await fixture.handler.compact("2026-08-01T00:01:00.000Z");
      assert(
        (await fixture.probeLog.readAll()).some((envelope) => envelope.entries.some(
          (entry) => (entry.body as { t?: string }).t === "probe-retired",
        )),
        "probe retention owner did not persist retirement",
        { kind: "variant", caseKey: "retired" },
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
        { kind: "rejection", caseKey: "grant-binding" },
      );
    } else if (caseKey === "lease-binding") {
      await expectFailure(
        () => fixture.handler.probe({
          ...request,
          resourceLease: immediateLease("another-request"),
        }),
        "lease",
        { kind: "rejection", caseKey: "lease-binding" },
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
        { kind: "rejection", caseKey: "request-conflict" },
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
        { kind: "rejection", caseKey: "expired-fresh-request" },
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
  let corruptionOutcome: Readonly<{
    kind: "corruption";
    caseKey: string;
  }>;
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
    corruptionOutcome = { kind: "corruption", caseKey: "invalid-result" };
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
    corruptionOutcome = { kind: "corruption", caseKey: "request-result-mismatch" };
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
    corruptionOutcome = { kind: "corruption", caseKey: "broken-replay-index" };
  } else {
    throw new Error(`Unimplemented workspace probe corruption: ${caseKey}`);
  }
  await expectFailure(
    () => corrupt.createHandler().probe(corruptRequest),
    caseKey === "invalid-result" ? "result" : caseKey === "request-result-mismatch" ? "completion" : "reused",
    corruptionOutcome,
  );
}

async function createWorkspaceProbeFixture(clock: () => string = () => NOW) {
  const root = await createS7TempDir("s7-workspace-probe");
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

export async function executeWorkspaceBindingCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    const service = await createWorkspaceBindingService();
    if (caseKey === "directory-established") {
      assert((await service.list(control("directory"))).length === 0, "directory did not establish", { kind: "variant", caseKey: "directory-established" });
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
      assert(receipt?.previousCatalogGeneration === "catalog-previous", "reset genesis did not replay", { kind: "variant", caseKey: "catalog-reset" });
    } else if (caseKey === "binding-created") {
      assert((await createBinding(service, "created")).revision === 1, "create did not commit", { kind: "variant", caseKey: "binding-created" });
    } else if (caseKey === "binding-updated") {
      const binding = await createBinding(service, "updated");
      assert((await service.update(binding.bindingRef, { displayName: "Updated" }, 1, control("update"))).revision === 2, "update did not commit", { kind: "variant", caseKey: "binding-updated" });
    } else if (caseKey === "binding-removed") {
      const binding = await createBinding(service, "removed");
      await service.remove(binding.bindingRef, 1, control("remove"));
      assert((await service.list(control("removed-list"))).length === 0, "remove did not commit", { kind: "variant", caseKey: "binding-removed" });
    } else if (caseKey === "request-recorded") {
      const binding = await createBinding(service, "recorded");
      const replay = await service.update(
        binding.bindingRef,
        { displayName: binding.displayName },
        1,
        control("record-noop"),
      );
      assert(replay.revision === 1, "no-op request was not durably recorded", { kind: "variant", caseKey: "request-recorded" });
    } else if (caseKey === "legacy-binding-staged") {
      const binding = await service.importLegacy(legacyInput("staged"), new AbortController().signal);
      assert(binding.revision === 1, "legacy binding was not staged", { kind: "variant", caseKey: "legacy-binding-staged" });
    } else if (caseKey === "legacy-migration-activated") {
      const input = legacyInput("activated");
      await service.importLegacy(input, new AbortController().signal);
      await service.activateLegacy({
        migrationId: input.migrationId,
        sourceSnapshotToken: input.sourceSnapshotToken,
      }, new AbortController().signal);
      assert((await service.list(control("activated-list"))).length === 1, "legacy migration was not activated", { kind: "variant", caseKey: "legacy-migration-activated" });
    } else if (caseKey === "legacy-migration-abandoned") {
      const input = legacyInput("abandoned");
      await service.importLegacy(input, new AbortController().signal);
      await service.abandonLegacy({
        migrationId: input.migrationId,
        sourceSnapshotToken: input.sourceSnapshotToken,
        reason: "operator-abandoned",
      }, new AbortController().signal);
      assert((await service.list(control("abandoned-list"))).length === 0, "abandoned binding became active", { kind: "variant", caseKey: "legacy-migration-abandoned" });
    } else {
      throw new Error(`Unimplemented workspace binding variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    const service = await createWorkspaceBindingService();
    if (caseKey === "control-lease") {
      await expectFailure(() => service.list({ ...control("bad-lease"), lease: immediateLease("wrong-subject") }), "lease", { kind: "rejection", caseKey: "control-lease" });
    } else if (caseKey === "name-conflict") {
      await createBinding(service, "name-conflict");
      await expectInstance(() => service.create({ displayName: "name-CONFLICT", absolutePath: path.resolve("other") }, control("duplicate-name")), WorkspaceBindingConflictError, { kind: "rejection", caseKey: "name-conflict" });
    } else if (caseKey === "revision-conflict") {
      const binding = await createBinding(service, "revision");
      await expectInstance(() => service.update(binding.bindingRef, { displayName: "Later" }, 2, control("bad-revision")), WorkspaceBindingRevisionError, { kind: "rejection", caseKey: "revision-conflict" });
    } else if (caseKey === "tombstoned-reference") {
      const binding = await createBinding(service, "tombstone");
      await service.remove(binding.bindingRef, 1, control("tombstone-remove"));
      await expectInstance(() => service.update(binding.bindingRef, { displayName: "Revive" }, 1, control("revive")), WorkspaceBindingNotFoundError, { kind: "rejection", caseKey: "tombstoned-reference" });
    } else {
      throw new Error(`Unimplemented workspace binding rejection: ${caseKey}`);
    }
    return;
  }

  if (caseKey === "missing-establishment") {
      const root = await createS7TempDir("s7-binding-missing-establishment");
      await appendWorkspaceBindingRecord(root, validWorkspaceBindingCreatedRecord());
      await expectFailure(() => createWorkspaceBindingService({ root }).then((service) => service.initialize()), "establish", { kind: "corruption", caseKey: "missing-establishment" });
  } else if (caseKey === "invalid-record") {
      const root = await createS7TempDir("s7-binding-invalid-record");
      const service = await createWorkspaceBindingService({ root });
      await service.list(control("establish-before-invalid"));
      await appendWorkspaceBindingRecord(root, { t: "unknown-workspace-record" });
      await expectFailure(() => createWorkspaceBindingService({ root }).then((restarted) => restarted.initialize()), "record", { kind: "corruption", caseKey: "invalid-record" });
  } else if (caseKey === "broken-log-tail") {
      const root = await createS7TempDir("s7-binding-broken-tail");
      const service = await createWorkspaceBindingService({ root });
      await service.list(control("establish-before-tail"));
      const logPath = path.join(root, "binding-log", "authority.log");
      const bytes = await readFile(logPath);
      const frameOffset = bytes.readUInt32BE(0) === 0x5a584148 ? 72 : 0;
      const payloadEnd = frameOffset + 16 + bytes.readUInt32BE(frameOffset + 8);
      bytes[payloadEnd - 1] = bytes[payloadEnd - 1] === 0x7d ? 0x7b : 0x7d;
      await writeFile(logPath, bytes);
      await expectFailure(() => createWorkspaceBindingService({ root }).then((restarted) => restarted.initialize()), "valid JSON", { kind: "corruption", caseKey: "broken-log-tail" });
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
  const root = options.root ?? await createS7TempDir("s7-workspace-binding");
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
  outcome?: Readonly<{
    kind: "rejection" | "corruption";
    caseKey: string;
  }>,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof expected, `expected ${expected.name}`);
  observeError(caught);
  if (outcome) observeOutcome(outcome);
}



function globalControlContext(requestId: string) {
  return {
    principal: { kind: "host" as const, component: "s7-durable-scenario" },
    requestId,
    authority: { domain: "global" as const, anchorEpoch: 1 },
    deadlineAt: EXPIRY,
  };
}

function globalReadContext(requestId: string) {
  return globalControlContext(requestId);
}

export async function executeWorksceneActivityProjectionCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    if (caseKey === "checkpoint-mismatch") {
      const fixture = await createActivityProjectionStorageFixture();
      await fixture.log.append([
        sessionActivityEntry("ws:scene-a:conversation-a", "scene-a", NOW, "upsert", 1),
      ]);
      const checkpoint = await fixture.log.checkpoint();
      await writeActivityProjectionStorage(fixture.root, {
        ...checkpoint,
        lsn: checkpoint.lsn + 1,
      }, []);
      const restarted = createActivityProjectionAt(fixture.root);
      assert(
        await restarted.get("scene-a") === NOW,
        "activity recovery owner did not rebuild a mismatched checkpoint",
        { kind: "variant", caseKey: "checkpoint-mismatch" },
      );
      return;
    }
    if (caseKey === "stale-contribution") {
      const fixture = await createActivityProjectionFixture();
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
        { kind: "variant", caseKey: "stale-contribution" },
      );
      return;
    }
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
        { kind: "variant", caseKey: "put" },
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
        { kind: "variant", caseKey: "tombstone" },
      );
    } else {
      throw new Error(`Unimplemented activity projection variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    const fixture = await createActivityProjectionFixture();
    if (caseKey === "wrong-scene") {
      await expectFailure(
        () => fixture.log.append([
          sessionActivityEntry("ws:scene-a:conversation-a", "scene-b", NOW, "upsert", 1),
        ]),
        "scene",
        { kind: "rejection", caseKey: "wrong-scene" },
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
        { kind: "rejection", caseKey: "wrong-conversation" },
      );
    } else {
      throw new Error(`Unimplemented activity projection rejection: ${caseKey}`);
    }
    return;
  }

  if (caseKey === "invalid-contribution") {
    const fixture = await createActivityProjectionStorageFixture();
    const checkpoint = await fixture.log.checkpoint();
    await writeActivityProjectionStorage(fixture.root, checkpoint, [{
      kind: "put",
      key: activityContributionKey("scene-a", "ws:scene-a:conversation-a"),
      value: { sceneId: "scene-a" },
    }]);
    await expectFailure(
      () => createActivityProjectionAt(fixture.root).contributions("scene-a"),
      "contribution",
      { kind: "corruption", caseKey: "invalid-contribution" },
    );
  } else if (caseKey === "invalid-aggregate") {
    const fixture = await createActivityProjectionStorageFixture();
    const checkpoint = await fixture.log.checkpoint();
    await writeActivityProjectionStorage(fixture.root, checkpoint, [{
      kind: "put",
      key: activityAggregateKey("scene-a"),
      value: { sceneId: "scene-a" },
    }]);
    await expectFailure(
      () => createActivityProjectionAt(fixture.root).get("scene-a"),
      "aggregate",
      { kind: "corruption", caseKey: "invalid-aggregate" },
    );
  } else {
    throw new Error(`Unimplemented activity projection corruption: ${caseKey}`);
  }
}

async function createActivityProjectionFixture() {
  const { root, log } = await createActivityProjectionStorageFixture();
  const projection = new IncrementalWorksceneActivityProjection({ log });
  return { root, log, projection };
}

async function createActivityProjectionStorageFixture() {
  const root = await createS7TempDir("s7-workscene-activity");
  const log = new FileAuthorityCommitLog(
    path.join(root, "authority"),
    new FileArtifactStore(path.join(root, "artifacts")),
    { clock: () => NOW },
  );
  return { root, log };
}

function createActivityProjectionAt(root: string): IncrementalWorksceneActivityProjection {
  return new IncrementalWorksceneActivityProjection({
    log: new FileAuthorityCommitLog(
      path.join(root, "authority"),
      new FileArtifactStore(path.join(root, "artifacts")),
      { clock: () => NOW },
    ),
  });
}

async function writeActivityProjectionStorage(
  root: string,
  checkpoint: Awaited<ReturnType<FileAuthorityCommitLog["checkpoint"]>>,
  mutations: Parameters<typeof bindDurableProjectionMutations>[0],
): Promise<void> {
  const index = new FileDurableProjectionIndex({
    rootDir: path.join(
      root,
      "authority",
      "projections",
      durableProjectionDirectoryName("workscene-session-activity-v2"),
    ),
    projectionId: "workscene-session-activity-v2",
    reducerVersion: 1,
  });
  await index.initialize({ authority: checkpoint });
  if (mutations.length > 0) {
    const prepared = await index.prepare(bindDurableProjectionMutations(mutations));
    index.publish(prepared, { authority: checkpoint });
  }
  await index.flush();
  index.stopStorageMaintenance();
}

function activityContributionKey(sceneId: string, conversationId: string): string {
  return `contribution:${protocolDigest("WorksceneActivitySceneKey", 1, { sceneId })}:${protocolDigest("WorksceneActivityConversationKey", 1, { conversationId })}`;
}

function activityAggregateKey(sceneId: string): string {
  return `scene:${protocolDigest("WorksceneActivitySceneKey", 1, { sceneId })}`;
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
