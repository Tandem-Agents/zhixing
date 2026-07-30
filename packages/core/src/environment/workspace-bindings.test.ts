import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "../authority/index.js";
import type {
  CapabilityDescriptor,
  ExecutorVersionInventory,
  ImmediateRootResourceLease,
  ResourceLease,
} from "../contracts/index.js";
import { protocolDigest } from "../protocol/index.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "../protocol/index.js";
import {
  DefaultDeviceCapacityArbiter,
  StorageMaintenanceTaskRunner,
  createDefaultDeviceCapacityPolicy,
} from "../resources/index.js";
import {
  WorkspaceBindingConflictError,
  WorkspaceBindingNotFoundError,
  WorkspaceBindingService,
  WorkspaceBindingRevisionError,
  localEnvironmentControlSubject,
} from "./workspace-bindings.js";

const NOW = "2026-07-30T00:00:00.000Z";
const EXPIRY = "2026-07-30T01:00:00.000Z";
const roots: string[] = [];

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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkspaceBindingService", () => {
  it("owns CRUD, CAS, name uniqueness and execution revisions in one log", async () => {
    const service = await createService();
    const created = await service.create(
      { displayName: "Project", absolutePath: path.resolve("project-a") },
      control("create-1"),
    );
    expect(created).toMatchObject({
      revision: 1,
      workspaceBindingRevision: 1,
      displayName: "Project",
    });
    await expect(
      service.create(
        { displayName: "project", absolutePath: path.resolve("project-b") },
        control("create-2"),
      ),
    ).rejects.toBeInstanceOf(WorkspaceBindingConflictError);

    const renamed = await service.update(
      created.bindingRef,
      { displayName: "Project Renamed" },
      1,
      control("rename-1"),
    );
    expect(renamed).toMatchObject({
      revision: 2,
      workspaceBindingRevision: 1,
    });
    const moved = await service.update(
      created.bindingRef,
      { absolutePath: path.resolve("project-b") },
      2,
      control("move-1"),
    );
    expect(moved).toMatchObject({
      revision: 3,
      workspaceBindingRevision: 2,
    });
    await expect(
      service.update(
        created.bindingRef,
        { displayName: "stale" },
        1,
        control("stale-1"),
      ),
    ).rejects.toBeInstanceOf(WorkspaceBindingRevisionError);
    expect(await service.resolveWorkspace(created.bindingRef)).toEqual({
      absolutePath: path.resolve("project-b"),
      workspaceBindingRevision: 2,
    });
  });

  it("replays requests exactly and never reuses tombstoned refs", async () => {
    const root = await tempRoot();
    const refs = ["workspace-fixed", "workspace-fixed", "workspace-next"];
    const service = createServiceAt(root, () => refs.shift()!);
    const first = await service.create(
      { displayName: "One", absolutePath: path.resolve("one") },
      control("same-request"),
    );
    expect(
      await service.create(
        { displayName: "One", absolutePath: path.resolve("one") },
        control("same-request"),
      ),
    ).toEqual(first);
    await expect(
      service.create(
        { displayName: "Other", absolutePath: path.resolve("other") },
        control("same-request"),
      ),
    ).rejects.toBeInstanceOf(WorkspaceBindingConflictError);
    await service.remove(
      first.bindingRef,
      first.revision,
      control("remove-1"),
    );
    await expect(
      service.resolveWorkspace(first.bindingRef),
    ).rejects.toBeInstanceOf(WorkspaceBindingNotFoundError);
    const second = await service.create(
      { displayName: "Two", absolutePath: path.resolve("two") },
      control("create-2"),
    );
    expect(second.bindingRef).toBe("workspace-next");
  });

  it("durably remembers no-op request outcomes after the binding changes", async () => {
    const service = await createService();
    const first = await service.create(
      { displayName: "One", absolutePath: path.resolve("one") },
      control("create-1"),
    );
    const reused = await service.create(
      { displayName: "One", absolutePath: path.resolve("one") },
      control("create-reuse"),
    );
    await service.update(
      first.bindingRef,
      { displayName: "Renamed" },
      first.revision,
      control("rename-1"),
    );
    expect(
      await service.create(
        { displayName: "One", absolutePath: path.resolve("one") },
        control("create-reuse"),
      ),
    ).toEqual(reused);
  });

  it("rebuilds its projection after restart and publishes path-free capability", async () => {
    const root = await tempRoot();
    const first = createServiceAt(root);
    const binding = await first.create(
      { displayName: "Project", absolutePath: path.resolve("private-project") },
      control("create-1"),
    );
    const restarted = createServiceAt(root);
    expect(await restarted.list(control("list-1"))).toEqual([binding]);
    const descriptor = await restarted.capabilitySnapshot();
    expect(descriptor.workspaces).toEqual([
      {
        bindingRef: binding.bindingRef,
        displayName: "Project",
        workspaceBindingRevision: 1,
      },
    ]);
    expect(JSON.stringify(descriptor)).not.toContain("private-project");
  });

  it("imports legacy paths idempotently through the same reducer", async () => {
    const service = await createService();
    const abort = new AbortController().signal;
    const first = await service.importLegacy(
      {
        migrationId: "migration-1",
        sourceSnapshotToken: "snapshot-token-1",
        displayName: "Legacy",
        absolutePath: path.resolve("legacy"),
      },
      abort,
    );
    expect(
      await service.importLegacy(
        {
          migrationId: "migration-1",
          sourceSnapshotToken: "snapshot-token-1",
          displayName: "Legacy",
          absolutePath: path.resolve("legacy"),
        },
        abort,
      ),
    ).toEqual(first);
    expect(await service.list(control("list-before-activation"))).toEqual([]);
    await service.activateLegacy(
      {
        migrationId: "migration-1",
        sourceSnapshotToken: "snapshot-token-1",
      },
      abort,
    );
    expect(await service.list(control("list-after-activation"))).toEqual([
      first,
    ]);
  });

  it("abandons staged legacy imports without publishing them or reviving the batch", async () => {
    const service = await createService();
    const abort = new AbortController().signal;
    await service.importLegacy(
      {
        migrationId: "migration-abandoned",
        sourceSnapshotToken: "snapshot-token-abandoned",
        displayName: "Legacy",
        absolutePath: path.resolve("legacy"),
      },
      abort,
    );
    await service.abandonLegacy(
      {
        migrationId: "migration-abandoned",
        sourceSnapshotToken: "snapshot-token-abandoned",
        reason: "source changed",
      },
      abort,
    );
    expect(await service.list(control("list-after-abandon"))).toEqual([]);
    await expect(
      service.importLegacy(
        {
          migrationId: "migration-abandoned",
          sourceSnapshotToken: "snapshot-token-abandoned",
          displayName: "Legacy",
          absolutePath: path.resolve("legacy"),
        },
        abort,
      ),
    ).rejects.toThrow("cannot be revived");
  });
});

async function createService(): Promise<WorkspaceBindingService> {
  return createServiceAt(await tempRoot());
}

function createServiceAt(
  root: string,
  bindingRefFactory?: () => string,
): WorkspaceBindingService {
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    artifacts,
    { clock: () => NOW },
  );
  const capacity = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: Number.MAX_SAFE_INTEGER,
      processRssBytes: 0,
      temporaryBytesAvailable: Number.MAX_SAFE_INTEGER,
    }),
  });
  return new WorkspaceBindingService({
    rootDir: path.join(root, "binding-state"),
    deviceId: "device-a",
    executorId: "executor-a",
    log,
    verifier: identity,
    capacity,
    migrationRunner: new StorageMaintenanceTaskRunner(),
    capabilitySnapshot: async (workspaces) =>
      descriptor(workspaces),
    versionInventory: async () => inventory(),
    clock: () => NOW,
    ...(bindingRefFactory ? { bindingRefFactory } : {}),
  });
}

function descriptor(
  workspaces: CapabilityDescriptor["workspaces"],
): CapabilityDescriptor {
  return {
    v: 1,
    executorId: "executor-a",
    revision: 1,
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
    assetVersions: { skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1 },
    permissionSnapshotHighWater: 1,
    credentialBindingRevisions: [],
    at: NOW,
    signature: identity.sign("ExecutorVersionInventory", 1, {}),
  };
}

function control(requestId: string) {
  const scopedRequestId = localEnvironmentControlSubject("device-a", requestId);
  return {
    requestId: scopedRequestId,
    lease: immediateLease(scopedRequestId),
    abort: new AbortController().signal,
  };
}

function immediateLease(requestId: string): ImmediateRootResourceLease {
  const payload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: `reservation-${requestId}`,
    admissionClass: "interactive",
    workload: { kind: "control", id: requestId, attempt: 1 },
    scopeBinding: {
      kind: "control",
      subject: requestId,
    },
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-binding-"));
  roots.push(root);
  return root;
}
