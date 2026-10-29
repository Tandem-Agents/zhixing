import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { createTempDir, captureFileIo } from "@zhixing/test-utils";
import { AuthorityCacheIntegrity } from "../authority/startup-proofs.js";
import { observeProjectionQueryWork } from "../test-support/projection-query-work.js";
import { projectionReadCapacity } from "../../../cli/src/serve/artifact-read-capacity.js";
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
  DefaultStorageMaintenanceGovernor,
  currentDeviceCapacityStep,
  createDefaultDeviceCapacityPolicy,
} from "../resources/index.js";
import {
  WorkspaceBindingConflictError,
  WorkspaceBindingNotFoundError,
  WorkspaceBindingService,
  WorkspaceBindingRevisionError,
  localEnvironmentControlSubject,
} from "./workspace-bindings.js";
import type { WorkspaceBindingGenerationPersistencePort } from "./workspace-binding-generation-persistence.js";

const NOW = "2026-07-30T00:00:00.000Z";
const EXPIRY = "2026-07-30T01:00:00.000Z";
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

describe("WorkspaceBindingService", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("publishes the generation marker only after its Authority fact and recovers response loss", async () => {
    const root = await tempRoot();
    const state = {
      marker: false,
      authorityLog: true,
      publishAttempts: 0,
    };
    const persistence = generationPersistence(state, true);
    await expect(
      createServiceAt(root, undefined, persistence).list(
        control("establish-response-lost"),
      ),
    ).rejects.toThrow("injected marker response loss");
    expect(state.marker).toBe(true);

    const restarted = createServiceAt(root, undefined, persistence);
    await expect(
      restarted.list(control("establish-replay")),
    ).resolves.toEqual([]);
    expect(state).toMatchObject({ marker: true, publishAttempts: 1 });
  });

  it("fails closed when marker, WAL presence and establishment fact disagree", async () => {
    const missingLog = generationPersistence({
      marker: true,
      authorityLog: false,
      publishAttempts: 0,
    });
    await expect(
      createServiceAt(await tempRoot(), undefined, missingLog).initialize(),
    ).rejects.toThrow("log is missing");

    const missingFact = generationPersistence({
      marker: true,
      authorityLog: true,
      publishAttempts: 0,
    });
    await expect(
      createServiceAt(await tempRoot(), undefined, missingFact).initialize(),
    ).rejects.toThrow("lacks its establishment fact");
  });

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
    await service.remove(first.bindingRef, first.revision, control("remove-1"));
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

  it.each([
    {
      name: "unknown record tag",
      body: { t: "unknown-workspace-record" },
    },
    {
      name: "extra durable field",
      body: {
        t: "directory-established",
        deviceId: "device-a",
        unexpected: true,
      },
    },
    {
      name: "request digest mismatch",
      body: corruptCreateRecord({
        requestDigest: protocolDigest("WorkspaceBindingCreate", 1, {
          displayName: "Different",
          absolutePath: path.resolve("different"),
        }),
      }),
    },
    {
      name: "result contradicts its request",
      body: corruptCreateRecord({
        binding: {
          bindingRef: "workspace-corrupt",
          revision: 1,
          displayName: "Different",
          absolutePath: path.resolve("corrupt"),
          workspaceBindingRevision: 1,
        },
      }),
    },
  ])("fails closed when recovery sees $name", async ({ body }) => {
    const root = await tempRoot();
    const service = createServiceAt(root);
    await service.list(control("establish-directory"));
    await appendRawRecord(root, body);

    const restarted = createServiceAt(root);
    await expect(
      restarted.list(control("rebuild-after-corruption")),
    ).rejects.toThrow();
  });
});

async function createService(): Promise<WorkspaceBindingService> {
  return createServiceAt(await tempRoot());
}

function createServiceAt(
  root: string,
  bindingRefFactory?: () => string,
  persistence: WorkspaceBindingGenerationPersistencePort =
    generationPersistence({
      marker: false,
      authorityLog: true,
      publishAttempts: 0,
    }),
  logOverride?: FileAuthorityCommitLog,
  capacityOverride?: DefaultDeviceCapacityArbiter,
): WorkspaceBindingService {
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = logOverride ?? new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    artifacts,
    { clock: () => NOW },
  );
  onTestFinished(() => log.stopStorageMaintenance());
  const capacity = capacityOverride ?? new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: Number.MAX_SAFE_INTEGER,
      processRssBytes: 0,
      temporaryBytesAvailable: Number.MAX_SAFE_INTEGER,
    }),
  });
  return new WorkspaceBindingService({
    catalogGeneration: "catalog-initial",
    deviceId: "device-a",
    executorId: "executor-a",
    log,
    persistence,
    verifier: identity,
    capacity,
    capabilitySnapshot: async (publication) =>
      descriptor(publication.workspaces),
    versionInventory: async () => inventory(),
    clock: () => NOW,
    ...(bindingRefFactory ? { bindingRefFactory } : {}),
  });
}

function generationPersistence(
  state: {
    marker: boolean;
    authorityLog: boolean;
    publishAttempts: number;
  },
  loseFirstPublishResponse = false,
): WorkspaceBindingGenerationPersistencePort {
  return {
    async inspectEstablishment() {
      return {
        establishmentMarker: state.marker ? "present" : "absent",
        authorityLog: state.authorityLog ? "present" : "absent",
      };
    },
    async publishEstablishment() {
      state.publishAttempts += 1;
      state.marker = true;
      if (loseFirstPublishResponse && state.publishAttempts === 1) {
        throw new Error("injected marker response loss");
      }
    },
  };
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
  return createTempDir("workspace-binding");
}

async function appendRawRecord(root: string, body: unknown): Promise<void> {
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    artifacts,
    { clock: () => NOW },
  );
  onTestFinished(() => log.stopStorageMaintenance());
  await log.append([
    {
      stream: "executor:workspace-bindings",
      body,
    },
  ]);
}

function corruptCreateRecord(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const request = {
    kind: "create",
    displayName: "Project",
    absolutePath: path.resolve("corrupt"),
  };
  return {
    t: "binding-created",
    requestId: localEnvironmentControlSubject("device-a", "corrupt-record"),
    requestDigest: protocolDigest("WorkspaceBindingCreate", 1, {
      displayName: request.displayName,
      absolutePath: request.absolutePath,
    }),
    request,
    binding: {
      bindingRef: "workspace-corrupt",
      revision: 1,
      displayName: request.displayName,
      absolutePath: request.absolutePath,
      workspaceBindingRevision: 1,
    },
    ...overrides,
  };
}

it.each([false, true])('keeps cold binding reads and materialization fixed across 8/32/128 ended bindings (new write: %s)', async newWrite => {
  const rows = [];
  for (const history of [8, 32, 128]) {
    const root = await tempRoot(), integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 101));
    const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
    const capacity = new DefaultDeviceCapacityArbiter({ policy: createDefaultDeviceCapacityPolicy(), probe: () => ({
      cpuBusyRatio: 0, availableMemoryBytes: Number.MAX_SAFE_INTEGER, processRssBytes: 0, temporaryBytesAvailable: Number.MAX_SAFE_INTEGER,
    }) });
    const storageMaintenance = new DefaultStorageMaintenanceGovernor({ capacity });
    // Match the production setup-delivery generation: one arbiter, physical
    // projection read leaves, maintenance, integrity and startup proofs.
    const open = () => new FileAuthorityCommitLog(path.join(root, 'binding-log'), artifacts, { clock: () => NOW, integrity,
      storageMaintenance, startupProofs: true, runProjectionReadStep: projectionReadCapacity(capacity) });
    const step = async <T>(phase: string, operation: () => Promise<T>) => {
      try { return await operation(); } catch (error) {
        console.log('G16-binding-failure ' + JSON.stringify({ history, phase, violation: capacity.snapshot().lastViolation })); throw error;
      }
    };
    const persistence = generationPersistence({ marker: false, authorityLog: true, publishAttempts: 0 });
    const warm = open(); let nextRef = 0;
    const service = createServiceAt(root, () => `binding-${nextRef++}`, persistence, warm, capacity);
    const currentInput = { displayName: 'Current', absolutePath: path.join(root, 'current') };
    const current = await step('warm-current', () => service.create(currentInput, control('current')));
    let oldInput: { displayName: string; absolutePath: string } | undefined, oldBinding: typeof current | undefined;
    for (let index = 0; index < history; index++) {
      const input = { displayName: `Old ${index}`, absolutePath: path.join(root, `old-${index}`) };
      const binding = await step(`warm-create-${index}`, () => service.create(input, control(`create-old-${index}`)));
      await step(`warm-remove-${index}`, () => service.remove(binding.bindingRef, binding.revision, control(`remove-old-${index}`)));
      if (index === 0) { oldInput = input; oldBinding = binding; }
    }
    const head = await warm.checkpoint(); await warm.stopStorageMaintenance();
    const io = await captureFileIo(root), cold = open(), work = observeProjectionQueryWork(cold);
    const restarted = createServiceAt(root, undefined, persistence, cold, capacity);
    try {
      expect(await step('cold-resolve', () => restarted.resolveWorkspace(current.bindingRef))).toEqual({ absolutePath: currentInput.absolutePath, workspaceBindingRevision: 1 });
      expect((await step('cold-list', () => restarted.list(control('current-list')))).map(item => item.bindingRef)).toEqual([current.bindingRef]);
      if (newWrite) expect(await step('cold-new-create', () => restarted.create({ displayName: 'New', absolutePath: path.join(root, 'new') }, control('new-request'))))
        .toMatchObject({ displayName: 'New', workspaceBindingRevision: 1 });
      else expect(await step('cold-request-replay', () => restarted.create(oldInput!, control('create-old-0')))).toEqual(oldBinding);
      expect((await cold.checkpoint()).lsn).toBe(head.lsn + Number(newWrite));
      const query = io.snapshot(), materialized = work.snapshot(); work.restore();
      await cold.stopStorageMaintenance(); const stopped = io.snapshot();
      rows.push({ history, materialized, cold: { reads: query.reads, bytes: query.readBytes, writes: query.writeBytes,
        logBytes: query.byCategory.log?.readBytes ?? 0, probes: query.segmentEntryProbes },
        stop: { reads: stopped.readBytes - query.readBytes, writes: stopped.writeBytes - query.writeBytes } });
    } finally { work.restore(); await cold.stopStorageMaintenance(); }
  }
  console.log('G16-binding ' + JSON.stringify({ newWrite, rows }));
  for (const row of rows.slice(1)) {
    expect({ ...row.materialized, valueBytes: 0 }).toEqual({ ...rows[0]!.materialized, valueBytes: 0 });
    expect(Math.abs(row.materialized.valueBytes - rows[0]!.materialized.valueBytes)).toBeLessThanOrEqual(1024);
  }
}, 180_000);




async function budgetedBindingFixture(legacy = false) {
  const root = await tempRoot(), integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 104));
  if (legacy) { await mkdir(path.join(root, 'binding-log'), { recursive: true }); await writeFile(path.join(root, 'binding-log/authority.log'), Buffer.alloc(0)); }
  const defaults = createDefaultDeviceCapacityPolicy(); let availableMemory = 8 * 1024 ** 3;
  const capacity = new DefaultDeviceCapacityArbiter({ policy: { ...defaults, occupancy: { ...defaults.occupancy,
    slots: 1, memorySafetyReserveBytes: 0, temporarySafetyReserveBytes: 0 } },
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: availableMemory, processRssBytes: 0, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
  const storageMaintenance = new DefaultStorageMaintenanceGovernor({ capacity }), leaf = projectionReadCapacity(capacity)!;
  const trace = { attempted: 0, executed: 0 };
  const open = () => new FileAuthorityCommitLog(path.join(root, 'binding-log'), new FileArtifactStore(path.join(root, 'artifacts')), {
    integrity, startupProofs: true, storageMaintenance, clock: () => NOW,
    runProjectionReadStep: (step, operation) => {
      const owner = currentDeviceCapacityStep(), admin = owner?.kind === 'workload' && owner.separateReadAdmission === true;
      if (admin) trace.attempted++;
      return leaf(step, () => { if (admin) trace.executed++; return operation(); });
    },
  });
  const persistence = generationPersistence({ marker: false, authorityLog: true, publishAttempts: 0 }); let nextRef = 0;
  const make = (log: FileAuthorityCommitLog) => createServiceAt(root, () => `owned-${nextRef++}`, persistence, log, capacity);
  const log = open(), service = make(log);
  return { root, log, service, capacity, trace,
    setMemory(bytes = 8 * 1024 ** 3) { availableMemory = bytes; },
    async reopen() { await log.stopStorageMaintenance(); const cold = open(); return { log: cold, service: make(cold) }; },
  };
}

describe('workspace admin separately metered reads', () => {
  it.each([false, true])('keeps initialization, cold replay and CRUD under the original write budget (legacy: %s)', async legacy => {
    const h = await budgetedBindingFixture(legacy);
    const input = { displayName: 'Current', absolutePath: path.join(h.root, 'current') };
    const created = await h.service.create(input, control('original'));
    const cold = await h.reopen(), before = await cold.log.checkpoint();
    expect(await cold.service.create(input, control('original'))).toEqual(created);
    expect((await cold.log.checkpoint()).lsn).toBe(before.lsn);
    const updated = await cold.service.update(created.bindingRef, { displayName: 'Renamed' }, created.revision, control('rename'));
    await cold.service.remove(created.bindingRef, updated.revision, control('remove'));
    expect(await cold.service.list(control('list'))).toEqual([]);
    expect(await cold.service.create(input, control('original'))).toEqual(created);
    expect((await cold.log.checkpoint()).lsn).toBe(before.lsn + 2);
    expect(h.trace.executed).toBeGreaterThan(0); expect(h.capacity.snapshot().lastViolation).toBeUndefined();
    expect(h.capacity.snapshot().occupancyInUse.slots).toBe(0);
  });

  it.each(['pressure', 'cancel'] as const)('keeps WAL unchanged when an admitted admin read meets %s and then retries exactly', async reason => {
    const h = await budgetedBindingFixture();
    await h.service.create({ displayName: 'Existing', absolutePath: path.join(h.root, 'existing') }, control('existing'));
    const cold = await h.reopen(); await cold.service.initialize();
    const before = await cold.log.checkpoint(), baseline = { ...h.trace }, cancellation = new AbortController();
    const request = { ...control('retryable'), abort: cancellation.signal };
    const input = { displayName: 'New', absolutePath: path.join(h.root, 'new') };
    const acquire = h.capacity.acquire.bind(h.capacity);
    const refusal = vi.spyOn(h.capacity, 'acquire').mockImplementation((entry, signal) => {
      const owner = currentDeviceCapacityStep();
      if (entry.admissionId.startsWith('projection-read:') && owner?.kind === 'workload' && owner.separateReadAdmission) {
        expect(entry.maxWaitMs).toBe(0);
        if (reason === 'pressure') h.setMemory(0); else cancellation.abort();
      }
      return acquire(entry, signal);
    });
    try {
      await expect(cold.service.create(input, request)).rejects.toMatchObject({ name: 'StorageMaintenanceAdmissionError' });
      expect(h.trace.attempted).toBeGreaterThan(baseline.attempted);
      expect(h.trace.executed).toBe(baseline.executed);
    } finally { refusal.mockRestore(); h.setMemory(); }
    expect((await cold.log.checkpoint()).lsn).toBe(before.lsn);
    expect(h.capacity.snapshot().occupancyInUse.slots).toBe(0);
    const retried = await cold.service.create(input, control('retryable'));
    expect((await cold.log.checkpoint()).lsn).toBe(before.lsn + 1);
    expect(await cold.service.create(input, control('retryable'))).toEqual(retried);
    expect((await cold.log.checkpoint()).lsn).toBe(before.lsn + 1);
    expect(h.capacity.snapshot().lastViolation).toBeUndefined();
  });

  it('recovers a lost post-commit response after a cold restart without a second append', async () => {
    const h = await budgetedBindingFixture(); await h.service.initialize();
    const before = await h.log.checkpoint(), original = h.log.transactDurableProjection.bind(h.log);
    const request = control('reply-lost'), input = { displayName: 'Once', absolutePath: path.join(h.root, 'once') };
    let lost = false;
    const response = vi.spyOn(h.log, 'transactDurableProjection').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!lost && result.commit?.entries.some(entry => (entry.body as { requestId?: unknown })?.requestId === request.requestId)) {
        lost = true; throw Error('synthetic post-commit response loss');
      }
      return result;
    });
    try { await expect(h.service.create(input, request)).rejects.toThrow('post-commit response loss'); }
    finally { response.mockRestore(); }
    expect(lost).toBe(true); expect((await h.log.checkpoint()).lsn).toBe(before.lsn + 1);
    const cold = await h.reopen(), replayed = await cold.service.create(input, control('reply-lost'));
    expect(replayed).toMatchObject({ bindingRef: 'owned-0', revision: 1, displayName: 'Once' });
    expect((await cold.log.checkpoint()).lsn).toBe(before.lsn + 1);
    expect(await cold.service.list(control('list-once'))).toEqual([replayed]);
    expect(h.capacity.snapshot().lastViolation).toBeUndefined();
  });
});
