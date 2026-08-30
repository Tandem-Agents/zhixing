import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { defineDurableRuntimeContract } from "@zhixing/core/contracts";
import {
  type WorkspaceAdministrationDurableOperation,
  validateWorkspaceAdministrationDurableOperation,
} from "@zhixing/core/environment/workspace-administration";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
} from "@zhixing/core/resources";

const VERSION = 1;
const EMPTY_PREFIX = protocolDigest("LocalWorkspaceOperationPrefix", 1, null);
export const LOCAL_WORKSPACE_PREPARED_TTL_MS = 15 * 60_000;

export class LocalWorkspaceOperationIdentityMismatchError extends Error {
  readonly code = "LOCAL_WORKSPACE_OPERATION_IDENTITY_MISMATCH";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalWorkspaceOperationIdentityMismatchError";
  }
}

export class LocalWorkspaceConfirmationHoleError extends Error {
  readonly code = "LOCAL_WORKSPACE_CONFIRMATION_HOLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalWorkspaceConfirmationHoleError";
  }
}

export class LocalWorkspaceOutboxChainCorruptionError extends Error {
  readonly code = "LOCAL_WORKSPACE_OUTBOX_CHAIN_CORRUPT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalWorkspaceOutboxChainCorruptionError";
  }
}

export class LocalWorkspaceOutboxIdentityCorruptionError extends Error {
  readonly code = "LOCAL_WORKSPACE_OUTBOX_IDENTITY_CORRUPT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalWorkspaceOutboxIdentityCorruptionError";
  }
}

export const LOCAL_WORKSPACE_OPERATION_OUTBOX_DURABLE_CONTRACT =
  defineDurableRuntimeContract({
    recordFamily: "local-workspace-operation-outbox",
    producer: "LocalWorkspaceOperationOutbox",
    recoveryOwner: "LocalWorkspaceManagementHost",
    resourceIdentity: "zhixingHome/runtime/local-workspace-operation-outbox",
    recoveryClass: "committed-forward-recovery",
    cases: [
      { kind: "variant", key: "prepared" },
      { kind: "variant", key: "committed" },
      { kind: "variant", key: "completed" },
      { kind: "variant", key: "abandoned" },
      { kind: "rejection", key: "identity-mismatch", reasonCode: "LOCAL_WORKSPACE_OPERATION_IDENTITY_MISMATCH" },
      { kind: "rejection", key: "confirmation-hole", reasonCode: "LOCAL_WORKSPACE_CONFIRMATION_HOLE" },
      { kind: "corruption", key: "checkpoint-chain", reasonCode: "LOCAL_WORKSPACE_OUTBOX_CHAIN_CORRUPT" },
      { kind: "corruption", key: "establishment-marker", reasonCode: "LOCAL_WORKSPACE_OUTBOX_IDENTITY_CORRUPT" },
    ],
  });

export type LocalWorkspaceOperationState =
  | "prepared"
  | "committed"
  | "completed"
  | "abandoned";

export interface LocalWorkspaceOperation {
  readonly localSeq: number;
  readonly operationId: string;
  readonly input: WorkspaceAdministrationDurableOperation;
  readonly inputDigest: string;
  readonly state: LocalWorkspaceOperationState;
  readonly preparedAt: string;
  readonly expiresAt?: string;
  readonly confirmationToken?: string;
  readonly result?: unknown;
  readonly resultDigest?: string;
}

interface Checkpoint {
  readonly v: typeof VERSION;
  readonly outboxId: string;
  readonly nextSeq: number;
  readonly confirmedThroughSeq: number;
  readonly confirmedPrefixDigest: string;
}

interface EstablishmentMarker {
  readonly v: typeof VERSION;
  readonly outboxId: string;
  readonly confirmedThroughSeq: number;
  readonly confirmedPrefixDigest: string;
}

interface Event {
  readonly v: typeof VERSION;
  readonly eventSeq: number;
  readonly previousDigest: string;
  readonly digest: string;
  readonly operation: LocalWorkspaceOperation;
}

interface PersistedState {
  checkpoint: Checkpoint;
  operations: Map<number, LocalWorkspaceOperation>;
  nextLocalSeq: number;
  nextEventSeq: number;
  headDigest: string;
}

export class LocalWorkspaceOperationOutbox {
  readonly #rootDir: string;
  readonly #filePath: string;
  readonly #markerPath: string;
  readonly #storage?: StorageMaintenanceGovernorPort;
  readonly #clock: () => string;
  #state: PersistedState | undefined;
  #tail = Promise.resolve();

  constructor(input: {
    readonly rootDir: string;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
    readonly clock?: () => string;
  }) {
    this.#rootDir = path.resolve(input.rootDir);
    this.#filePath = path.join(this.#rootDir, "operations.ndjson");
    this.#markerPath = `${this.#rootDir}.established`;
    this.#storage = input.storageMaintenance;
    this.#clock = input.clock ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<void> {
    await this.#serial(async () => {
      if (this.#state) return;
      await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
      const [hasMarker, hasFile] = await Promise.all([
        exists(this.#markerPath),
        exists(this.#filePath),
      ]);
      if (hasMarker && !hasFile) {
        throw new Error("Established local workspace outbox is missing");
      }
      if (!hasMarker && hasFile) {
        throw new Error("Local workspace outbox has data without its establishment marker");
      }
      if (!hasFile) {
        const checkpoint: Checkpoint = {
          v: VERSION,
          outboxId: `outbox-${randomBytes(24).toString("base64url")}`,
          nextSeq: 1,
          confirmedThroughSeq: 0,
          confirmedPrefixDigest: EMPTY_PREFIX,
        };
        await this.#replace(checkpoint, []);
        await durableCreate(
          this.#markerPath,
          `${canonicalize(markerFromCheckpoint(checkpoint))}\n`,
        );
      }
      this.#state = await this.#read();
      await this.#recoverEstablishmentMarker();
      await this.#expirePrepared();
    });
  }

  get outboxId(): string {
    return this.#requireState().checkpoint.outboxId;
  }

  async prepare(
    input: WorkspaceAdministrationDurableOperation,
  ): Promise<LocalWorkspaceOperation> {
    await this.initialize();
    return this.#serial(async () => {
      await this.#expirePrepared();
      const normalized = validateWorkspaceAdministrationDurableOperation(input);
      const inputDigest = protocolDigest("LocalWorkspaceOperationInput", 1, normalized);
      const existing = [...this.#requireState().operations.values()].find(
        (operation) => operation.inputDigest === inputDigest && operation.state !== "abandoned",
      );
      if (existing) return cloneOperation(existing);
      const state = this.#requireState();
      const preparedAt = this.#clock();
      const operation: LocalWorkspaceOperation = {
        localSeq: state.nextLocalSeq,
        operationId: `workspace-operation-${randomUUID()}`,
        input: normalized,
        inputDigest,
        state: "prepared",
        preparedAt,
        ...(normalized.kind === "reset"
          ? {
              expiresAt: new Date(
                Date.parse(preparedAt) + LOCAL_WORKSPACE_PREPARED_TTL_MS,
              ).toISOString(),
            }
          : {}),
      };
      await this.#append(operation);
      state.nextLocalSeq = operation.localSeq + 1;
      return cloneOperation(operation);
    });
  }

  async commit(
    identity: { readonly localSeq: number; readonly operationId: string; readonly inputDigest: string },
    confirmation?: { readonly impact: string },
  ): Promise<LocalWorkspaceOperation> {
    await this.initialize();
    return this.#serial(async () => {
      await this.#expirePrepared();
      const operation = this.#requireOperation(identity);
      if (operation.state === "abandoned") {
        throw new Error("Local workspace operation reservation was abandoned");
      }
      if (operation.input.kind === "reset") {
        if (confirmation?.impact !== operation.input.impact) {
          throw new Error("Local workspace reset confirmation does not match its preview");
        }
      } else if (confirmation !== undefined) {
        throw new Error("Local workspace confirmation is only valid for reset");
      }
      if (operation.state === "prepared") {
        if (operation.input.kind === "reset") {
          if (
            !operation.expiresAt
          ) {
            throw new Error("Local workspace reset preview is invalid or expired");
          }
        }
        const committed = {
          ...operation,
          state: "committed" as const,
          ...(operation.input.kind === "reset"
            ? { confirmationToken: randomBytes(32).toString("base64url") }
            : {}),
        };
        await this.#append(committed);
        return cloneOperation(committed);
      }
      return cloneOperation(operation);
    });
  }

  async complete(
    identity: { readonly localSeq: number; readonly operationId: string; readonly inputDigest: string },
    result: unknown,
  ): Promise<LocalWorkspaceOperation> {
    await this.initialize();
    return this.#serial(async () => {
      const operation = this.#requireOperation(identity);
      const persistedResult = result ?? null;
      const resultDigest = protocolDigest("LocalWorkspaceOperationResult", 1, persistedResult);
      if (operation.state === "completed") {
        if (operation.resultDigest !== resultDigest) {
          throw new Error("Local workspace operation completed with another result");
        }
        return cloneOperation(operation);
      }
      if (operation.state !== "committed") {
        throw new Error("Only a committed local workspace operation may complete");
      }
      const completed = { ...operation, state: "completed" as const, result: persistedResult, resultDigest };
      await this.#append(completed);
      return cloneOperation(completed);
    });
  }

  async pending(afterSeq = 0, limit = 64): Promise<{
    readonly outboxId: string;
    readonly operations: readonly LocalWorkspaceOperation[];
    readonly next?: number;
    readonly confirmation: { readonly throughSeq: number; readonly prefixDigest: string };
  }> {
    await this.initialize();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("Local workspace outbox page is invalid");
    }
    const operations = [...this.#requireState().operations.values()]
      .filter((operation) => operation.localSeq > afterSeq)
      .sort((left, right) => left.localSeq - right.localSeq)
      .slice(0, limit)
      .map(cloneOperation);
    const last = operations.at(-1)?.localSeq;
    const hasMore = last !== undefined && [...this.#requireState().operations.keys()].some((seq) => seq > last);
    const checkpoint = this.#requireState().checkpoint;
    return {
      outboxId: checkpoint.outboxId,
      operations,
      ...(hasMore ? { next: last } : {}),
      confirmation: {
        throughSeq: checkpoint.confirmedThroughSeq,
        prefixDigest: checkpoint.confirmedPrefixDigest,
      },
    };
  }

  async acknowledge(input: {
    readonly outboxId: string;
    readonly throughSeq: number;
    readonly prefixDigest: string;
    readonly entries: readonly {
      localSeq: number;
      operationId: string;
      inputDigest: string;
      resultDigest: string;
    }[];
  }): Promise<{ outboxId: string; throughSeq: number; prefixDigest: string }> {
    await this.initialize();
    return this.#serial(async () => {
      const state = this.#requireState();
      if (input.outboxId !== state.checkpoint.outboxId) {
        throw new LocalWorkspaceOperationIdentityMismatchError(
          "Local workspace acknowledgment is bound to another outbox",
        );
      }
      if (input.throughSeq === state.checkpoint.confirmedThroughSeq) {
        if (input.prefixDigest !== state.checkpoint.confirmedPrefixDigest) {
          throw new LocalWorkspaceConfirmationHoleError(
            "Local workspace acknowledgment digest conflicts with its watermark",
          );
        }
        return {
          outboxId: state.checkpoint.outboxId,
          throughSeq: input.throughSeq,
          prefixDigest: input.prefixDigest,
        };
      }
      if (input.throughSeq < state.checkpoint.confirmedThroughSeq) {
        throw new LocalWorkspaceConfirmationHoleError(
          "Local workspace acknowledgment moved backwards",
        );
      }
      let expectedSeq = state.checkpoint.confirmedThroughSeq + 1;
      let prefixDigest = state.checkpoint.confirmedPrefixDigest;
      for (const entry of input.entries) {
        if (entry.localSeq !== expectedSeq) {
          throw new LocalWorkspaceConfirmationHoleError(
            "Local workspace acknowledgment crossed an operation hole",
          );
        }
        const operation = state.operations.get(entry.localSeq);
        if (!operation || !isTerminal(operation) || !operation.resultDigest) {
          throw new Error("Local workspace acknowledgment contains a non-terminal operation");
        }
        if (
          operation.operationId !== entry.operationId ||
          operation.inputDigest !== entry.inputDigest ||
          operation.resultDigest !== entry.resultDigest
        ) {
          throw new LocalWorkspaceOperationIdentityMismatchError(
            "Local workspace acknowledgment is bound to another operation",
          );
        }
        prefixDigest = protocolDigest("LocalWorkspaceOperationPrefix", 1, {
          previous: prefixDigest,
          localSeq: entry.localSeq,
          operationId: entry.operationId,
          inputDigest: entry.inputDigest,
          resultDigest: entry.resultDigest,
        });
        expectedSeq += 1;
      }
      if (input.entries.at(-1)?.localSeq !== input.throughSeq || prefixDigest !== input.prefixDigest) {
        throw new LocalWorkspaceConfirmationHoleError(
          "Local workspace acknowledgment prefix is invalid",
        );
      }
      const checkpoint: Checkpoint = {
        ...state.checkpoint,
        nextSeq: state.nextLocalSeq,
        confirmedThroughSeq: input.throughSeq,
        confirmedPrefixDigest: prefixDigest,
      };
      const remaining = [...state.operations.values()].filter(
        (operation) => operation.localSeq > input.throughSeq,
      );
      await durableReplace(
        this.#markerPath,
        `${canonicalize(markerFromCheckpoint(checkpoint))}\n`,
      );
      await this.#replace(checkpoint, remaining);
      this.#state = await this.#read();
      return {
        outboxId: state.checkpoint.outboxId,
        throughSeq: input.throughSeq,
        prefixDigest,
      };
    });
  }

  operation(identity: { readonly localSeq: number; readonly operationId: string; readonly inputDigest: string }): LocalWorkspaceOperation {
    return cloneOperation(this.#requireOperation(identity));
  }

  async oldestCommitted(): Promise<LocalWorkspaceOperation | undefined> {
    await this.initialize();
    const operation = [...this.#requireState().operations.values()]
      .filter((candidate) => candidate.state === "committed")
      .sort((left, right) => left.localSeq - right.localSeq)[0];
    return operation ? cloneOperation(operation) : undefined;
  }

  async #expirePrepared(): Promise<void> {
    const now = Date.parse(this.#clock());
    for (const operation of [...this.#requireState().operations.values()]) {
      if (
        operation.state !== "prepared" ||
        now <= Date.parse(
          operation.expiresAt ??
            new Date(
              Date.parse(operation.preparedAt) +
                LOCAL_WORKSPACE_PREPARED_TTL_MS,
            ).toISOString(),
        )
      ) continue;
      const result = { abandoned: true };
      await this.#append({
        ...operation,
        state: "abandoned",
        result,
        resultDigest: protocolDigest("LocalWorkspaceOperationResult", 1, result),
      });
    }
  }

  async #recoverEstablishmentMarker(): Promise<void> {
    const state = this.#requireState();
    let marker: EstablishmentMarker;
    try {
      marker = validateMarker(JSON.parse(await readFile(this.#markerPath, "utf8")));
    } catch (error) {
      throw new LocalWorkspaceOutboxIdentityCorruptionError(
        error instanceof Error ? error.message : "Local workspace outbox establishment marker is corrupt",
        { cause: error },
      );
    }
    if (marker.outboxId !== state.checkpoint.outboxId) {
      throw new LocalWorkspaceOutboxIdentityCorruptionError(
        "Local workspace outbox identity conflicts with its establishment marker",
      );
    }
    if (marker.confirmedThroughSeq < state.checkpoint.confirmedThroughSeq) {
      throw new LocalWorkspaceOutboxIdentityCorruptionError(
        "Local workspace outbox establishment marker moved backwards",
      );
    }
    if (marker.confirmedThroughSeq === state.checkpoint.confirmedThroughSeq) {
      if (marker.confirmedPrefixDigest !== state.checkpoint.confirmedPrefixDigest) {
        throw new LocalWorkspaceOutboxIdentityCorruptionError(
          "Local workspace outbox establishment marker digest conflicts with its checkpoint",
        );
      }
      return;
    }

    let expectedSeq = state.checkpoint.confirmedThroughSeq + 1;
    let prefixDigest = state.checkpoint.confirmedPrefixDigest;
    while (expectedSeq <= marker.confirmedThroughSeq) {
      const operation = state.operations.get(expectedSeq);
      if (!operation || !isTerminal(operation) || !operation.resultDigest) {
        throw new LocalWorkspaceOutboxIdentityCorruptionError(
          "Local workspace outbox rollback cannot be recovered from its durable log",
        );
      }
      prefixDigest = protocolDigest("LocalWorkspaceOperationPrefix", 1, {
        previous: prefixDigest,
        localSeq: operation.localSeq,
        operationId: operation.operationId,
        inputDigest: operation.inputDigest,
        resultDigest: operation.resultDigest,
      });
      expectedSeq += 1;
    }
    if (prefixDigest !== marker.confirmedPrefixDigest) {
      throw new LocalWorkspaceOutboxIdentityCorruptionError(
        "Local workspace outbox rollback conflicts with its durable confirmation prefix",
      );
    }
    const checkpoint: Checkpoint = {
      ...state.checkpoint,
      nextSeq: state.nextLocalSeq,
      confirmedThroughSeq: marker.confirmedThroughSeq,
      confirmedPrefixDigest: marker.confirmedPrefixDigest,
    };
    await this.#replace(
      checkpoint,
      [...state.operations.values()].filter(
        (operation) => operation.localSeq > marker.confirmedThroughSeq,
      ),
    );
    this.#state = await this.#read();
  }

  async #append(operation: LocalWorkspaceOperation): Promise<void> {
    const state = this.#requireState();
    const body = {
      v: VERSION as typeof VERSION,
      eventSeq: state.nextEventSeq,
      previousDigest: state.headDigest,
      operation,
    };
    const event: Event = {
      ...body,
      digest: protocolDigest("LocalWorkspaceOperationEvent", 1, body),
    };
    await this.#storageStep({ eventSeq: event.eventSeq, localSeq: operation.localSeq }, async () => {
      const handle = await open(this.#filePath, "a", 0o600);
      try {
        await handle.writeFile(`${canonicalize(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    state.operations.set(operation.localSeq, cloneOperation(operation));
    state.nextEventSeq += 1;
    state.headDigest = event.digest;
  }

  async #replace(checkpoint: Checkpoint, operations: readonly LocalWorkspaceOperation[]): Promise<void> {
    const checkpointDigest = protocolDigest("LocalWorkspaceOperationCheckpoint", 1, checkpoint);
    const lines = [canonicalize({ checkpoint, digest: checkpointDigest })];
    let previousDigest = checkpointDigest;
    let eventSeq = 1;
    for (const operation of [...operations].sort((a, b) => a.localSeq - b.localSeq)) {
      const body = { v: VERSION, eventSeq, previousDigest, operation };
      const event = { ...body, digest: protocolDigest("LocalWorkspaceOperationEvent", 1, body) };
      lines.push(canonicalize(event));
      previousDigest = event.digest;
      eventSeq += 1;
    }
    await this.#storageStep({ compactThrough: checkpoint.confirmedThroughSeq }, async () => {
      const temp = `${this.#filePath}.tmp-${process.pid}-${randomUUID()}`;
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(`${lines.join("\n")}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#filePath);
      await syncDirectory(this.#rootDir);
    }).catch(async (error) => {
      const candidates = await import("node:fs/promises").then(({ readdir }) =>
        readdir(this.#rootDir).catch(() => []),
      );
      await Promise.all(candidates
        .filter((name) => name.startsWith("operations.ndjson.tmp-"))
        .map((name) => rm(path.join(this.#rootDir, name), { force: true })));
      throw error;
    });
  }

  async #read(): Promise<PersistedState> {
    try {
      const lines = (await readFile(this.#filePath, "utf8")).split("\n").filter(Boolean);
      if (lines.length === 0) throw new Error("Local workspace outbox is empty");
      const first = parseExact(JSON.parse(lines[0]!), ["checkpoint", "digest"], "checkpoint envelope");
      const checkpoint = validateCheckpoint(first.checkpoint);
      const checkpointDigest = protocolDigest("LocalWorkspaceOperationCheckpoint", 1, checkpoint);
      if (first.digest !== checkpointDigest) throw new Error("Local workspace outbox checkpoint digest is invalid");
      const operations = new Map<number, LocalWorkspaceOperation>();
      let headDigest = checkpointDigest;
      let nextEventSeq = 1;
      for (const line of lines.slice(1)) {
        const event = validateEvent(JSON.parse(line), nextEventSeq, headDigest, checkpoint);
        const previous = operations.get(event.operation.localSeq);
        validateTransition(previous, event.operation);
        operations.set(event.operation.localSeq, cloneOperation(event.operation));
        headDigest = event.digest;
        nextEventSeq += 1;
      }
      const sequences = [...operations.keys()].sort((a, b) => a - b);
      for (let index = 0; index < sequences.length; index += 1) {
        if (sequences[index] !== checkpoint.confirmedThroughSeq + index + 1) {
          throw new Error("Local workspace outbox operation sequence contains a gap");
        }
      }
      const nextLocalSeq = Math.max(
        checkpoint.nextSeq,
        (sequences.at(-1) ?? checkpoint.confirmedThroughSeq) + 1,
      );
      if (
        checkpoint.nextSeq < checkpoint.confirmedThroughSeq + 1 ||
        nextLocalSeq !== checkpoint.confirmedThroughSeq + sequences.length + 1
      ) {
        throw new Error("Local workspace outbox next sequence is invalid");
      }
      return { checkpoint, operations, nextLocalSeq, nextEventSeq, headDigest };
    } catch (error) {
      if (error instanceof LocalWorkspaceOutboxChainCorruptionError) throw error;
      throw new LocalWorkspaceOutboxChainCorruptionError(
        error instanceof Error ? error.message : "Local workspace outbox chain is corrupt",
        { cause: error },
      );
    }
  }

  async #storageStep(identity: unknown, operation: () => Promise<void>): Promise<void> {
    await runStorageMaintenanceStep(
      this.#storage,
      storageMaintenanceRequest(
        "local-workspace-operation-outbox",
        this.#rootDir,
        { kind: "local-workspace-operation-outbox", identity },
        { obligation: "committed", maxWaitMs: 0 },
      ),
      operation,
    );
  }

  #requireState(): PersistedState {
    if (!this.#state) throw new Error("Local workspace outbox is not initialized");
    return this.#state;
  }

  #requireOperation(identity: { readonly localSeq: number; readonly operationId: string; readonly inputDigest: string }): LocalWorkspaceOperation {
    const state = this.#requireState();
    if (identity.localSeq <= state.checkpoint.confirmedThroughSeq) {
      throw new Error("Local workspace operation was already acknowledged and compacted");
    }
    const operation = state.operations.get(identity.localSeq);
    if (!operation || operation.operationId !== identity.operationId || operation.inputDigest !== identity.inputDigest) {
      throw new LocalWorkspaceOperationIdentityMismatchError(
        "Local workspace operation identity is invalid",
      );
    }
    return operation;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function validateCheckpoint(value: unknown): Checkpoint {
  const record = parseExact(value, ["confirmedPrefixDigest", "confirmedThroughSeq", "nextSeq", "outboxId", "v"], "checkpoint");
  if (
    record.v !== VERSION ||
    typeof record.outboxId !== "string" ||
    !/^outbox-[A-Za-z0-9_-]{32}$/u.test(record.outboxId) ||
    !Number.isSafeInteger(record.nextSeq) || (record.nextSeq as number) < 1 ||
    !Number.isSafeInteger(record.confirmedThroughSeq) || (record.confirmedThroughSeq as number) < 0 ||
    typeof record.confirmedPrefixDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.confirmedPrefixDigest)
  ) throw new Error("Local workspace outbox checkpoint is invalid");
  return record as unknown as Checkpoint;
}

function markerFromCheckpoint(checkpoint: Checkpoint): EstablishmentMarker {
  return {
    v: VERSION,
    outboxId: checkpoint.outboxId,
    confirmedThroughSeq: checkpoint.confirmedThroughSeq,
    confirmedPrefixDigest: checkpoint.confirmedPrefixDigest,
  };
}

function validateMarker(value: unknown): EstablishmentMarker {
  const record = parseExact(
    value,
    ["confirmedPrefixDigest", "confirmedThroughSeq", "outboxId", "v"],
    "establishment marker",
  );
  if (
    record.v !== VERSION ||
    typeof record.outboxId !== "string" ||
    !/^outbox-[A-Za-z0-9_-]{32}$/u.test(record.outboxId) ||
    !Number.isSafeInteger(record.confirmedThroughSeq) ||
    (record.confirmedThroughSeq as number) < 0 ||
    typeof record.confirmedPrefixDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.confirmedPrefixDigest)
  ) {
    throw new Error("Local workspace outbox establishment marker is invalid");
  }
  return record as unknown as EstablishmentMarker;
}

function validateEvent(value: unknown, eventSeq: number, previousDigest: string, checkpoint: Checkpoint): Event {
  const record = parseExact(value, ["digest", "eventSeq", "operation", "previousDigest", "v"], "event");
  const operation = validateLocalWorkspaceOperation(record.operation);
  const body = { v: record.v, eventSeq: record.eventSeq, previousDigest: record.previousDigest, operation };
  if (
    record.v !== VERSION || record.eventSeq !== eventSeq || record.previousDigest !== previousDigest ||
    record.digest !== protocolDigest("LocalWorkspaceOperationEvent", 1, body) ||
    operation.localSeq <= checkpoint.confirmedThroughSeq
  ) throw new Error("Local workspace outbox event is invalid");
  return { ...body, digest: record.digest as string } as Event;
}

export function validateLocalWorkspaceOperation(value: unknown): LocalWorkspaceOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local workspace operation is invalid");
  const record = value as Record<string, unknown>;
  const allowed = ["confirmationToken", "expiresAt", "input", "inputDigest", "localSeq", "operationId", "preparedAt", "result", "resultDigest", "state"];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || !Object.keys(record).every((key) => allowed.includes(key))) {
    throw new Error("Local workspace operation fields are invalid");
  }
  const input = validateWorkspaceAdministrationDurableOperation(record.input);
  if (
    !Number.isSafeInteger(record.localSeq) || (record.localSeq as number) < 1 ||
    typeof record.operationId !== "string" || !record.operationId.startsWith("workspace-operation-") ||
    record.inputDigest !== protocolDigest("LocalWorkspaceOperationInput", 1, input) ||
    !["prepared", "committed", "completed", "abandoned"].includes(record.state as string) ||
    typeof record.preparedAt !== "string" || !isCanonicalTimestamp(record.preparedAt) ||
    (input.kind === "reset"
      ? typeof record.expiresAt !== "string" ||
        !isCanonicalTimestamp(record.expiresAt) ||
        Date.parse(record.expiresAt) <= Date.parse(record.preparedAt as string) ||
        (record.state === "committed" || record.state === "completed"
          ? typeof record.confirmationToken !== "string"
          : record.confirmationToken !== undefined)
      : record.expiresAt !== undefined || record.confirmationToken !== undefined) ||
    (isTerminalState(record.state)
      ? typeof record.resultDigest !== "string" || record.resultDigest !== protocolDigest("LocalWorkspaceOperationResult", 1, record.result ?? null)
      : record.result !== undefined || record.resultDigest !== undefined)
  ) throw new Error("Local workspace operation is invalid");
  return structuredClone(value) as LocalWorkspaceOperation;
}

function validateTransition(previous: LocalWorkspaceOperation | undefined, next: LocalWorkspaceOperation): void {
  if (!previous) {
    if (next.state !== "prepared" && next.state !== "committed" && next.state !== "completed" && next.state !== "abandoned") {
      throw new Error("Local workspace operation initial state is invalid");
    }
    return;
  }
  if (previous.operationId !== next.operationId || previous.inputDigest !== next.inputDigest || canonicalize(previous.input) !== canonicalize(next.input)) {
    throw new Error("Local workspace operation identity changed");
  }
  const allowed = previous.state === "prepared"
    ? new Set(["prepared", "committed", "abandoned"])
    : previous.state === "committed"
      ? new Set(["committed", "completed"])
      : new Set([previous.state]);
  if (!allowed.has(next.state)) throw new Error("Local workspace operation state moved backwards");
}

function parseExact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Local workspace ${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) throw new Error(`Local workspace ${label} fields are invalid`);
  return record;
}

function cloneOperation(operation: LocalWorkspaceOperation): LocalWorkspaceOperation {
  return structuredClone(operation);
}

function isTerminal(operation: LocalWorkspaceOperation): boolean {
  return operation.state === "completed" || operation.state === "abandoned";
}

function isTerminalState(value: unknown): boolean {
  return value === "completed" || value === "abandoned";
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function durableCreate(filePath: string, body: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(filePath));
}

async function durableReplace(filePath: string, body: string): Promise<void> {
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch((error: unknown) => {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EINVAL")
      ) {
        return;
      }
      throw error;
    });
  } finally {
    await handle.close();
  }
}
