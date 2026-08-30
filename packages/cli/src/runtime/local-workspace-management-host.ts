import { protocolDigest } from "@zhixing/core/protocol";
import path from "node:path";
import {
  WorkspaceAdministrationApplicationService,
  WorkspaceAdministrationBusinessError,
  WORKSPACE_CATALOG_RESET_IMPACT,
  type WorkspaceAdministrationApplication,
  type WorkspaceAdministrationCatalogStatus,
  type WorkspaceControlAuthorization,
  type WorkspaceAdministrationView,
} from "@zhixing/core/environment/workspace-administration";
import {
  DeviceCapacityAdmissionError,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import {
  WorkspaceBindingCancelledError,
  WorkspaceBindingCatalogConflictError,
  WorkspaceBindingConflictError,
  WorkspaceBindingNotFoundError,
  WorkspaceBindingRevisionError,
} from "@zhixing/core/environment";
import {
  ExecutorResourceAdmissionExpiredError,
  ExecutorResourceAdmissionPendingError,
  ExecutorResourceBackpressureError,
} from "@zhixing/executor";
import type { WorkspaceBindingResetReceipt } from "@zhixing/core/contracts";
import {
  LocalWorkspaceOperationOutbox,
  type LocalWorkspaceOperation,
  type LocalWorkspaceWriteOperation,
  validateLocalWorkspaceOperation,
  validateLocalWorkspaceWriteOperation,
} from "./local-workspace-operation-outbox.js";
import {
  LocalWorkspaceTransportServer,
  callLocalWorkspaceHost,
  type LocalWorkspaceOwnerLease,
} from "./local-workspace-owner.js";
import { ExecutorWorkspaceAdministrationControl } from "./local-workspace-control.js";

const PAGE_SIZE = 64;

export interface OperationIdentity {
  readonly localSeq: number;
  readonly operationId: string;
  readonly inputDigest: string;
}

export interface LocalWorkspaceConsumptionCredential extends OperationIdentity {
  readonly outboxId: string;
  readonly resultDigest: string;
}

type HostRequest =
  | { readonly kind: "host-status" }
  | { readonly kind: "status" }
  | { readonly kind: "list" }
  | { readonly kind: "view"; readonly displayName: string }
  | { readonly kind: "prepare"; readonly input: LocalWorkspaceWriteOperation }
  | {
      readonly kind: "commit";
      readonly identity: OperationIdentity;
      readonly confirmation?: { readonly impact: string };
    }
  | { readonly kind: "pending"; readonly afterSeq: number }
  | {
      readonly kind: "acknowledge";
      readonly outboxId: string;
      readonly throughSeq: number;
      readonly prefixDigest: string;
      readonly entries: readonly ConfirmationEntry[];
    };

interface ConfirmationEntry extends OperationIdentity {
  readonly resultDigest: string;
}

interface OperationResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export type LocalWorkspaceHostState =
  | "recovering"
  | "ready"
  | "degraded"
  | "draining"
  | "closed";

export interface LocalWorkspaceHostStatus {
  readonly state: LocalWorkspaceHostState;
  readonly diagnostic?: {
    readonly code: string;
    readonly message: string;
    readonly localSeq?: number;
  };
}

type RetryDecision = {
  readonly kind: "retry";
  readonly code: string;
  readonly message: string;
  readonly delayMs: number;
};
type DegradedDecision = {
  readonly kind: "degraded";
  readonly code: string;
  readonly message: string;
};
type InfrastructureDecision = RetryDecision | DegradedDecision;
type OperationDecision =
  | { readonly kind: "completed"; readonly result: OperationResult }
  | InfrastructureDecision;

type LocalWorkspaceHostApplications = WorkspaceAdministrationApplication;

export type LocalWorkspaceCatalogStatus = WorkspaceAdministrationCatalogStatus;

export interface LocalWorkspaceClient {
  status(): Promise<LocalWorkspaceCatalogStatus>;
  list(): Promise<readonly WorkspaceAdministrationView[]>;
  viewByName(displayName: string): Promise<WorkspaceAdministrationView>;
  create(displayName: string, absolutePath: string): Promise<WorkspaceAdministrationView>;
  authorizeForControl(
    displayName: string,
    absolutePath: string,
  ): Promise<WorkspaceControlAuthorization>;
  rename(currentName: string, displayName: string, expectedRevision: number): Promise<WorkspaceAdministrationView>;
  repath(name: string, absolutePath: string, expectedRevision: number): Promise<WorkspaceAdministrationView>;
  remove(name: string, expectedRevision: number): Promise<void>;
  previewReset(expectedCatalogGeneration: string): Promise<LocalWorkspaceResetPreview>;
  confirmReset(
    preview: LocalWorkspaceResetPreview,
    confirmedImpact: string,
  ): Promise<WorkspaceBindingResetReceipt>;
  consumptionCredential(): LocalWorkspaceConsumptionCredential | undefined;
  confirmDelivered(): Promise<void>;
}

export interface LocalWorkspaceResetPreview extends OperationIdentity {
  readonly expectedCatalogGeneration: string;
  readonly impact: string;
  readonly expiresAt: string;
}

export function encodeLocalWorkspaceResetPreview(
  preview: LocalWorkspaceResetPreview,
): string {
  validateResetPreview(preview);
  return Buffer.from(JSON.stringify(preview), "utf8").toString("base64url");
}

export function decodeLocalWorkspaceResetPreview(
  encoded: string,
): LocalWorkspaceResetPreview {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new TypeError("Local workspace reset confirmation is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Local workspace reset confirmation is invalid");
  }
  const record = exactRecord(
    value,
    [
      "expectedCatalogGeneration",
      "expiresAt",
      "impact",
      "inputDigest",
      "localSeq",
      "operationId",
    ],
    "reset confirmation",
  ) as unknown as LocalWorkspaceResetPreview;
  validateResetPreview(record);
  return structuredClone(record);
}

export class RecoveredLocalWorkspaceOperationsError extends Error {
  readonly code = "LOCAL_WORKSPACE_RESULTS_RECOVERED";
  readonly outboxId: string;
  readonly operations: readonly LocalWorkspaceOperation[];

  constructor(outboxId: string, operations: readonly LocalWorkspaceOperation[]) {
    super("已恢复先前未确认的本机工作区操作结果，请查看后重试当前命令");
    this.name = "RecoveredLocalWorkspaceOperationsError";
    this.outboxId = outboxId;
    this.operations = operations.map((operation) => structuredClone(operation));
  }
}

export class CompletedLocalWorkspaceOperationError extends Error {
  readonly code: string;
  #deliveryConfirmed = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompletedLocalWorkspaceOperationError";
    this.code = code;
  }

  get deliveryConfirmed(): boolean {
    return this.#deliveryConfirmed;
  }

  markDeliveryConfirmed(): void {
    this.#deliveryConfirmed = true;
  }
}

export class LocalWorkspaceManagementHost {
  readonly #applications: LocalWorkspaceHostApplications;
  readonly #outbox: LocalWorkspaceOperationOutbox;
  readonly #transport: LocalWorkspaceTransportServer;
  #state: LocalWorkspaceHostState | "created" = "created";
  #diagnostic: LocalWorkspaceHostStatus["diagnostic"];
  #outboxReady = false;
  #mutationTail = Promise.resolve();
  #drain: Promise<void> | undefined;
  #recovery: Promise<void> | undefined;
  #retryAbort = new AbortController();
  #attemptAbort: AbortController | undefined;

  constructor(input: {
    readonly lease: LocalWorkspaceOwnerLease;
    readonly applications: LocalWorkspaceHostApplications;
    readonly outbox: LocalWorkspaceOperationOutbox;
  }) {
    this.#applications = input.applications;
    this.#outbox = input.outbox;
    this.#transport = new LocalWorkspaceTransportServer(input.lease, (request) =>
      this.#handle(validateHostRequest(request)),
    );
  }

  async start(): Promise<void> {
    if (this.#state !== "created") return;
    this.#state = "recovering";
    this.#diagnostic = {
      code: "LOCAL_WORKSPACE_RECOVERING",
      message: "Local workspace host is recovering durable operations",
    };
    try {
      await this.#transport.start();
    } catch (error) {
      this.#state = "closed";
      await this.#transport.close().catch(() => undefined);
      throw error;
    }
    await this.#tryInitializeOutbox();
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "created") {
      this.#state = "closed";
      await this.#transport.close();
      return;
    }
    this.#state = "draining";
    this.#diagnostic = {
      code: "LOCAL_WORKSPACE_DRAINING",
      message: "Local workspace host is draining to a durable safe point",
    };
    this.#retryAbort.abort();
    this.#attemptAbort?.abort();
    await this.#transport.unpublish();
    await this.#transport.close();
    await Promise.allSettled([
      this.#drain,
      this.#recovery,
      this.#mutationTail,
    ].filter((value): value is Promise<void> => value !== undefined));
    this.#state = "closed";
    this.#diagnostic = undefined;
  }

  async #handle(request: HostRequest): Promise<unknown> {
    if (this.#state === "created" || this.#state === "closed") {
      throw new Error("Local workspace management host is shutting down");
    }
    if (request.kind === "host-status") return this.#hostStatus();
    if (request.kind === "status") return this.#applications.status();
    if (request.kind === "list") return this.#applications.list();
    if (request.kind === "view") {
      return this.#applications.viewByName(request.displayName);
    }
    this.#requireOutbox();
    if (request.kind === "pending") return this.#outbox.pending(request.afterSeq, PAGE_SIZE);
    if (request.kind === "acknowledge") return this.#outbox.acknowledge(request);
    if (request.kind === "prepare") {
      return this.#serializeMutation(async () => {
        this.#requireWritable();
        if (request.input.kind === "reset") {
          const preview = await this.#applications.previewReset({
            expectedCatalogGeneration:
              request.input.expectedCatalogGeneration,
            impact: request.input.impact,
          });
          return this.#outbox.prepare({ kind: "reset", ...preview });
        }
        return this.#outbox.prepare(request.input);
      });
    }
    const admitted = await this.#serializeMutation(async () => {
      const existing = this.#outbox.operation(request.identity);
      const replay = existing.state === "committed" || existing.state === "completed";
      if (!replay) this.#requireWritable();
      const committed = await this.#outbox.commit(
        request.identity,
        request.confirmation,
      );
      if (committed.state === "completed") {
        return { committed, drain: Promise.resolve() };
      }
      this.#state = "recovering";
      this.#diagnostic = {
        code: "LOCAL_WORKSPACE_COMMITTED_DRAIN",
        message: "Local workspace host is completing a committed operation",
        localSeq: committed.localSeq,
      };
      return { committed, drain: this.#ensureDrain() };
    });
    await admitted.drain;
    const current = this.#outbox.operation(admitted.committed);
    if (current.state === "completed") return current;
    throw this.#stateError();
  }

  async #oldestCommitted(): Promise<LocalWorkspaceOperation | undefined> {
    return this.#outbox.oldestCommitted();
  }

  #ensureDrain(): Promise<void> {
    if (this.#drain) return this.#drain;
    const drain = this.#drainLoop();
    const wrapped = drain.finally(() => {
      if (this.#drain === wrapped) this.#drain = undefined;
    });
    this.#drain = wrapped;
    return wrapped;
  }

  async #drainLoop(): Promise<void> {
    let retryAttempt = 0;
    for (;;) {
      if (this.#state === "draining" || this.#state === "closed") return;
      let operation: LocalWorkspaceOperation | undefined;
      try {
        operation = await this.#oldestCommitted();
      } catch (error) {
        const decision = classifyInfrastructureFailure(error, retryAttempt);
        if (decision.kind === "retry") {
          retryAttempt += 1;
          this.#setDiagnostic(decision);
          if (!(await waitForRetry(decision.delayMs, this.#retryAbort.signal))) return;
          continue;
        }
        this.#degrade(decision);
        return;
      }
      if (!operation) {
        this.#state = "ready";
        this.#diagnostic = undefined;
        return;
      }
      const decision = await this.#executeDecision(operation, retryAttempt);
      if (decision.kind === "retry") {
        retryAttempt += 1;
        this.#setDiagnostic(decision, operation.localSeq);
        if (!(await waitForRetry(decision.delayMs, this.#retryAbort.signal))) return;
        continue;
      }
      if (decision.kind === "degraded") {
        this.#degrade(decision, operation.localSeq);
        return;
      }
      try {
        await this.#outbox.complete(operation, decision.result);
        retryAttempt = 0;
      } catch (error) {
        const completion = classifyInfrastructureFailure(error, retryAttempt);
        if (completion.kind === "retry") {
          retryAttempt += 1;
          this.#setDiagnostic(completion, operation.localSeq);
          if (!(await waitForRetry(completion.delayMs, this.#retryAbort.signal))) return;
          continue;
        }
        this.#degrade(completion, operation.localSeq);
        return;
      }
    }
  }

  async #executeDecision(
    operation: LocalWorkspaceOperation,
    retryAttempt: number,
  ): Promise<OperationDecision> {
    const abort = new AbortController();
    this.#attemptAbort = abort;
    try {
      return {
        kind: "completed",
        result: { ok: true, value: (await this.#execute(operation, abort.signal)) ?? null },
      };
    } catch (error) {
      return classifyExecutionFailure(error, retryAttempt);
    } finally {
      if (this.#attemptAbort === abort) this.#attemptAbort = undefined;
    }
  }

  async #execute(
    operation: LocalWorkspaceOperation,
    abort: AbortSignal,
  ): Promise<unknown> {
    const execution = {
      operation: {
        outboxId: this.#outbox.outboxId,
        localSeq: operation.localSeq,
        operationId: operation.operationId,
        inputDigest: operation.inputDigest,
      },
      abort,
    };
    const input = operation.input;
    switch (input.kind) {
      case "create":
        return input.purpose === "control"
          ? this.#applications.authorizeForControl(
              { displayName: input.displayName, absolutePath: input.absolutePath },
              execution,
            )
          : this.#applications.create(
              { displayName: input.displayName, absolutePath: input.absolutePath },
              execution,
            );
      case "rename":
        return this.#applications.rename(
          {
            currentName: input.currentName,
            displayName: input.displayName,
            expectedRevision: input.expectedRevision,
          },
          execution,
        );
      case "repath":
        return this.#applications.repath(
          {
            name: input.name,
            absolutePath: input.absolutePath,
            expectedRevision: input.expectedRevision,
          },
          execution,
        );
      case "remove":
        await this.#applications.remove(
          { name: input.name, expectedRevision: input.expectedRevision },
          execution,
        );
        return null;
      case "reset": {
        return this.#applications.reset(
          {
            expectedCatalogGeneration: input.expectedCatalogGeneration,
            confirmedImpact: input.impact,
          },
          {
            operation: execution.operation,
            abort,
            confirmationIssuedAt: operation.preparedAt,
            ...(operation.confirmationToken
              ? { confirmationToken: operation.confirmationToken }
              : {}),
          },
        );
      }
    }
  }

  async #tryInitializeOutbox(): Promise<void> {
    try {
      await this.#outbox.initialize();
      this.#outboxReady = true;
      const committed = await this.#oldestCommitted();
      if (!committed) {
        this.#state = "ready";
        this.#diagnostic = undefined;
        return;
      }
      this.#state = "recovering";
      this.#diagnostic = {
        code: "LOCAL_WORKSPACE_RECOVERING_COMMITTED",
        message: "Local workspace host is recovering committed operations",
        localSeq: committed.localSeq,
      };
      void this.#ensureDrain();
    } catch (error) {
      const decision = classifyInfrastructureFailure(error, 0);
      if (decision.kind === "retry") {
        this.#setDiagnostic(decision);
        this.#scheduleOutboxRecovery(decision.delayMs);
      } else {
        this.#degrade(decision);
      }
    }
  }

  #scheduleOutboxRecovery(initialDelayMs: number): void {
    if (this.#recovery) return;
    const recovery = (async () => {
      let attempt = 1;
      let delayMs = initialDelayMs;
      while (this.#state === "recovering" && !this.#outboxReady) {
        if (!(await waitForRetry(delayMs, this.#retryAbort.signal))) return;
        try {
          await this.#outbox.initialize();
          this.#outboxReady = true;
          void this.#ensureDrain();
          return;
        } catch (error) {
          const decision = classifyInfrastructureFailure(error, attempt);
          if (decision.kind !== "retry") {
            this.#degrade(decision);
            return;
          }
          attempt += 1;
          delayMs = decision.delayMs;
          this.#setDiagnostic(decision);
        }
      }
    })();
    const wrapped = recovery.finally(() => {
      if (this.#recovery === wrapped) this.#recovery = undefined;
    });
    this.#recovery = wrapped;
  }

  #hostStatus(): LocalWorkspaceHostStatus {
    const state = this.#state === "created" ? "recovering" : this.#state;
    return {
      state,
      ...(this.#diagnostic ? { diagnostic: { ...this.#diagnostic } } : {}),
    };
  }

  #setDiagnostic(
    decision: RetryDecision,
    localSeq?: number,
  ): void {
    if (this.#state !== "draining" && this.#state !== "closed") this.#state = "recovering";
    this.#diagnostic = {
      code: decision.code,
      message: decision.message,
      ...(localSeq === undefined ? {} : { localSeq }),
    };
  }

  #degrade(
    decision: DegradedDecision,
    localSeq?: number,
  ): void {
    if (this.#state === "draining" || this.#state === "closed") return;
    this.#state = "degraded";
    this.#diagnostic = {
      code: decision.code,
      message: decision.message,
      ...(localSeq === undefined ? {} : { localSeq }),
    };
  }

  #requireOutbox(): void {
    if (!this.#outboxReady) throw this.#stateError();
  }

  #requireWritable(): void {
    if (this.#state !== "ready") throw this.#stateError();
  }

  #stateError(): Error & { code: string } {
    const error = new Error(
      this.#diagnostic?.message ?? "Local workspace management host is not ready",
    ) as Error & { code: string };
    error.code = this.#diagnostic?.code ?? "LOCAL_WORKSPACE_HOST_NOT_READY";
    return error;
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function classifyExecutionFailure(
  error: unknown,
  attempt: number,
): OperationDecision {
  if (
    error instanceof WorkspaceAdministrationBusinessError ||
    error instanceof WorkspaceBindingNotFoundError ||
    error instanceof WorkspaceBindingConflictError ||
    error instanceof WorkspaceBindingRevisionError ||
    error instanceof WorkspaceBindingCatalogConflictError
  ) {
    return {
      kind: "completed",
      result: {
        ok: false,
        error: {
          code: stableErrorCode(error),
          message: error.message,
        },
      },
    };
  }
  return classifyInfrastructureFailure(error, attempt);
}

function classifyInfrastructureFailure(
  error: unknown,
  attempt: number,
): InfrastructureDecision {
  const message = error instanceof Error
    ? error.message
    : "Local workspace operation failed";
  const code = stableErrorCode(error);
  const retryAfterMs = retryDelayFrom(error);
  if (retryAfterMs !== undefined) {
    return {
      kind: "retry",
      code,
      message,
      delayMs: Math.min(2_000, Math.max(retryAfterMs, retryBackoffMs(attempt))),
    };
  }
  return { kind: "degraded", code, message };
}

function retryDelayFrom(error: unknown): number | undefined {
  if (
    error instanceof ExecutorResourceBackpressureError ||
    error instanceof ExecutorResourceAdmissionPendingError ||
    error instanceof ExecutorResourceAdmissionExpiredError ||
    error instanceof WorkspaceBindingCancelledError ||
    error instanceof StorageMaintenanceCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return 0;
  }
  if (error instanceof DeviceCapacityAdmissionError) {
    return "retryAfterMs" in error.admission &&
        typeof error.admission.retryAfterMs === "number"
      ? error.admission.retryAfterMs
      : 0;
  }
  if (error instanceof StorageMaintenanceAdmissionError) {
    return "retryAfterMs" in error.admission &&
        typeof error.admission.retryAfterMs === "number"
      ? error.admission.retryAfterMs
      : 0;
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EAGAIN" ||
      code === "EBUSY" ||
      code === "EINTR" ||
      code === "EMFILE" ||
      code === "ENFILE" ||
      code === "ENOSPC" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET"
    ) {
      return 0;
    }
  }
  return undefined;
}

function retryBackoffMs(attempt: number): number {
  return Math.min(2_000, 50 * 2 ** Math.min(attempt, 5));
}

function waitForRetry(delayMs: number, abort: AbortSignal): Promise<boolean> {
  if (abort.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      abort.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    abort.addEventListener("abort", onAbort, { once: true });
  });
}

export function createLocalWorkspaceManagementHost(input: {
  readonly lease: LocalWorkspaceOwnerLease;
  readonly zhixingHome: string;
  readonly management: {
    readonly deviceId: string;
    readonly executorId: string;
    readonly admin: import("@zhixing/core/contracts").WorkspaceBindingAdminPort;
    readonly recovery: import("@zhixing/core/contracts").WorkspaceBindingRecoveryPort;
    readonly resources: import("@zhixing/executor").ExecutorResourceGovernor;
  };
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}): LocalWorkspaceManagementHost {
  const control = new ExecutorWorkspaceAdministrationControl({
    executorId: input.management.executorId,
    resources: input.management.resources,
  });
  const workspace = new WorkspaceAdministrationApplicationService({
    deviceId: input.management.deviceId,
    admin: input.management.admin,
    recovery: input.management.recovery,
    control,
  });
  return new LocalWorkspaceManagementHost({
    lease: input.lease,
    applications: {
      list: () => workspace.list(),
      viewByName: (displayName) => workspace.viewByName(displayName),
      create: (command, execution) => workspace.create(command, execution),
      authorizeForControl: (command, execution) =>
        workspace.authorizeForControl(command, execution),
      rename: (command, execution) => workspace.rename(command, execution),
      repath: (command, execution) => workspace.repath(command, execution),
      remove: (command, execution) => workspace.remove(command, execution),
      status: () => workspace.status(),
      previewReset: (command) => workspace.previewReset(command),
      reset: (command, execution) => workspace.reset(command, execution),
    },
    outbox: new LocalWorkspaceOperationOutbox({
      rootDir: path.join(
        input.zhixingHome,
        "runtime",
        "local-workspace-operation-outbox",
      ),
      storageMaintenance: input.storageMaintenance,
    }),
  });
}

export function createLocalWorkspaceClient(zhixingHome: string): LocalWorkspaceClient {
  let pendingDelivery: PendingDelivery | undefined;
  let currentResult: LocalWorkspaceOperation | undefined;
  const recover = async (): Promise<PendingDelivery> => {
    pendingDelivery = await readPendingDelivery(zhixingHome);
    return pendingDelivery;
  };
  const read = (kind: "status" | "list") => async (): Promise<unknown> => {
    currentResult = undefined;
    const lifecycle = await readLocalWorkspaceHostStatus(zhixingHome);
    if (lifecycle.state !== "ready") {
      const result = await callLocalWorkspaceHost(zhixingHome, { kind });
      return kind === "status" ? validateStatus(result) : validateWorkspaceList(result);
    }
    const recovered = await recover();
    reportUnclaimedResults(recovered.outboxId, recovered.operations);
    const result = await callLocalWorkspaceHost(zhixingHome, { kind });
    return kind === "status" ? validateStatus(result) : validateWorkspaceList(result);
  };
  const viewByName = async (
    displayName: string,
  ): Promise<WorkspaceAdministrationView> => {
    const claimed = consumptionCredentialOf(pendingDelivery, currentResult);
    const lifecycle = await readLocalWorkspaceHostStatus(zhixingHome);
    if (lifecycle.state === "ready") {
      const recovered = await recover();
      reportUnclaimedResults(
        recovered.outboxId,
        claimed && recovered.outboxId === claimed.outboxId
          ? recovered.operations.filter(
              (operation) => !matchesConsumptionCredential(operation, claimed),
            )
          : recovered.operations,
      );
    }
    return validateWorkspaceView(
      await callLocalWorkspaceHost(zhixingHome, {
        kind: "view",
        displayName,
      }),
    );
  };
  const write = (
    input: LocalWorkspaceWriteOperation,
    confirmation?: { readonly impact: string },
  ) => execute(zhixingHome, input, recover, confirmation).then((completed) => {
    currentResult = completed.operation;
    return resultValue(input, completed.result);
  });
  return {
    status: read("status") as () => Promise<LocalWorkspaceCatalogStatus>,
    list: read("list") as () => Promise<readonly WorkspaceAdministrationView[]>,
    viewByName,
    create: (displayName, absolutePath) => write({ kind: "create", purpose: "settings", displayName, absolutePath }) as Promise<WorkspaceAdministrationView>,
    authorizeForControl: async (displayName, absolutePath) => {
      return write({
        kind: "create",
        purpose: "control",
        displayName,
        absolutePath,
      }) as Promise<WorkspaceControlAuthorization>;
    },
    rename: (currentName, displayName, expectedRevision) =>
      write({ kind: "rename", currentName, displayName, expectedRevision }) as Promise<WorkspaceAdministrationView>,
    repath: (name, absolutePath, expectedRevision) =>
      write({ kind: "repath", name, absolutePath, expectedRevision }) as Promise<WorkspaceAdministrationView>,
    remove: async (name, expectedRevision) => {
      await write({ kind: "remove", name, expectedRevision });
    },
    previewReset: async (expectedCatalogGeneration) => {
      currentResult = undefined;
      const input = validateLocalWorkspaceWriteOperation({
        kind: "reset",
        expectedCatalogGeneration,
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      });
      const recovered = await recover();
      reportUnclaimedResults(recovered.outboxId, recovered.operations);
      const prepared = validateLocalWorkspaceOperation(
        await callLocalWorkspaceHost(zhixingHome, { kind: "prepare", input }),
      );
      return resetPreviewOf(prepared);
    },
    confirmReset: async (preview, confirmedImpact) => {
      validateResetPreview(preview);
      if (confirmedImpact !== preview.impact) {
        throw new TypeError("工作区目录恢复确认内容不完整");
      }
      const input = validateLocalWorkspaceWriteOperation({
        kind: "reset",
        expectedCatalogGeneration: preview.expectedCatalogGeneration,
        impact: preview.impact,
      });
      const recovered = await recover();
      const claimed = recovered.operations.find(
        (operation) =>
          operation.state === "completed" &&
          operation.localSeq === preview.localSeq &&
          operation.operationId === preview.operationId &&
          operation.inputDigest === preview.inputDigest,
      );
      reportUnclaimedResults(
        recovered.outboxId,
        claimed
          ? recovered.operations.filter(
              (operation) => operation.operationId !== claimed.operationId,
            )
          : recovered.operations,
      );
      if (claimed) {
        currentResult = claimed;
        return resultValue(input, validateOperationResult(claimed.result)) as WorkspaceBindingResetReceipt;
      }
      const completed = validateLocalWorkspaceOperation(
        await callLocalWorkspaceHost(zhixingHome, {
          kind: "commit",
          identity: {
            localSeq: preview.localSeq,
            operationId: preview.operationId,
            inputDigest: preview.inputDigest,
          },
          confirmation: { impact: confirmedImpact },
        }),
      );
      const result = validateOperationResult(completed.result);
      await recover();
      currentResult = completed;
      return resultValue(input, result) as WorkspaceBindingResetReceipt;
    },
    consumptionCredential: () => {
      return consumptionCredentialOf(pendingDelivery, currentResult);
    },
    confirmDelivered: async () => {
      const delivery = pendingDelivery;
      if (!delivery || delivery.operations.length === 0) return;
      await acknowledgeDelivery(zhixingHome, delivery);
      pendingDelivery = undefined;
      currentResult = undefined;
    },
  };
}

function consumptionCredentialOf(
  delivery: PendingDelivery | undefined,
  operation: LocalWorkspaceOperation | undefined,
): LocalWorkspaceConsumptionCredential | undefined {
  if (!delivery || !operation?.resultDigest) return undefined;
  const credential = {
    outboxId: delivery.outboxId,
    ...identityOf(operation),
    resultDigest: operation.resultDigest,
  };
  if (
    !delivery.operations.some((candidate) =>
      matchesConsumptionCredential(candidate, credential),
    )
  ) {
    throw new Error(
      "Local workspace result is not part of the recoverable delivery prefix",
    );
  }
  return credential;
}

function matchesConsumptionCredential(
  operation: LocalWorkspaceOperation,
  credential: LocalWorkspaceConsumptionCredential,
): boolean {
  return (
    operation.localSeq === credential.localSeq &&
    operation.operationId === credential.operationId &&
    operation.inputDigest === credential.inputDigest &&
    operation.resultDigest === credential.resultDigest
  );
}

export async function localWorkspaceHostIsReachable(zhixingHome: string): Promise<boolean> {
  try {
    validateHostStatus(
      await callLocalWorkspaceHost(zhixingHome, { kind: "host-status" }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function readLocalWorkspaceHostStatus(
  zhixingHome: string,
): Promise<LocalWorkspaceHostStatus> {
  return validateHostStatus(
    await callLocalWorkspaceHost(zhixingHome, { kind: "host-status" }),
  );
}

async function execute(
  zhixingHome: string,
  input: LocalWorkspaceWriteOperation,
  recover: () => Promise<PendingDelivery>,
  confirmation?: { readonly impact: string },
): Promise<{ readonly result: OperationResult; readonly operation: LocalWorkspaceOperation }> {
  const normalized = validateLocalWorkspaceWriteOperation(input);
  const inputDigest = protocolDigest("LocalWorkspaceOperationInput", 1, normalized);
  const recovered = await recover();
  const claimed = recovered.operations.find(
    (operation) => operation.state === "completed" && operation.inputDigest === inputDigest,
  );
  reportUnclaimedResults(
    recovered.outboxId,
    claimed
      ? recovered.operations.filter(
          (operation) => operation.operationId !== claimed.operationId,
        )
      : recovered.operations,
  );
  if (claimed) {
    return {
      result: validateOperationResult(claimed.result),
      operation: claimed,
    };
  }

  const prepared = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(zhixingHome, { kind: "prepare", input: normalized }));
  const completed = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(zhixingHome, {
    kind: "commit",
    identity: identityOf(prepared),
    ...(confirmation ? { confirmation } : {}),
  }));
  const result = validateOperationResult(completed.result);
  await recover();
  return { result, operation: completed };
}

function resultValue(input: LocalWorkspaceWriteOperation, result: OperationResult): unknown {
  if (!result.ok) {
    throw new CompletedLocalWorkspaceOperationError(
      result.error?.code ?? "LOCAL_WORKSPACE_OPERATION_FAILED",
      result.error?.message ?? "Local workspace operation failed",
    );
  }
  return validateOperationValue(input, result.value);
}

function validateOperationResult(value: unknown): OperationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Local workspace operation result is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) {
    const record = exactRecord(value, ["ok", "value"], "operation result");
    return { ok: true, value: record.value };
  }
  if (candidate.ok === false) {
    const record = exactRecord(value, ["error", "ok"], "operation result");
    const error = exactRecord(record.error, ["code", "message"], "operation error");
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      throw new TypeError("Local workspace operation error is invalid");
    }
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  throw new TypeError("Local workspace operation result is invalid");
}

interface PendingDelivery {
  readonly outboxId: string;
  readonly confirmation: { readonly throughSeq: number; readonly prefixDigest: string };
  readonly operations: readonly LocalWorkspaceOperation[];
}

async function readPendingDelivery(zhixingHome: string): Promise<PendingDelivery> {
  let afterSeq = 0;
  let outboxId: string | undefined;
  let confirmation: { throughSeq: number; prefixDigest: string } | undefined;
  const terminal: LocalWorkspaceOperation[] = [];
  for (;;) {
    const page = validatePendingPage(await callLocalWorkspaceHost(zhixingHome, {
      kind: "pending",
      afterSeq,
    }));
    outboxId ??= page.outboxId;
    if (outboxId !== page.outboxId) {
      throw new Error("Local workspace outbox identity changed during delivery recovery");
    }
    confirmation ??= page.confirmation;
    for (const operation of page.operations) {
      if (operation.localSeq !== (terminal.at(-1)?.localSeq ?? confirmation.throughSeq) + 1) break;
      if ((operation.state !== "completed" && operation.state !== "abandoned") || !operation.resultDigest) break;
      terminal.push(operation);
    }
    if (page.next === undefined) break;
    afterSeq = page.next;
  }
  if (!confirmation || terminal.length === 0) {
    return {
      outboxId: outboxId ?? "",
      confirmation: confirmation ?? {
        throughSeq: 0,
        prefixDigest: protocolDigest("LocalWorkspaceOperationPrefix", 1, null),
      },
      operations: [],
    };
  }
  return { outboxId: outboxId!, confirmation, operations: terminal };
}

async function acknowledgeDelivery(
  zhixingHome: string,
  delivery: PendingDelivery,
): Promise<void> {
  const { confirmation, operations: terminal } = delivery;
  let prefixDigest = confirmation.prefixDigest;
  const entries: ConfirmationEntry[] = terminal.map((operation) => {
    const entry = { ...identityOf(operation), resultDigest: operation.resultDigest! };
    prefixDigest = protocolDigest("LocalWorkspaceOperationPrefix", 1, {
      previous: prefixDigest,
      ...entry,
    });
    return entry;
  });
  const receipt = validateAcknowledgmentReceipt(await callLocalWorkspaceHost(zhixingHome, {
    kind: "acknowledge",
    outboxId: delivery.outboxId,
    throughSeq: terminal.at(-1)!.localSeq,
    prefixDigest,
    entries,
  }));
  if (
    receipt.outboxId !== delivery.outboxId ||
    receipt.throughSeq !== terminal.at(-1)!.localSeq ||
    receipt.prefixDigest !== prefixDigest
  ) {
    throw new Error("Local workspace acknowledgment receipt is bound to another delivery");
  }
}

function resetPreviewOf(operation: LocalWorkspaceOperation): LocalWorkspaceResetPreview {
  if (operation.input.kind !== "reset" || !operation.expiresAt) {
    throw new TypeError("Local workspace reset preview is invalid");
  }
  return {
    ...identityOf(operation),
    expectedCatalogGeneration: operation.input.expectedCatalogGeneration,
    impact: operation.input.impact,
    expiresAt: operation.expiresAt,
  };
}

function validateResetPreview(value: LocalWorkspaceResetPreview): void {
  if (
    !Number.isSafeInteger(value.localSeq) ||
    value.localSeq < 1 ||
    typeof value.operationId !== "string" ||
    typeof value.inputDigest !== "string" ||
    typeof value.expectedCatalogGeneration !== "string" ||
    value.expectedCatalogGeneration.length === 0 ||
    value.impact !== WORKSPACE_CATALOG_RESET_IMPACT ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new TypeError("Local workspace reset preview is invalid");
  }
}

function reportUnclaimedResults(
  outboxId: string,
  operations: readonly LocalWorkspaceOperation[],
): void {
  const completed = operations.filter((operation) => operation.state === "completed");
  if (completed.length > 0) {
    throw new RecoveredLocalWorkspaceOperationsError(outboxId, completed);
  }
}

function identityOf(operation: LocalWorkspaceOperation): OperationIdentity {
  return {
    localSeq: operation.localSeq,
    operationId: operation.operationId,
    inputDigest: operation.inputDigest,
  };
}

function validateHostRequest(value: unknown): HostRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Local workspace host request is invalid");
  const request = value as Record<string, unknown>;
  const allowed: Record<string, readonly string[]> = {
    "host-status": ["kind"],
    status: ["kind"],
    list: ["kind"],
    view: ["displayName", "kind"],
    prepare: ["input", "kind"],
    commit: "confirmation" in request
      ? ["confirmation", "identity", "kind"]
      : ["identity", "kind"],
    pending: ["afterSeq", "kind"],
    acknowledge: ["entries", "kind", "outboxId", "prefixDigest", "throughSeq"],
  };
  if (typeof request.kind !== "string" || !(request.kind in allowed)) throw new TypeError("Local workspace host request kind is invalid");
  if (Object.keys(request).sort().join(",") !== [...allowed[request.kind]!].sort().join(",")) {
    throw new TypeError("Local workspace host request fields are invalid");
  }
  switch (request.kind) {
    case "host-status":
    case "status":
    case "list":
      return { kind: request.kind };
    case "view":
      if (
        typeof request.displayName !== "string" ||
        request.displayName.length === 0 ||
        request.displayName.length > 4096 ||
        request.displayName.includes("\0")
      ) {
        throw new TypeError("Local workspace view name is invalid");
      }
      return { kind: "view", displayName: request.displayName };
    case "prepare":
      return { kind: "prepare", input: validateLocalWorkspaceWriteOperation(request.input) };
    case "commit": {
      const confirmation = request.confirmation === undefined
        ? undefined
        : exactRecord(request.confirmation, ["impact"], "operation confirmation");
      if (
        confirmation !== undefined &&
        confirmation.impact !== WORKSPACE_CATALOG_RESET_IMPACT
      ) {
        throw new TypeError("Local workspace reset confirmation is invalid");
      }
      return {
        kind: "commit",
        identity: validateIdentity(request.identity),
        ...(confirmation
          ? { confirmation: { impact: confirmation.impact as string } }
          : {}),
      };
    }
    case "pending":
      if (!Number.isSafeInteger(request.afterSeq) || (request.afterSeq as number) < 0) {
        throw new TypeError("Local workspace pending cursor is invalid");
      }
      return { kind: "pending", afterSeq: request.afterSeq as number };
    case "acknowledge": {
      if (
        typeof request.outboxId !== "string" ||
        !/^outbox-[A-Za-z0-9_-]{32}$/u.test(request.outboxId) ||
        !Number.isSafeInteger(request.throughSeq) ||
        (request.throughSeq as number) < 1 ||
        typeof request.prefixDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(request.prefixDigest) ||
        !Array.isArray(request.entries)
      ) {
        throw new TypeError("Local workspace acknowledgment is invalid");
      }
      return {
        kind: "acknowledge",
        outboxId: request.outboxId,
        throughSeq: request.throughSeq as number,
        prefixDigest: request.prefixDigest,
        entries: request.entries.map(validateConfirmationEntry),
      };
    }
  }
  throw new TypeError("Local workspace host request kind is invalid");
}

function validateHostStatus(value: unknown): LocalWorkspaceHostStatus {
  const record = exactRecord(
    value,
    value && typeof value === "object" && "diagnostic" in value
      ? ["diagnostic", "state"]
      : ["state"],
    "host status",
  );
  if (
    record.state !== "recovering" &&
    record.state !== "ready" &&
    record.state !== "degraded" &&
    record.state !== "draining" &&
    record.state !== "closed"
  ) {
    throw new TypeError("Local workspace host state is invalid");
  }
  if (record.diagnostic !== undefined) {
    const diagnostic = exactRecord(
      record.diagnostic,
      record.diagnostic &&
          typeof record.diagnostic === "object" &&
          "localSeq" in record.diagnostic
        ? ["code", "localSeq", "message"]
        : ["code", "message"],
      "host diagnostic",
    );
    if (
      typeof diagnostic.code !== "string" ||
      typeof diagnostic.message !== "string" ||
      (diagnostic.localSeq !== undefined &&
        (!Number.isSafeInteger(diagnostic.localSeq) ||
          (diagnostic.localSeq as number) < 1))
    ) {
      throw new TypeError("Local workspace host diagnostic is invalid");
    }
  }
  return structuredClone(value) as LocalWorkspaceHostStatus;
}

function validateAcknowledgmentReceipt(value: unknown): {
  readonly outboxId: string;
  readonly throughSeq: number;
  readonly prefixDigest: string;
} {
  const record = exactRecord(
    value,
    ["outboxId", "prefixDigest", "throughSeq"],
    "acknowledgment receipt",
  );
  if (
    typeof record.outboxId !== "string" ||
    !/^outbox-[A-Za-z0-9_-]{32}$/u.test(record.outboxId) ||
    !Number.isSafeInteger(record.throughSeq) ||
    (record.throughSeq as number) < 1 ||
    typeof record.prefixDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.prefixDigest)
  ) {
    throw new TypeError("Local workspace acknowledgment receipt is invalid");
  }
  return record as {
    readonly outboxId: string;
    readonly throughSeq: number;
    readonly prefixDigest: string;
  };
}

function validateIdentity(value: unknown): OperationIdentity {
  const record = exactRecord(value, ["inputDigest", "localSeq", "operationId"], "operation identity");
  if (
    !Number.isSafeInteger(record.localSeq) ||
    (record.localSeq as number) < 1 ||
    typeof record.operationId !== "string" ||
    !record.operationId.startsWith("workspace-operation-") ||
    typeof record.inputDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.inputDigest)
  ) {
    throw new TypeError("Local workspace operation identity is invalid");
  }
  return record as unknown as OperationIdentity;
}

function validateConfirmationEntry(value: unknown): ConfirmationEntry {
  const record = exactRecord(
    value,
    ["inputDigest", "localSeq", "operationId", "resultDigest"],
    "confirmation entry",
  );
  const identity = validateIdentity({
    localSeq: record.localSeq,
    operationId: record.operationId,
    inputDigest: record.inputDigest,
  });
  if (typeof record.resultDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.resultDigest)) {
    throw new TypeError("Local workspace confirmation result digest is invalid");
  }
  return { ...identity, resultDigest: record.resultDigest };
}

function validatePendingPage(value: unknown): {
  outboxId: string;
  operations: LocalWorkspaceOperation[];
  next?: number;
  confirmation: { throughSeq: number; prefixDigest: string };
} {
  const record = exactRecord(
    value,
    value && typeof value === "object" && "next" in value
      ? ["confirmation", "next", "operations", "outboxId"]
      : ["confirmation", "operations", "outboxId"],
    "pending page",
  );
  if (!Array.isArray(record.operations)) throw new TypeError("Local workspace pending operations are invalid");
  const confirmation = exactRecord(record.confirmation, ["prefixDigest", "throughSeq"], "confirmation watermark");
  if (
    !Number.isSafeInteger(confirmation.throughSeq) ||
    (confirmation.throughSeq as number) < 0 ||
    typeof confirmation.prefixDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(confirmation.prefixDigest) ||
    (record.next !== undefined && (!Number.isSafeInteger(record.next) || (record.next as number) < 1)) ||
    typeof record.outboxId !== "string" ||
    !/^outbox-[A-Za-z0-9_-]{32}$/u.test(record.outboxId)
  ) {
    throw new TypeError("Local workspace pending page is invalid");
  }
  return {
    outboxId: record.outboxId as string,
    operations: record.operations.map(validateLocalWorkspaceOperation),
    ...(record.next === undefined ? {} : { next: record.next as number }),
    confirmation: {
      throughSeq: confirmation.throughSeq as number,
      prefixDigest: confirmation.prefixDigest,
    },
  };
}

function validateStatus(value: unknown): LocalWorkspaceCatalogStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Local workspace catalog status is invalid");
  }
  const exact = value as Record<string, unknown>;
  const allowed = new Set(["catalogGeneration", "reason", "resetImpact", "state"]);
  if (
    Object.keys(exact).some((key) => !allowed.has(key)) ||
    (exact.state !== "healthy" && exact.state !== "degraded") ||
    typeof exact.catalogGeneration !== "string" ||
    (exact.reason !== undefined && typeof exact.reason !== "string") ||
    (exact.state === "degraded" && typeof exact.resetImpact !== "string") ||
    (exact.state === "healthy" && (exact.reason !== undefined || exact.resetImpact !== undefined))
  ) throw new TypeError("Local workspace catalog status is invalid");
  return exact as unknown as LocalWorkspaceCatalogStatus;
}

function validateWorkspaceList(value: unknown): WorkspaceAdministrationView[] {
  if (!Array.isArray(value)) throw new TypeError("Local workspace list is invalid");
  return value.map((item) => {
    const record = exactRecord(item, ["name", "path", "revision", "workspaceBindingRevision"], "workspace view");
    if (
      typeof record.name !== "string" ||
      typeof record.path !== "string" ||
      !Number.isSafeInteger(record.revision) ||
      !Number.isSafeInteger(record.workspaceBindingRevision)
    ) throw new TypeError("Local workspace view is invalid");
    return record as unknown as WorkspaceAdministrationView;
  });
}

function validateOperationValue(
  input: LocalWorkspaceWriteOperation,
  value: unknown,
): unknown {
  if (input.kind === "remove") {
    if (value !== null) throw new TypeError("Local workspace remove result is invalid");
    return null;
  }
  if (input.kind === "create" && input.purpose === "control") {
    return validateWorkspaceControlAuthorization(value);
  }
  if (input.kind === "reset") {
    const record = exactRecord(
      value,
      [
        "capabilityRevision",
        "catalogGeneration",
        "confirmationDigest",
        "logId",
        "preparedAt",
        "previousCatalogGeneration",
        "requestId",
      ],
      "reset receipt",
    );
    if (
      typeof record.requestId !== "string" ||
      typeof record.confirmationDigest !== "string" ||
      typeof record.previousCatalogGeneration !== "string" ||
      typeof record.catalogGeneration !== "string" ||
      typeof record.logId !== "string" ||
      !Number.isSafeInteger(record.capabilityRevision) ||
      typeof record.preparedAt !== "string"
    ) throw new TypeError("Local workspace reset receipt is invalid");
    return record;
  }
  return validateWorkspaceList([value])[0]!;
}

function validateWorkspaceView(value: unknown): WorkspaceAdministrationView {
  return validateWorkspaceList([value])[0]!;
}

export function validateWorkspaceControlAuthorization(
  value: unknown,
): WorkspaceControlAuthorization {
  const record = exactRecord(
    value,
    ["bindingRef", "deviceId"],
    "control authorization",
  );
  if (
    typeof record.bindingRef !== "string" ||
    typeof record.deviceId !== "string"
  ) {
    throw new TypeError("Local workspace control authorization is invalid");
  }
  return record as unknown as WorkspaceControlAuthorization;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Local workspace ${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError(`Local workspace ${label} fields are invalid`);
  }
  return record;
}

function stableErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  if (error instanceof WorkspaceBindingNotFoundError) return "WORKSPACE_BINDING_NOT_FOUND";
  if (error instanceof WorkspaceBindingConflictError) return "WORKSPACE_BINDING_CONFLICT";
  if (error instanceof WorkspaceBindingRevisionError) return "WORKSPACE_BINDING_REVISION";
  if (error instanceof WorkspaceBindingCancelledError) return "WORKSPACE_BINDING_CANCELLED";
  if (error instanceof DeviceCapacityAdmissionError) return "DEVICE_CAPACITY_NOT_ADMITTED";
  if (error instanceof StorageMaintenanceAdmissionError) return "STORAGE_MAINTENANCE_NOT_ADMITTED";
  if (error instanceof StorageMaintenanceCancelledError) return "STORAGE_MAINTENANCE_CANCELLED";
  if (error instanceof ExecutorResourceBackpressureError) return "EXECUTOR_RESOURCE_BACKPRESSURE";
  if (error instanceof ExecutorResourceAdmissionPendingError) return "EXECUTOR_RESOURCE_ADMISSION_PENDING";
  if (error instanceof ExecutorResourceAdmissionExpiredError) return "EXECUTOR_RESOURCE_ADMISSION_EXPIRED";
  if (error instanceof Error && error.name === "AbortError") return "LOCAL_WORKSPACE_OPERATION_CANCELLED";
  return "LOCAL_WORKSPACE_OPERATION_FAILED";
}
