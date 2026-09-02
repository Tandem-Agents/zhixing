import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  AuthorityStorageError,
  FileArtifactStore,
  FileAuthorityCommitLog,
  type AuthorityCommitLog,
} from "../authority/index.js";
import type {
  CapabilityDescriptor,
  ExecutorVersionInventory,
  ImmediateRootResourceLease,
  ResourceLease,
} from "../contracts/index.js";
import {
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "../protocol/index.js";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  StorageMaintenanceTaskRunner,
} from "../resources/index.js";
import {
  WorkspaceBindingCatalog,
  WorkspaceBindingCatalogConflictError,
  workspaceCatalogGenerationStorageKey,
} from "./workspace-binding-catalog.js";
import { localEnvironmentControlSubject } from "./workspace-bindings.js";
import type { WorkspaceBindingGenerationPersistencePort } from "./workspace-binding-generation-persistence.js";
import type {
  WorkspaceBindingCatalogPersistencePort,
  WorkspaceBindingCatalogRootCommit,
} from "./workspace-binding-catalog-persistence.js";

const NOW = "2026-07-30T00:00:00.000Z";
const EXPIRY = "2026-07-30T01:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;
const capabilityRevisions = new Map<string, number>();
const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "device-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

describe("WorkspaceBindingCatalog", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("fails closed on corrupt root documents and compare-and-swap conflicts", async () => {
    const corruptPersistence = new MemoryWorkspaceBindingCatalogPersistence(
      "{not-json",
    );
    const corrupt = await createFixture(
      undefined,
      undefined,
      corruptPersistence,
    );
    await expect(corrupt.catalog.initialize()).rejects.toThrow(
      "root manifest is corrupt",
    );

    const conflictingPersistence =
      new MemoryWorkspaceBindingCatalogPersistence();
    conflictingPersistence.conflictNextCommit = true;
    const conflicting = await createFixture(
      undefined,
      undefined,
      conflictingPersistence,
    );
    await conflicting.catalog.initialize();
    await expect(conflicting.catalog.status()).resolves.toMatchObject({
      state: "degraded",
      reason: "WORKSPACE_CATALOG_INTEGRITY",
    });
  });

  it("recovers the committed manifest after the physical CAS response is lost", async () => {
    const persistence = new MemoryWorkspaceBindingCatalogPersistence();
    persistence.loseNextCommitResponse = true;
    const first = await createFixture(undefined, undefined, persistence);
    await expect(first.catalog.initialize()).rejects.toThrow();
    await first.catalog.stop();

    const restarted = await createFixture(undefined, first.root, persistence);
    await restarted.catalog.initialize();
    await expect(restarted.catalog.status()).resolves.toMatchObject({
      state: "healthy",
      catalogGeneration: "catalog-initial",
    });
  });

  it("withdraws a corrupt catalog and resets through one durable generation reservation", async () => {
    const fixture = await createFixture(corruptLog());
    await fixture.catalog.initialize();
    expect(await fixture.catalog.status()).toMatchObject({
      state: "degraded",
      catalogGeneration: "catalog-initial",
    });
    expect(fixture.published.at(-1)).toEqual([]);

    const control = recoveryControl("reset-a", "catalog-initial");
    const reservation = await fixture.catalog.beginReset(
      { expectedCatalogGeneration: "catalog-initial" },
      control,
    );
    expect(reservation).toMatchObject({
      requestId: control.requestId,
      previousCatalogGeneration: "catalog-initial",
      preparedAt: NOW,
    });
    const receipt = await fixture.catalog.completeReset(
      control.requestId,
      new AbortController().signal,
    );
    expect(
      await fixture.catalog.completeReset(
        control.requestId,
        new AbortController().signal,
      ),
    ).toEqual(receipt);
    expect(await fixture.catalog.status()).toMatchObject({
      state: "healthy",
      catalogGeneration: receipt.catalogGeneration,
    });
    expect(await fixture.catalog.list(adminControl("list"))).toEqual([]);
    await expect(
      fixture.catalog.beginReset(
        { expectedCatalogGeneration: receipt.catalogGeneration },
        recoveryControl("reset-healthy", receipt.catalogGeneration),
      ),
    ).rejects.toBeInstanceOf(WorkspaceBindingCatalogConflictError);
  });

  it("recovers a pending committed reset after restart without the original lease", async () => {
    const fixture = await createFixture(corruptLog());
    await fixture.catalog.initialize();
    const control = recoveryControl("reset-restart", "catalog-initial");
    const reserved = await fixture.catalog.beginReset(
      { expectedCatalogGeneration: "catalog-initial" },
      control,
    );
    await fixture.catalog.stop();

    const restarted = await createFixture(
      corruptLog(),
      fixture.root,
      fixture.rootPersistence,
    );
    await restarted.catalog.initialize();
    await restarted.catalog.recover();
    expect(await restarted.catalog.status()).toMatchObject({
      state: "healthy",
      catalogGeneration: reserved.catalogGeneration,
    });
    expect(restarted.published.at(-1)).toEqual([]);
    await restarted.catalog.stop();
  });

  it("coalesces the committed reset and rejects competing reservations", async () => {
    const fixture = await createFixture(corruptLog());
    await fixture.catalog.initialize();
    const control = recoveryControl("reset-shared", "catalog-initial");
    const reservation = await fixture.catalog.beginReset(
      { expectedCatalogGeneration: "catalog-initial" },
      control,
    );
    await expect(
      fixture.catalog.beginReset(
        { expectedCatalogGeneration: "catalog-initial" },
        recoveryControl("reset-competitor", "catalog-initial"),
      ),
    ).rejects.toBeInstanceOf(WorkspaceBindingCatalogConflictError);

    const [first, second] = await Promise.all([
      fixture.catalog.completeReset(
        control.requestId,
        new AbortController().signal,
      ),
      fixture.catalog.completeReset(
        control.requestId,
        new AbortController().signal,
      ),
    ]);
    expect(second).toEqual(first);
    expect(first.catalogGeneration).toBe(reservation.catalogGeneration);
    expect(
      fixture.createdGenerations.filter(
        (generation) => generation === reservation.catalogGeneration,
      ),
    ).toHaveLength(1);
  });

  it("keeps degraded authority intact when reset confirmation or generation is invalid", async () => {
    const fixture = await createFixture(corruptLog());
    await fixture.catalog.initialize();
    await expect(
      fixture.catalog.beginReset(
        { expectedCatalogGeneration: "catalog-other" },
        recoveryControl("reset-wrong-generation", "catalog-initial"),
      ),
    ).rejects.toBeInstanceOf(WorkspaceBindingCatalogConflictError);
    const mismatched = recoveryControl("reset-confirmation", "catalog-initial");
    await expect(
      fixture.catalog.beginReset(
        { expectedCatalogGeneration: "catalog-initial" },
        {
          ...mismatched,
          confirmation: {
            ...mismatched.confirmation,
            requestId: localEnvironmentControlSubject(
              "device-a",
              "another-request",
            ),
          },
        },
      ),
    ).rejects.toThrow("confirmation");
    expect(await fixture.catalog.status()).toMatchObject({
      state: "degraded",
      catalogGeneration: "catalog-initial",
    });
    expect(fixture.published.at(-1)).toEqual([]);
  });

  it("accepts the durable preview confirmation for the full fifteen-minute window", async () => {
    const accepted = await createFixture(corruptLog());
    await accepted.catalog.initialize();
    const withinWindow = recoveryControl("reset-within-window", "catalog-initial");
    await expect(
      accepted.catalog.beginReset(
        { expectedCatalogGeneration: "catalog-initial" },
        {
          ...withinWindow,
          confirmation: {
            ...withinWindow.confirmation,
            issuedAt: new Date(Date.parse(NOW) - 14 * 60_000).toISOString(),
          },
        },
      ),
    ).resolves.toMatchObject({ requestId: withinWindow.requestId });

    const expired = await createFixture(corruptLog());
    await expired.catalog.initialize();
    const outsideWindow = recoveryControl("reset-outside-window", "catalog-initial");
    await expect(
      expired.catalog.beginReset(
        { expectedCatalogGeneration: "catalog-initial" },
        {
          ...outsideWindow,
          confirmation: {
            ...outsideWindow.confirmation,
            issuedAt: new Date(Date.parse(NOW) - 16 * 60_000).toISOString(),
          },
        },
      ),
    ).rejects.toThrow("expired");
  });
});

function corruptLog(): AuthorityCommitLog {
  return {
    async readSnapshot() {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "injected catalog corruption",
      );
    },
  } as unknown as AuthorityCommitLog;
}

async function createFixture(
  initialLog?: AuthorityCommitLog,
  existingRoot?: string,
  rootPersistence = new MemoryWorkspaceBindingCatalogPersistence(),
) {
  const root =
    existingRoot ?? (await createTempDir("zhixing-workspace-catalog"));
  let catalog: WorkspaceBindingCatalog | undefined;
  onTestFinished(() => catalog?.stop());
  const published: CapabilityDescriptor["workspaces"][] = [];
  const createdGenerations: string[] = [];
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const effectiveInitialLog =
    initialLog ??
    new FileAuthorityCommitLog(path.join(root, "initial-log"), artifacts, {
      clock: () => NOW,
    });
  const capacity = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy({
      memoryBytes: 64 * 1024 * 1024,
      temporaryBytes: 64 * 1024 * 1024,
      cpuSlots: 4,
      ioSlots: 4,
      networkSlots: 4,
      readBytesPerSecond: 64 * 1024 * 1024,
      writeBytesPerSecond: 64 * 1024 * 1024,
      ioOperationsPerSecond: 10_000,
      cpuMillisPerSecond: 1_000,
    }),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: Number.MAX_SAFE_INTEGER,
      processRssBytes: 0,
      temporaryBytesAvailable: Number.MAX_SAFE_INTEGER,
    }),
  });
  catalog = new WorkspaceBindingCatalog({
    rootPersistence,
    initialGeneration: {
      log: effectiveInitialLog,
      persistence: generationPersistence(),
    },
    createGeneration: (generation) => {
      createdGenerations.push(generation);
      return {
        log: new FileAuthorityCommitLog(
          path.join(
            root,
            "logs",
            workspaceCatalogGenerationStorageKey(generation),
          ),
          artifacts,
          { clock: () => NOW },
        ),
        persistence: generationPersistence(),
      };
    },
    service: {
      deviceId: "device-a",
      executorId: "executor-a",
      verifier: identity,
      capacity,
      capabilitySnapshot: async (publication) => {
        published.push(
          publication.workspaces.map((workspace) => ({ ...workspace })),
        );
        const revision = (capabilityRevisions.get(root) ?? 0) + 1;
        capabilityRevisions.set(root, revision);
        return descriptor(publication.workspaces, revision);
      },
      versionInventory: async () => inventory(),
      clock: () => NOW,
      bindingRefFactory: () => "workspace-new-generation",
    },
    recoveryRunner: new StorageMaintenanceTaskRunner(),
    clock: () => NOW,
  });
  return { root, catalog, published, createdGenerations, rootPersistence };
}

class MemoryWorkspaceBindingCatalogPersistence
  implements WorkspaceBindingCatalogPersistencePort
{
  conflictNextCommit = false;
  loseNextCommitResponse = false;
  #bytes: string | undefined;
  #snapshotToken: string | undefined;
  #revision = 0;

  constructor(initialBytes?: string) {
    if (initialBytes !== undefined) {
      this.#bytes = initialBytes;
      this.#snapshotToken = this.#nextSnapshotToken();
    }
  }

  async load() {
    return this.#bytes === undefined || this.#snapshotToken === undefined
      ? undefined
      : {
          bytes: this.#bytes,
          snapshotToken: this.#snapshotToken,
        };
  }

  async compareAndSwap(input: {
    readonly expectedSnapshotToken: string | undefined;
    readonly replacementBytes: string;
  }): Promise<WorkspaceBindingCatalogRootCommit> {
    if (this.conflictNextCommit) {
      this.conflictNextCommit = false;
      return { kind: "conflict" };
    }
    if (input.expectedSnapshotToken !== this.#snapshotToken) {
      return { kind: "conflict" };
    }
    this.#bytes = input.replacementBytes;
    this.#snapshotToken = this.#nextSnapshotToken();
    if (this.loseNextCommitResponse) {
      this.loseNextCommitResponse = false;
      throw new Error("injected root commit response loss");
    }
    return {
      kind: "committed",
      snapshotToken: this.#snapshotToken,
    };
  }

  #nextSnapshotToken(): string {
    this.#revision += 1;
    return `memory-root-${this.#revision}`;
  }
}

function generationPersistence(): WorkspaceBindingGenerationPersistencePort {
  let marker = false;
  return {
    async inspectEstablishment() {
      return {
        establishmentMarker: marker ? "present" : "absent",
        authorityLog: "present",
      };
    },
    async publishEstablishment() {
      marker = true;
    },
  };
}

function recoveryControl(requestId: string, catalogGeneration: string) {
  const request = localEnvironmentControlSubject("device-a", requestId);
  return {
    ...adminControl(requestId),
    confirmation: {
      kind: "workspace-binding-reset" as const,
      token: "confirmed-reset-token-0001-with-high-entropy",
      requestId: request,
      catalogGeneration,
      issuedAt: NOW,
    },
  };
}

function adminControl(requestId: string) {
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
    budget: { maxCalls: 8 },
    domain: {
      kind: "local",
      localDomainId: "device-a",
      localGovernorEpoch: 1,
    },
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
    configVersions: {
      runtimeConfigRev: 1,
      modelProfileRev: 1,
      policyRev: 1,
    },
    assetVersions: {
      skillsRev: 1,
      rubricsRev: 1,
      promptAssetsRev: 1,
    },
    permissionSnapshotHighWater: 1,
    credentialBindingRevisions: [],
    at: NOW,
    signature: identity.sign("ExecutorVersionInventory", 1, {}),
  };
}
