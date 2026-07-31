import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AuthorityCommitLog,
  ProjectionCursor,
} from "../authority/index.js";
import { AuthorityStorageError } from "../authority/index.js";
import type {
  EnvironmentPort,
  ImmediateRootResourceLease,
  LogicalRecord,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "../contracts/index.js";
import { defineDurableRuntimeContract } from "../contracts/durable-contract.js";
import { ensureDurableDirectory, syncDirectory } from "../persistence/index.js";
import {
  canonicalize,
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

const PROBE_STREAM = "executor:workspace-probes";
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
  readonly rootDir: string;
  readonly executorId: string;
  readonly environment: EnvironmentPort;
  readonly log: AuthorityCommitLog;
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
  readonly #rootDir: string;
  readonly #markerPath: string;
  readonly #executorId: string;
  readonly #environment: EnvironmentPort;
  readonly #log: AuthorityCommitLog;
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
  #projection: ProbeProjection | undefined;
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;
  #retentionTimer: NodeJS.Timeout | undefined;
  #retentionRunning: Promise<void> | undefined;
  #retentionAbort: AbortController | undefined;

  constructor(options: WorkspaceProbeHandlerOptions) {
    this.#rootDir = path.resolve(options.rootDir);
    this.#markerPath = path.join(this.#rootDir, "probe-log-established");
    this.#executorId = requireIdentifier(
      options.executorId,
      "Workspace probe executorId",
    );
    this.#environment = options.environment;
    this.#log = options.log;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
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
    const request = validateWorkspaceProbeRequest(input, this.#verifier, {
      requireActiveAt: false,
    });
    if (request.resourceLease.audience.executorId !== this.#executorId) {
      throw new TypeError(
        "Workspace probe resource lease belongs to another executor",
      );
    }
    const key = probeKey(request);
    const requestDigest = workspaceProbeRequestDigest(request);
    await this.#ensureOpen();
    const durable = this.#state().entries.get(key);
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

  async compact(
    completedBefore: string,
    limit = 64,
    abort: AbortSignal = new AbortController().signal,
  ): Promise<number> {
    const cutoff = parseCanonicalTime(
      completedBefore,
      "Workspace probe retention cutoff",
    );
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
      throw new RangeError(
        "Workspace probe retirement page size must be between 1 and 256",
      );
    }
    await this.#ensureOpen();
    let retired = 0;
    const page: ProbeProjection["completed"][number][] = [];
    for (const entry of this.#state().completed) {
      if (
        parseCanonicalTime(entry.completedAt, "Workspace probe completion") >=
        cutoff
      ) {
        break;
      }
      page.push(entry);
      if (page.length === limit) break;
    }
    for (const candidate of page) {
      if (abort.aborted) throw abort.reason;
      const entry = this.#state().entries.get(candidate.key);
      if (!entry?.result) continue;
      const transaction = await runStorageMaintenanceStep(
        this.#storageMaintenance,
        storageMaintenanceRequest(
          "workspace-probe-retirement",
          this.#rootDir,
          {
            key: candidate.key,
            requestDigest: entry.requestDigest,
          },
          { obligation: "committed" },
        ),
        () =>
          this.#log.transactProjection<
            ProbeProjection,
            WorkspaceProbeRecord,
            boolean
          >(
            this.#state(),
            (projection, record) =>
              reduceProbeProjection(projection, record, this.#verifier),
            (state) => {
              const current = state.entries.get(candidate.key);
              if (
                !current?.result ||
                current.requestDigest !== entry.requestDigest
              ) {
                return { kind: "return", value: false };
              }
              return {
                kind: "append",
                entries: [
                  {
                    stream: PROBE_STREAM,
                    body: {
                      t: "probe-retired",
                      key: candidate.key,
                      requestDigest: entry.requestDigest,
                      at: this.#clock(),
                    },
                  },
                ],
                value: true,
              };
            },
            { cursor: this.#cursor, stream: PROBE_STREAM },
          ),
      );
      this.#projection = transaction.state;
      this.#cursor = transaction.cursor;
      if (transaction.value) retired += 1;
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
              this.#rootDir,
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
    this.#retentionRunner.stop();
  }

  async #executeFresh(
    request: WorkspaceProbeRequest,
    key: string,
    requestDigest: string,
    abort: AbortSignal,
  ): Promise<WorkspaceProbeResult> {
    validateWorkspaceProbeRequest(request, this.#verifier);
    const resolved = await this.#environment.resolveWorkspace(
      request.bindingRef,
    );
    const started = await this.#log.transactProjection<
      ProbeProjection,
      WorkspaceProbeRecord,
      ProbeEntry | undefined
    >(
      this.#state(),
      (projection, record) =>
        reduceProbeProjection(projection, record, this.#verifier),
      (state) => {
        const current = state.entries.get(key);
        if (current) {
          if (current.requestDigest !== requestDigest) {
            throw new WorkspaceProbeConflictError(
              "Workspace probe identity was reused with another payload",
            );
          }
          return { kind: "return", value: current };
        }
        return {
          kind: "append",
          entries: [
            {
              stream: PROBE_STREAM,
              body: {
                t: "probe-started-v2",
                key,
                requestDigest,
                request: structuredClone(request),
                at: this.#clock(),
              },
            },
          ],
          value: undefined,
        };
      },
      { cursor: this.#cursor, stream: PROBE_STREAM },
    );
    this.#projection = started.state;
    this.#cursor = started.cursor;
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
    const completed = await this.#log.transactProjection<
      ProbeProjection,
      WorkspaceProbeRecord,
      WorkspaceProbeResult
    >(
      this.#state(),
      (projection, record) =>
        reduceProbeProjection(projection, record, this.#verifier),
      (state) => {
        const current = state.entries.get(key);
        if (!current || current.requestDigest !== requestDigest) {
          throw new WorkspaceProbeConflictError(
            "Workspace probe lost its durable start record",
          );
        }
        if (current.result) {
          if (canonicalize(current.result) !== canonicalize(result)) {
            throw new WorkspaceProbeConflictError(
              "Workspace probe completed with conflicting results",
            );
          }
          return { kind: "return", value: current.result };
        }
        return {
          kind: "append",
          entries: [
            {
              stream: PROBE_STREAM,
              body: {
                t: "probe-completed",
                key,
                requestDigest,
                result,
                at: this.#clock(),
              },
            },
          ],
          value: result,
        };
      },
      { cursor: this.#cursor, stream: PROBE_STREAM },
    );
    this.#projection = completed.state;
    this.#cursor = completed.cursor;
    return structuredClone(completed.value);
  }

  #state(): ProbeProjection {
    if (!this.#projection) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Workspace probe log has not been opened",
      );
    }
    return this.#projection;
  }

  async #ensureOpen(): Promise<void> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<void> {
    await ensureDurableDirectory(this.#rootDir);
    const markerExists = await exists(this.#markerPath);
    const logPath =
      "logPath" in this.#log
        ? String(
            (this.#log as AuthorityCommitLog & { logPath: string }).logPath,
          )
        : undefined;
    const logExists = logPath === undefined ? true : await exists(logPath);
    if (markerExists && !logExists) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Established workspace probe log is missing",
      );
    }
    const snapshot = await this.#log.readSnapshot<WorkspaceProbeRecord>();
    let state = emptyProbeProjection();
    for (const commit of snapshot.commits) {
      for (const entry of commit.entries) {
        if (entry.stream === PROBE_STREAM) {
          state = reduceProbeProjection(
            state,
            entry as LogicalRecord<WorkspaceProbeRecord>,
            this.#verifier,
          );
        }
      }
    }
    this.#cursor = snapshot.cursor;
    if (!state.established) {
      const probeEntriesExist = snapshot.commits.some((commit) =>
        commit.entries.some((entry) => entry.stream === PROBE_STREAM),
      );
      if (markerExists || probeEntriesExist) {
        throw new AuthorityStorageError(
          "invalid-authority-record",
          "Workspace probe log lacks its establishment fact",
        );
      }
      await this.#log.append<WorkspaceProbeRecord>([
        {
          stream: PROBE_STREAM,
          body: {
            t: "probe-log-established",
            executorId: this.#executorId,
          },
        },
      ]);
      const refreshed = await this.#log.readSnapshot<WorkspaceProbeRecord>();
      state = emptyProbeProjection();
      for (const commit of refreshed.commits) {
        for (const entry of commit.entries) {
          if (entry.stream === PROBE_STREAM) {
            state = reduceProbeProjection(
              state,
              entry as LogicalRecord<WorkspaceProbeRecord>,
              this.#verifier,
            );
          }
        }
      }
      this.#cursor = refreshed.cursor;
    }
    if (state.executorId !== this.#executorId) {
      throw new AuthorityStorageError(
        "invalid-authority-record",
        "Workspace probe log belongs to another executor",
      );
    }
    this.#projection = state;
    if (!markerExists) await writeMarker(this.#markerPath);
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
    } catch {
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
    } catch {
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

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    },
  );
}

async function writeMarker(markerPath: string): Promise<void> {
  const handle = await open(markerPath, "wx", 0o600).catch((error: unknown) => {
    if (isNodeError(error, "EEXIST")) return undefined;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.writeFile("workspace-probe-log-v1\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(markerPath));
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function corruptProbeLog(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

export class WorkspaceProbeConflictError extends Error {
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
    ...["log-established", "started", "completed", "retired"].map((key) => ({ kind: "variant" as const, key, reasonCode: `WORKSPACE_PROBE_${key.replaceAll("-", "_").toUpperCase()}` })),
    ...["grant-binding", "lease-binding", "request-conflict", "expired-fresh-request"].map((key) => ({ kind: "rejection" as const, key, reasonCode: `WORKSPACE_PROBE_${key.replaceAll("-", "_").toUpperCase()}` })),
    ...["invalid-result", "request-result-mismatch", "broken-replay-index"].map((key) => ({ kind: "corruption" as const, key, reasonCode: `WORKSPACE_PROBE_${key.replaceAll("-", "_").toUpperCase()}` })),
  ],
} as const);
