import { verifyProtocolStep } from "../protocol/index.js";
import { rethrowUnloadedProtocolIdentity } from "../protocol/verification-identities.js";
import { randomUUID } from "node:crypto";
import type {
  AuthorityCommitLog,
  DurableProjectionReadContext,
  DurableProjectionMutation,
  ProjectionTransactionDecision,
} from "../authority/index.js";
import { AuthorityStorageError, DurableProjectionRecordBindingError } from "../authority/index.js";
import type {
  CommitEnvelope,
  JsonValue,
  EnvironmentPort,
  ImmediateRootResourceLease,
  LogicalRecord,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "../contracts/index.js";
import { defineDurableRuntimeContract } from "../contracts/durable-contract.js";
import {
  canonicalize,
  protocolDigest,
  createSignedEnvironmentControlGrant,
  createSignedWorkspaceProbeResult,
  validateWorkspaceProbeRequest,
  validateWorkspaceProbeResult,
  workspaceProbeRequestDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "../protocol/index.js";
import {
  claimDeviceCapacity,
  runDetachedMaintenanceContext,
  runWithDeviceCapacity,
  type DeviceCapacityArbiterPort,
  type DeviceCapacityBudget,
} from "../resources/index.js";
import {
  runStorageMaintenanceStep,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  StorageMaintenanceTaskRunner,
  type StorageMaintenanceGovernorPort,
} from "../resources/index.js";
import type { WorkspaceProbePersistencePort } from "./workspace-probe-persistence.js";

const PROBE_STREAM = "executor:workspace-probes";
const PROBE_INDEX_ID = "workspace-probe-state-v1";
const PROBE_META = "meta";
const PROBE_COMPLETED = "completed/";
const PROBE_STEP_BUDGET: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 64 * 1024,
    temporaryBytes: 0,
    slots: 1,
  },
  quantum: { readBytes: 16 * 1024, writeBytes: 0, ioOperations: 4 },
};

type WorkspaceProbeRecord =
  | { t: "probe-log-established"; executorId: string }
  | {
      t: "probe-started";
      key: string;
      requestDigest: string;
      at: string;
    }
  | {
      t: "probe-started-v2";
      key: string;
      requestDigest: string;
      request: WorkspaceProbeRequest;
      at: string;
    }
  | {
      t: "probe-completed";
      key: string;
      requestDigest: string;
      result: WorkspaceProbeResult;
      at: string;
    }
  | {
      t: "probe-retired";
      key: string;
      requestDigest: string;
      at: string;
    };

interface ProbeEntry {
  readonly requestDigest: string;
  readonly request?: WorkspaceProbeRequest;
  readonly startedAt: string;
  readonly result?: WorkspaceProbeResult;
  readonly completedAt?: string;
}

interface ProbeProjection {
  established: boolean;
  executorId?: string;
  readonly entries: Map<string, ProbeEntry>;
  completed: readonly {
    readonly key: string;
    readonly completedAt: string;
  }[];
}

export interface WorkspaceProbeHandlerOptions {
  readonly executorId: string;
  readonly environment: EnvironmentPort;
  readonly log: AuthorityCommitLog;
  readonly persistence: WorkspaceProbePersistencePort;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly capacity: DeviceCapacityArbiterPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly clock?: () => string;
}

export interface WorkspaceProbePort {
  probe(
    request: WorkspaceProbeRequest,
    abort?: AbortSignal,
  ): Promise<WorkspaceProbeResult>;
}

export class WorkspaceProbeHandler implements WorkspaceProbePort {
  readonly #executorId: string;
  readonly #environment: EnvironmentPort;
  readonly #log: AuthorityCommitLog;
  readonly #persistence: WorkspaceProbePersistencePort;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #capacity: DeviceCapacityArbiterPort;
  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
  readonly #retentionRunner: StorageMaintenanceTaskRunner;
  readonly #clock: () => string;
  readonly #inFlight = new Map<
    string,
    { requestDigest: string; promise: Promise<WorkspaceProbeResult> }
  >();

  #opening: Promise<void> | undefined;
  #retentionTimer: NodeJS.Timeout | undefined;
  #retentionRunning: Promise<void> | undefined;
  #retentionAbort: AbortController | undefined;

  constructor(options: WorkspaceProbeHandlerOptions) {
    this.#executorId = requireIdentifier(
      options.executorId,
      "Workspace probe executorId",
    );
    this.#environment = options.environment;
    this.#log = options.log;
    this.#persistence = options.persistence;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    registerWorkspaceProbeProjection(options.log, options.verifier);
    this.#capacity = options.capacity;
    this.#storageMaintenance = options.storageMaintenance;
    this.#retentionRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async probe(
    input: WorkspaceProbeRequest,
    abort: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceProbeResult> {
    let request: WorkspaceProbeRequest;
    try {
      request = (await verifyProtocolStep(() => validateWorkspaceProbeRequest(input, this.#verifier, {
        requireActiveAt: false,
      })));
    } catch (error) {
    rethrowUnloadedProtocolIdentity(error);
      throw new WorkspaceProbeRejectedError(
        error instanceof Error ? error.message : "Workspace probe request is invalid",
        { cause: error },
      );
    }
    if (request.resourceLease.audience.executorId !== this.#executorId) {
      throw new WorkspaceProbeRejectedError(
        "Workspace probe resource lease belongs to another executor",
      );
    }
    const key = probeKey(request);
    const requestDigest = workspaceProbeRequestDigest(request);
    await this.#ensureOpen();
    const durable = await this.#entry(key);
    if (durable) {
      if (durable.requestDigest !== requestDigest) {
        throw new WorkspaceProbeConflictError(
          "Workspace probe identity was reused with another payload",
        );
      }
      if (durable.result) return structuredClone(durable.result);
    }
    const current = this.#inFlight.get(key);
    if (current) {
      if (current.requestDigest !== requestDigest) {
        throw new WorkspaceProbeConflictError(
          "Workspace probe identity is active with another payload",
        );
      }
      return current.promise;
    }
    const promise = this.#executeFresh(request, key, requestDigest, abort);
    this.#inFlight.set(key, { requestDigest, promise });
    try {
      return await promise;
    } finally {
      if (this.#inFlight.get(key)?.promise === promise) {
        this.#inFlight.delete(key);
      }
    }
  }

  async compact(completedBefore: string, limit = 64,
    abort: AbortSignal = new AbortController().signal): Promise<number> {
    parseCanonicalTime(completedBefore, "Workspace probe retention cutoff");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
      throw new RangeError("Workspace probe retirement page size must be between 1 and 256");
    }
    await this.#ensureOpen();
    const candidates = await this.#log.transactDurableProjection<never, { key: string; requestDigest: string }[]>(
      PROBE_INDEX_ID, async current => {
        const page = await current.scan({ gte: PROBE_COMPLETED, lt: PROBE_COMPLETED + completedBefore }, limit);
        const values: { key: string; requestDigest: string }[] = [];
        for (const item of page.entries) {
          const row = probeStoredObject(item.value);
          if (Object.keys(row).length !== 3 || typeof row.key !== "string" || typeof row.completedAt !== "string" ||
              typeof row.requestDigest !== "string" || item.key !== probeCompletionKey(row.key, row.completedAt)) throw invalidProbeIndex();
          const state = await readProbeIndex(current, row.key, this.#verifier);
          const entry = state.entries.get(row.key);
          if (!entry?.result || entry.completedAt !== row.completedAt || entry.requestDigest !== row.requestDigest) throw invalidProbeIndex();
          values.push({ key: row.key, requestDigest: row.requestDigest });
        }
        return { kind: "return", value: values };
      });
    let retired = 0;
    for (const candidate of candidates.value) {
      if (abort.aborted) throw abort.reason;
      const transaction = await runStorageMaintenanceStep(this.#storageMaintenance,
        storageMaintenanceRequest("workspace-probe-retirement", workspaceProbeMaintenanceResource(this.#executorId),
          candidate, { obligation: "committed" }),
        () => this.#transact(candidate.key, state => {
          const current = state.entries.get(candidate.key);
          if (!current?.result || current.requestDigest !== candidate.requestDigest) return { kind: "return", value: false };
          return { kind: "append", value: true, entries: [{ stream: PROBE_STREAM, body: {
            t: "probe-retired", key: candidate.key, requestDigest: candidate.requestDigest, at: this.#clock(),
          } }] };
        }));
      if (transaction.value) retired++;
    }
    return retired;
  }

  startRetentionMaintenance(
    options: {
      readonly retentionMs?: number;
      readonly intervalMs?: number;
      readonly onError?: (error: Error) => void;
    } = {},
  ): void {
    if (this.#retentionTimer) return;
    const retentionMs = options.retentionMs ?? 27 * 24 * 60 * 60 * 1_000;
    const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1_000;
    if (
      !Number.isSafeInteger(retentionMs) ||
      retentionMs <= 0 ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs <= 0
    ) {
      throw new RangeError("Workspace probe retention intervals are invalid");
    }
    const run = () => {
      if (this.#retentionRunning) return;
      const controller = new AbortController();
      this.#retentionAbort = controller;
      this.#retentionRunning = runDetachedMaintenanceContext(
        "background",
        () => {
          const cutoff = new Date(
            parseCanonicalTime(
              this.#clock(),
              "Workspace probe retention time",
            ) - retentionMs,
          ).toISOString();
          return this.#retentionRunner.run(
            storageMaintenanceObligation(
              "workspace-probe-retirement",
              workspaceProbeMaintenanceResource(this.#executorId),
              { completedBefore: cutoff },
              {
                owner: "workspace-probe-owner",
                obligation: "committed",
              },
            ),
            controller.signal,
            async (taskAbort) => {
              while ((await this.compact(cutoff, 64, taskAbort)) === 64) {
                // Each page is separately governed and durably advances the index.
              }
            },
          );
        },
      )
        .catch((error: unknown) =>
          options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          ),
        )
        .finally(() => {
          if (this.#retentionAbort === controller) {
            this.#retentionAbort = undefined;
          }
          this.#retentionRunning = undefined;
        });
    };
    this.#retentionTimer = setInterval(run, intervalMs);
    this.#retentionTimer.unref?.();
    run();
  }

  async stopRetentionMaintenance(): Promise<void> {
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#retentionTimer = undefined;
    this.#retentionAbort?.abort(
      new DOMException("Workspace probe retention stopped", "AbortError"),
    );
    await this.#retentionRunning;
    await this.#retentionRunner.stop();
  }

  async #executeFresh(
    request: WorkspaceProbeRequest,
    key: string,
    requestDigest: string,
    abort: AbortSignal,
  ): Promise<WorkspaceProbeResult> {
    try {
      (await verifyProtocolStep(() => validateWorkspaceProbeRequest(request, this.#verifier)));
    } catch (error) {
    rethrowUnloadedProtocolIdentity(error);
      throw new WorkspaceProbeRejectedError(
        error instanceof Error ? error.message : "Workspace probe request is no longer active",
        { cause: error },
      );
    }
    const resolved = await this.#environment.resolveWorkspace(
      request.bindingRef,
    );
    const started = await this.#transact<ProbeEntry | undefined>(key, state => {
      const current = state.entries.get(key);
      if (current) {
        if (current.requestDigest !== requestDigest) throw new WorkspaceProbeConflictError("Workspace probe identity was reused with another payload");
        return { kind: "return", value: current };
      }
      return { kind: "append", entries: [{ stream: PROBE_STREAM, body: {
        t: "probe-started-v2", key, requestDigest, request: structuredClone(request), at: this.#clock(),
      } }], value: undefined };
    });
    if (started.value?.result) return structuredClone(started.value.result);

    const probe = await runWithDeviceCapacity(
      this.#capacity,
      {
        serviceClass: "workload-interactive",
        atomic: PROBE_STEP_BUDGET,
        preferred: PROBE_STEP_BUDGET,
        maxWaitMs: 5_000,
      },
      abort,
      async () => {
        claimDeviceCapacity("readBytes", 4 * 1024);
        claimDeviceCapacity("ioOperations", 2);
        return this.#environment.probePath(resolved.absolutePath);
      },
    );
    const result = createSignedWorkspaceProbeResult(
      {
        v: 1,
        requestId: request.requestId,
        bindingRef: request.bindingRef,
        workspaceBindingRevision: resolved.workspaceBindingRevision,
        probe,
        executorId: this.#executorId,
      },
      this.#signer,
    );
    const completed = await this.#transact<WorkspaceProbeResult>(key, state => {
      const current = state.entries.get(key);
      if (!current || current.requestDigest !== requestDigest) throw new WorkspaceProbeConflictError("Workspace probe lost its durable start record");
      if (current.result) {
        if (canonicalize(current.result) !== canonicalize(result)) throw new WorkspaceProbeConflictError("Workspace probe completed with conflicting results");
        return { kind: "return", value: current.result };
      }
      return { kind: "append", entries: [{ stream: PROBE_STREAM, body: {
        t: "probe-completed", key, requestDigest, result, at: this.#clock(),
      } }], value: result };
    });
    return structuredClone(completed.value);
  }

  #transact<T>(key: string, decide: (state: ProbeProjection) => ProjectionTransactionDecision<WorkspaceProbeRecord, T>) {
    return this.#log.transactDurableProjection<WorkspaceProbeRecord, T>(PROBE_INDEX_ID, async current => {
      const state = await readProbeIndex(current, key, this.#verifier);
      if (!state.established || state.executorId !== this.#executorId) throw corruptProbeLog("Workspace probe log belongs to another executor");
      return decide(state);
    });
  }

  async #entry(key: string): Promise<ProbeEntry | undefined> {
    return (await this.#transact(key, state => ({ kind: "return", value: state.entries.get(key) }))).value;
  }

  async #ensureOpen(): Promise<void> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<void> {
    const persistence = await this.#persistence.inspectEstablishment();
    if ((persistence.establishmentMarker !== "absent" && persistence.establishmentMarker !== "present") ||
        (persistence.authorityLog !== "absent" && persistence.authorityLog !== "present")) {
      throw new AuthorityStorageError("commit-log-corrupt", "Workspace probe persistence observation is invalid");
    }
    const markerExists = persistence.establishmentMarker === "present";
    if (markerExists && persistence.authorityLog === "absent") {
      throw new AuthorityStorageError("commit-log-corrupt", "Established workspace probe log is missing");
    }
    // Absence is established by the index's verified complete source prefix.
    // The reducer refuses any non-genesis record before establishment.
    await this.#log.transactDurableProjection<WorkspaceProbeRecord, void>(PROBE_INDEX_ID, async current => {
      const state = await readProbeIndex(current, undefined, this.#verifier);
      if (state.established) {
        if (state.executorId !== this.#executorId) throw corruptProbeLog("Workspace probe log belongs to another executor");
        return { kind: "return", value: undefined };
      }
      if (markerExists) throw corruptProbeLog("Workspace probe log lacks its establishment fact");
      return { kind: "append", entries: [{ stream: PROBE_STREAM, body: {
        t: "probe-log-established", executorId: this.#executorId,
      } }], value: undefined };
    });
    if (!markerExists) await this.#persistence.publishEstablishment();
  }

}

export interface EnvironmentProbeOwnerOptions {
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly clock?: () => string;
  readonly grantIdFactory?: () => string;
  readonly ttlMs?: number;
}

export class EnvironmentProbeOwner {
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #clock: () => string;
  readonly #grantIdFactory: () => string;
  readonly #ttlMs: number;

  constructor(options: EnvironmentProbeOwnerOptions) {
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#grantIdFactory =
      options.grantIdFactory ?? (() => `env-grant-${randomUUID()}`);
    this.#ttlMs = options.ttlMs ?? 60_000;
  }

  issue(input: {
    requestId: string;
    deviceId: string;
    bindingRef: string;
    executorId: string;
    resourceLease: ImmediateRootResourceLease;
  }): WorkspaceProbeRequest {
    if (input.resourceLease.audience.executorId !== input.executorId) {
      throw new TypeError(
        "Workspace probe lease does not target the selected executor",
      );
    }
    const at = this.#clock();
    const leaseExpiry = Date.parse(input.resourceLease.expiry);
    const expiry = new Date(
      Math.min(leaseExpiry, Date.parse(at) + this.#ttlMs),
    ).toISOString();
    const grant = createSignedEnvironmentControlGrant(
      {
        v: 1,
        grantId: this.#grantIdFactory(),
        deviceId: input.deviceId,
        bindingRef: input.bindingRef,
        methods: ["environment.probe"],
        requestId: input.requestId,
        resourceLeaseDigest: input.resourceLease.digest,
        issuedAt: at,
        expiry,
      },
      this.#signer,
    );
    return validateWorkspaceProbeRequest(
      {
        v: 1,
        requestId: input.requestId,
        deviceId: input.deviceId,
        bindingRef: input.bindingRef,
        grant,
        resourceLease: input.resourceLease,
        at,
      },
      this.#verifier,
    );
  }

  accept(
    request: WorkspaceProbeRequest,
    result: unknown,
    expectedExecutorId: string,
  ): WorkspaceProbeResult {
    const validated = validateWorkspaceProbeResult(result, this.#verifier);
    if (
      validated.requestId !== request.requestId ||
      validated.bindingRef !== request.bindingRef ||
      validated.executorId !== expectedExecutorId
    ) {
      throw new WorkspaceProbeConflictError(
        "Workspace probe result does not bind the issued request",
      );
    }
    return validated;
  }
}

export class LocalWorkspaceProbeAdapter implements WorkspaceProbePort {
  constructor(private readonly handler: WorkspaceProbePort) {}

  probe(
    request: WorkspaceProbeRequest,
    abort?: AbortSignal,
  ): Promise<WorkspaceProbeResult> {
    return this.handler.probe(structuredClone(request), abort);
  }
}

export class MeshWorkspaceProbeAdapter implements WorkspaceProbePort {
  constructor(
    private readonly send: (request: WorkspaceProbeRequest) => Promise<unknown>,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async probe(
    request: WorkspaceProbeRequest,
    _abort?: AbortSignal,
  ): Promise<WorkspaceProbeResult> {
    return validateWorkspaceProbeResult(
      await this.send(structuredClone(request)),
      this.verifier,
    );
  }
}

function probeEntryKey(key: string): string { return "entry/" + protocolDigest("WorkspaceProbeIndexKey", 1, { key }); }
function probeCompletionKey(key: string, completedAt: string): string { return PROBE_COMPLETED + completedAt + "/" + protocolDigest("WorkspaceProbeIndexKey", 1, { key }); }
function invalidProbeIndex(): DurableProjectionRecordBindingError {
  return new DurableProjectionRecordBindingError("Workspace probe derived identity is inconsistent");
}
function probeStoredObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProbeIndex();
  return value;
}

/** One requested identity is decoded with the original codecs and fold.
 * Historical requests/signatures are never materialized to answer this read. */
async function readProbeIndex(current: DurableProjectionReadContext, key: string | undefined,
  verifier: ProtocolSignatureVerifier): Promise<ProbeProjection> {
  let state = emptyProbeProjection();
  const meta = await current.get(PROBE_META);
  if (meta !== undefined) {
    const value = probeStoredObject(meta);
    if (Object.keys(value).length !== 2 || value.established !== true || typeof value.executorId !== "string" ||
        !value.executorId.length) throw invalidProbeIndex();
    state = { ...state, established: true, executorId: value.executorId };
  }
  if (key === undefined) return state;
  const stored = await current.get(probeEntryKey(key));
  if (stored === undefined) return state;
  try {
    const row = probeStoredObject(stored);
    if (Object.keys(row).length !== 3 || row.key !== key || row.executorId !== state.executorId || !state.established) throw invalidProbeIndex();
    const entry = probeStoredObject(row.entry) as unknown as ProbeEntry;
    const start: WorkspaceProbeRecord = entry.request
      ? { t: "probe-started-v2", key, requestDigest: entry.requestDigest, request: entry.request, at: entry.startedAt }
      : { t: "probe-started", key, requestDigest: entry.requestDigest, at: entry.startedAt };
    state = reduceProbeProjection(state, { stream: PROBE_STREAM, body: start }, verifier);
    if (entry.result !== undefined) {
      state = reduceProbeProjection(state, { stream: PROBE_STREAM, body: {
        t: "probe-completed", key, requestDigest: entry.requestDigest, result: entry.result, at: entry.completedAt!,
      } }, verifier);
    }
    if (canonicalize(state.entries.get(key)) !== canonicalize(entry)) throw invalidProbeIndex();
    return state;
  } catch (error) {
    rethrowUnloadedProtocolIdentity(error);
    throw invalidProbeIndex();
  }
}

async function reduceProbeIndex(envelope: CommitEnvelope<JsonValue>, current: DurableProjectionReadContext,
  verifier: ProtocolSignatureVerifier): Promise<readonly DurableProjectionMutation[]> {
  const mutations: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const read: DurableProjectionReadContext = { get: async key => overlay.has(key) ? overlay.get(key) : current.get(key), scan: (...args) => current.scan(...args) };
  const put = (key: string, value: JsonValue): void => { overlay.set(key, value); mutations.push({ kind: "put", key, value }); };
  const remove = (key: string): void => { overlay.set(key, undefined); mutations.push({ kind: "tombstone", key }); };
  for (const logical of envelope.entries) {
    if (logical.stream !== PROBE_STREAM) continue;
    const record = validateProbeRecord(logical.body as unknown as WorkspaceProbeRecord, verifier);
    const key = record.t === "probe-log-established" ? undefined : record.key;
    const prior = await readProbeIndex(read, key, verifier);
    const previous = key === undefined ? undefined : prior.entries.get(key);
    const next = reduceProbeProjection(prior, { stream: PROBE_STREAM, body: record }, verifier);
    put(PROBE_META, { established: next.established, executorId: next.executorId! });
    if (key !== undefined) {
      if (previous?.completedAt) remove(probeCompletionKey(key, previous.completedAt));
      const entry = next.entries.get(key);
      if (entry) {
        put(probeEntryKey(key), { key, executorId: next.executorId!, entry: entry as unknown as JsonValue });
        if (entry.completedAt) put(probeCompletionKey(key, entry.completedAt), { key, completedAt: entry.completedAt, requestDigest: entry.requestDigest });
      } else remove(probeEntryKey(key));
    }
  }
  return mutations;
}

function reduceProbeProjection(
  previous: ProbeProjection,
  entry: LogicalRecord<WorkspaceProbeRecord>,
  verifier: ProtocolSignatureVerifier,
): ProbeProjection {
  const state: ProbeProjection = {
    established: previous.established,
    executorId: previous.executorId,
    entries: new Map(
      [...previous.entries].map(([key, value]) => [
        key,
        {
          ...value,
          ...(value.request ? { request: structuredClone(value.request) } : {}),
          ...(value.result ? { result: structuredClone(value.result) } : {}),
        },
      ]),
    ),
    completed: previous.completed.map((entry) => ({ ...entry })),
  };
  const record = validateProbeRecord(entry.body, verifier);
  if (record.t !== "probe-log-established" && !state.established) {
    throw corruptProbeLog(
      "Workspace probe record appeared before log establishment",
    );
  }
  switch (record.t) {
    case "probe-log-established":
      if (state.established) {
        throw corruptProbeLog("Workspace probe log was established twice");
      }
      state.established = true;
      state.executorId = record.executorId;
      break;
    case "probe-started":
    case "probe-started-v2":
      if (state.entries.has(record.key)) {
        throw corruptProbeLog("Workspace probe start identity was reused");
      }
      if (
        record.t === "probe-started-v2" &&
        record.request.resourceLease.audience.executorId !== state.executorId
      ) {
        throw corruptProbeLog(
          "Workspace probe request targets another executor",
        );
      }
      state.entries.set(record.key, {
        requestDigest: record.requestDigest,
        ...(record.t === "probe-started-v2"
          ? { request: structuredClone(record.request) }
          : {}),
        startedAt: record.at,
      });
      break;
    case "probe-completed": {
      const current = state.entries.get(record.key);
      if (
        !current ||
        current.result ||
        current.requestDigest !== record.requestDigest ||
        Date.parse(record.at) < Date.parse(current.startedAt) ||
        (current.request !== undefined &&
          (record.result.requestId !== current.request.requestId ||
            record.result.bindingRef !== current.request.bindingRef)) ||
        (current.request === undefined &&
          !legacyProbeKeyBindsRequestId(
            record.key,
            record.result.requestId,
          )) ||
        record.result.executorId !== state.executorId
      ) {
        throw corruptProbeLog("Workspace probe completion is inconsistent");
      }
      state.entries.set(record.key, {
        ...current,
        result: structuredClone(record.result),
        completedAt: record.at,
      });
      state.completed = insertProbeCompletion(state.completed, {
        key: record.key,
        completedAt: record.at,
      });
      break;
    }
    case "probe-retired": {
      const current = state.entries.get(record.key);
      if (
        !current?.result ||
        current.requestDigest !== record.requestDigest ||
        current.completedAt === undefined ||
        Date.parse(record.at) < Date.parse(current.completedAt)
      ) {
        throw corruptProbeLog("Workspace probe retirement is inconsistent");
      }
      state.entries.delete(record.key);
      state.completed = state.completed.filter(
        (entry) => entry.key !== record.key,
      );
      break;
    }
  }
  return state;
}

function validateProbeRecord(
  record: WorkspaceProbeRecord,
  verifier: ProtocolSignatureVerifier,
): WorkspaceProbeRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw corruptProbeLog("Workspace probe record is malformed");
  }
  if (record.t === "probe-log-established") {
    assertProbeRecordKeys(
      record,
      ["executorId", "t"],
      "Workspace probe log genesis",
    );
    requireIdentifier(record.executorId, "Workspace probe executorId");
    return record;
  }
  if (
    record.t !== "probe-started" &&
    record.t !== "probe-started-v2" &&
    record.t !== "probe-completed" &&
    record.t !== "probe-retired"
  ) {
    throw corruptProbeLog("Workspace probe record tag is unknown");
  }
  assertProbeRecordKeys(
    record,
    record.t === "probe-started"
      ? ["at", "key", "requestDigest", "t"]
      : record.t === "probe-started-v2"
        ? ["at", "key", "request", "requestDigest", "t"]
        : record.t === "probe-completed"
          ? ["at", "key", "requestDigest", "result", "t"]
          : ["at", "key", "requestDigest", "t"],
    "Workspace probe record",
  );
  requireIdentifier(record.key, "Workspace probe key");
  if (!/^sha256:[0-9a-f]{64}$/u.test(record.requestDigest)) {
    throw corruptProbeLog("Workspace probe request digest is invalid");
  }
  parseCanonicalTime(record.at, "Workspace probe record time");
  if (record.t === "probe-started-v2") {
    let request: WorkspaceProbeRequest;
    try {
      request = validateWorkspaceProbeRequest(record.request, verifier, {
        requireActiveAt: false,
      });
    } catch (error) {
    rethrowUnloadedProtocolIdentity(error);
      throw corruptProbeLog("Workspace probe request is malformed");
    }
    if (
      workspaceProbeRequestDigest(request) !== record.requestDigest ||
      probeKey(request) !== record.key
    ) {
      throw corruptProbeLog("Workspace probe request identity is inconsistent");
    }
  }
  if (record.t === "probe-completed") {
    try {
      validateWorkspaceProbeResult(record.result, verifier);
    } catch (error) {
    rethrowUnloadedProtocolIdentity(error);
      throw corruptProbeLog("Workspace probe result is malformed");
    }
  }
  return record;
}

function assertProbeRecordKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw corruptProbeLog(`${label} fields are invalid`);
  }
}

function emptyProbeProjection(): ProbeProjection {
  return { established: false, entries: new Map(), completed: [] };
}

function insertProbeCompletion(
  entries: readonly { readonly key: string; readonly completedAt: string }[],
  candidate: { readonly key: string; readonly completedAt: string },
): readonly { readonly key: string; readonly completedAt: string }[] {
  const output = [...entries];
  const index = output.findIndex(
    (entry) =>
      entry.completedAt > candidate.completedAt ||
      (entry.completedAt === candidate.completedAt &&
        entry.key.localeCompare(candidate.key, "en-US") > 0),
  );
  if (index < 0) output.push(candidate);
  else output.splice(index, 0, candidate);
  return output;
}

function probeKey(request: WorkspaceProbeRequest): string {
  return `${request.requestId}/${request.grant.grantId}`;
}

function legacyProbeKeyBindsRequestId(
  key: string,
  requestId: string,
): boolean {
  const prefix = `${requestId}/`;
  return key.startsWith(prefix) && key.length > prefix.length;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 480 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function parseCanonicalTime(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return time;
}

function workspaceProbeMaintenanceResource(executorId: string): string {
  return `workspace-probe:${executorId}`;
}

function corruptProbeLog(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

export class WorkspaceProbeConflictError extends Error {
  readonly reasonCode = "WORKSPACE_PROBE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceProbeConflictError";
  }
}

export const WORKSPACE_PROBE_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "workspace-probe",
  producer: "WorkspaceProbeHandler",
  recoveryOwner: "workspace-probe-owner",
  resourceIdentity: "workspace-probe:<requestId>",
  recoveryClass: "authority-replay",
  cases: [
    ...["log-established", "started", "completed", "retired"].map((key) => ({ kind: "variant" as const, key })),
    ...["grant-binding", "lease-binding", "expired-fresh-request"].map((key) => ({ kind: "rejection" as const, key, reasonCode: "WORKSPACE_PROBE_REJECTED" })),
    { kind: "rejection", key: "request-conflict", reasonCode: "WORKSPACE_PROBE_CONFLICT" },
    ...["invalid-result", "request-result-mismatch", "broken-replay-index"].map((key) => ({ kind: "corruption" as const, key, reasonCode: "AUTHORITY_RECORD_INVALID" })),
  ],
} as const);

export class WorkspaceProbeRejectedError extends TypeError {
  readonly reasonCode = "WORKSPACE_PROBE_REJECTED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceProbeRejectedError";
  }
}

export function registerWorkspaceProbeProjection(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier) {
  return log.durableProjection({
      projectionId: PROBE_INDEX_ID, reducerVersion: 1, authenticated: true,
      inputs: { streams: [PROBE_STREAM] },
      reduce: (envelope, current) => reduceProbeIndex(envelope, current, verifier),
    });
}
