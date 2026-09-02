import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore, FileAuthorityCommitLog } from "../authority/index.js";
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
} from "../resources/index.js";
import {
  WorkspaceBindingService,
  localEnvironmentControlSubject,
} from "./workspace-bindings.js";
import {
  EnvironmentProbeOwner,
  LocalWorkspaceProbeAdapter,
  MeshWorkspaceProbeAdapter,
  WorkspaceProbeHandler,
} from "./workspace-probe.js";
import type {
  WorkspaceProbePersistenceObservation,
  WorkspaceProbePersistencePort,
} from "./workspace-probe-persistence.js";

const NOW = "2026-07-30T00:00:00.000Z";
const LATER = "2026-07-30T00:10:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;
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

describe("workspace probe conformance", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it.each([
    "local",
    "mesh",
  ] as const)("%s adapter drives the same signed handler contract", async (adapterKind) => {
    const fixture = await createFixture();
    const port =
      adapterKind === "local"
        ? new LocalWorkspaceProbeAdapter(fixture.handler)
        : new MeshWorkspaceProbeAdapter(
            (request) => fixture.handler.probe(request),
            identity,
          );
    const request = fixture.owner.issue({
      requestId: "probe-1",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-1"),
    });
    await expect(port.probe(request)).resolves.toMatchObject({
      requestId: "probe-1",
      bindingRef: fixture.bindingRef,
      probe: "directory",
      executorId: "executor-a",
    });
  });

  it("single-flights concurrent requests and rejects identity reuse", async () => {
    const fixture = await createFixture();
    const request = fixture.owner.issue({
      requestId: "probe-same",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-same"),
    });
    const probe = vi.spyOn(fixture.bindings, "probePath");
    const [first, second] = await Promise.all([
      fixture.handler.probe(request),
      fixture.handler.probe(structuredClone(request)),
    ]);
    expect(second).toEqual(first);
    expect(probe).toHaveBeenCalledTimes(1);

    const altered = {
      ...request,
      grant: { ...request.grant, grantId: "other-grant" },
    };
    await expect(fixture.handler.probe(altered)).rejects.toThrow();
  });

  it("rebuilds durable replay state and permits exact replay after expiry", async () => {
    const fixture = await createFixture();
    const request = fixture.owner.issue({
      requestId: "probe-replay",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-replay"),
    });
    const first = await fixture.handler.probe(request);
    const restarted = fixture.createHandler(() => LATER);
    await expect(restarted.probe(request)).resolves.toEqual(first);
    expect(fixture.persistence.publicationCount).toBe(1);
  });

  it("fails closed when an establishment marker outlives its authority log", async () => {
    const fixture = await createFixture({
      persistence: new MemoryWorkspaceProbePersistence({
        establishmentMarker: "present",
        authorityLog: "absent",
      }),
    });
    const request = fixture.owner.issue({
      requestId: "probe-missing-log",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-missing-log"),
    });

    await expect(fixture.handler.probe(request)).rejects.toMatchObject({
      name: "AuthorityStorageError",
      code: "commit-log-corrupt",
    });
  });

  it("fails closed when a marker is present without its establishment fact", async () => {
    const fixture = await createFixture({
      persistence: new MemoryWorkspaceProbePersistence({
        establishmentMarker: "present",
        authorityLog: "present",
      }),
    });
    const request = fixture.owner.issue({
      requestId: "probe-missing-fact",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-missing-fact"),
    });

    await expect(fixture.handler.probe(request)).rejects.toMatchObject({
      name: "AuthorityStorageError",
      code: "invalid-authority-record",
    });
  });

  it("re-publishes a missing marker from the durable establishment fact", async () => {
    const fixture = await createFixture();
    const request = fixture.owner.issue({
      requestId: "probe-republish-marker",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-republish-marker"),
    });
    const first = await fixture.handler.probe(request);
    fixture.persistence.removeMarker();

    await expect(fixture.createHandler().probe(request)).resolves.toEqual(first);
    expect(fixture.persistence.publicationCount).toBe(2);
  });

  it("recovers when marker publication fails after the establishment fact", async () => {
    const persistence = new MemoryWorkspaceProbePersistence();
    persistence.failNextPublication();
    const fixture = await createFixture({ persistence });
    const request = fixture.owner.issue({
      requestId: "probe-marker-response-loss",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-marker-response-loss"),
    });

    await expect(fixture.handler.probe(request)).rejects.toThrow(
      "marker publication failed",
    );
    await expect(fixture.createHandler().probe(request)).resolves.toMatchObject({
      requestId: "probe-marker-response-loss",
    });
    expect(persistence.publicationCount).toBe(1);
  });

  it("retires completed replay entries without mutating binding revision", async () => {
    const fixture = await createFixture();
    const request = fixture.owner.issue({
      requestId: "probe-retire",
      deviceId: "device-a",
      bindingRef: fixture.bindingRef,
      executorId: "executor-a",
      resourceLease: probeLease("probe-retire"),
    });
    const before = await fixture.bindings.resolveWorkspace(fixture.bindingRef);
    await fixture.handler.probe(request);
    await expect(
      fixture.handler.compact("2026-07-30T00:01:00.000Z"),
    ).resolves.toBe(1);
    expect(await fixture.bindings.resolveWorkspace(fixture.bindingRef)).toEqual(
      before,
    );
  });
});

async function createFixture(
  options: { readonly persistence?: MemoryWorkspaceProbePersistence } = {},
) {
  const root = await tempRoot();
  const logs = new Set<FileAuthorityCommitLog>();
  onTestFinished(async () => {
    const settled = await Promise.allSettled(
      [...logs].map((log) => log.stopStorageMaintenance()),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  const trackLog = (log: FileAuthorityCommitLog): FileAuthorityCommitLog => {
    logs.add(log);
    return log;
  };
  const capacity = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: Number.MAX_SAFE_INTEGER,
      processRssBytes: 0,
      temporaryBytesAvailable: Number.MAX_SAFE_INTEGER,
    }),
  });
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const bindingLog = trackLog(new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    artifacts,
    { clock: () => NOW },
  ));
  const bindings = new WorkspaceBindingService({
    rootDir: path.join(root, "binding-state"),
    catalogGeneration: "catalog-initial",
    deviceId: "device-a",
    executorId: "executor-a",
    log: bindingLog,
    verifier: identity,
    capacity,
    capabilitySnapshot: async (publication) =>
      descriptor(publication.workspaces),
    versionInventory: async () => inventory(),
    clock: () => NOW,
    bindingRefFactory: () => "workspace-a",
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const binding = await bindings.create(
    { displayName: "Workspace", absolutePath: workspace },
    localControl("binding-create"),
  );
  const probeLog = trackLog(new FileAuthorityCommitLog(
    path.join(root, "probe-log"),
    artifacts,
    { clock: () => NOW },
  ));
  const persistence = options.persistence ?? new MemoryWorkspaceProbePersistence();
  const createHandler = (clock: () => string = () => NOW) =>
    new WorkspaceProbeHandler({
      executorId: "executor-a",
      environment: bindings,
      log: probeLog,
      persistence,
      signer: identity,
      verifier: identity,
      capacity,
      clock,
    });
  return {
    bindings,
    bindingRef: binding.bindingRef,
    handler: createHandler(),
    createHandler,
    persistence,
    owner: new EnvironmentProbeOwner({
      signer: identity,
      verifier: identity,
      clock: () => NOW,
      grantIdFactory: () => "grant-a",
      ttlMs: 60_000,
    }),
  };
}

class MemoryWorkspaceProbePersistence
  implements WorkspaceProbePersistencePort
{
  #observation: WorkspaceProbePersistenceObservation;
  #failNextPublication = false;
  publicationCount = 0;

  constructor(
    observation: WorkspaceProbePersistenceObservation = {
      establishmentMarker: "absent",
      authorityLog: "present",
    },
  ) {
    this.#observation = observation;
  }

  async inspectEstablishment(): Promise<WorkspaceProbePersistenceObservation> {
    return this.#observation;
  }

  async publishEstablishment(): Promise<void> {
    if (this.#failNextPublication) {
      this.#failNextPublication = false;
      throw new Error("marker publication failed");
    }
    this.#observation = {
      establishmentMarker: "present",
      authorityLog: "present",
    };
    this.publicationCount += 1;
  }

  removeMarker(): void {
    this.#observation = {
      establishmentMarker: "absent",
      authorityLog: this.#observation.authorityLog,
    };
  }

  failNextPublication(): void {
    this.#failNextPublication = true;
  }
}

function localControl(requestId: string) {
  const scopedRequestId = localEnvironmentControlSubject("device-a", requestId);
  return {
    requestId: scopedRequestId,
    lease: lease(scopedRequestId, scopedRequestId, "executor-a"),
    abort: new AbortController().signal,
  };
}

function probeLease(requestId: string): ImmediateRootResourceLease {
  return lease(requestId, requestId, "executor-a");
}

function lease(
  requestId: string,
  subject: string,
  executorId: string,
): ImmediateRootResourceLease {
  const payload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: `reservation-${requestId}`,
    admissionClass: "interactive",
    workload: { kind: "control", id: requestId, attempt: 1 },
    scopeBinding: { kind: "control", subject },
    audience: { executorId },
    budget: { maxCalls: 1 },
    domain: { kind: "local", localDomainId: "device-a", localGovernorEpoch: 1 },
    issuedAt: NOW,
    expiry: "2026-07-30T00:05:00.000Z",
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

async function tempRoot(): Promise<string> {
  return createTempDir("workspace-probe");
}
