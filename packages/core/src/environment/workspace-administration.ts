import { randomBytes, randomUUID } from "node:crypto";
import { protocolDigest } from "../protocol/canonical.js";
import type {
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
  WorkspaceBindingRecoveryPort,
  WorkspaceBindingResetReceipt,
} from "../contracts/ports.js";
import { WorkspaceBindingCatalogConflictError } from "./workspace-binding-catalog.js";
import {
  WorkspaceBindingConflictError,
  WorkspaceBindingNotFoundError,
  WorkspaceBindingRevisionError,
} from "./workspace-bindings.js";
import { localEnvironmentControlSubject } from "./workspace-bindings.js";

export const WORKSPACE_CATALOG_RESET_IMPACT =
  "将撤回本机全部工作区能力；旧工作区引用立即失效，所有目录都需要逐项重新授权。";

export interface WorkspaceAdministrationView {
  readonly name: string;
  readonly path: string;
  readonly revision: number;
  readonly workspaceBindingRevision: number;
}

export interface WorkspaceControlAuthorization {
  readonly deviceId: string;
  readonly bindingRef: string;
}

export interface WorkspaceAdministrationOperationIdentity {
  readonly outboxId: string;
  readonly localSeq: number;
  readonly operationId: string;
  readonly inputDigest: string;
}

export interface WorkspaceAdministrationExecution {
  readonly operation?: WorkspaceAdministrationOperationIdentity;
  readonly abort?: AbortSignal;
}

export interface WorkspaceAdministrationResetExecution
  extends WorkspaceAdministrationExecution {
  readonly confirmationToken?: string;
  readonly confirmationIssuedAt?: string;
}

export type WorkspaceAdministrationDurableOperation =
  | {
      readonly kind: "create";
      readonly purpose: "settings" | "control";
      readonly displayName: string;
      readonly absolutePath: string;
    }
  | {
      readonly kind: "rename";
      readonly currentName: string;
      readonly displayName: string;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "repath";
      readonly name: string;
      readonly absolutePath: string;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "remove";
      readonly name: string;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "reset";
      readonly expectedCatalogGeneration: string;
      readonly impact: string;
    };

export interface WorkspaceAdministrationDurableExecution {
  readonly operation: WorkspaceAdministrationOperationIdentity;
  readonly abort: AbortSignal;
  readonly preparedAt: string;
  readonly confirmationToken?: string;
}

export type WorkspaceAdministrationDurableResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface WorkspaceAdministrationDurableOperationKey {
  readonly localSeq: number;
  readonly operationId: string;
  readonly inputDigest: string;
}

export type WorkspaceAdministrationDurableOperationState =
  | "prepared"
  | "committed"
  | "completed"
  | "abandoned";

export interface WorkspaceAdministrationDurableOperationRecord
  extends WorkspaceAdministrationDurableOperationKey {
  readonly input: WorkspaceAdministrationDurableOperation;
  readonly state: WorkspaceAdministrationDurableOperationState;
  readonly preparedAt: string;
  readonly expiresAt?: string;
  readonly confirmationToken?: string;
  readonly result?: unknown;
  readonly resultDigest?: string;
}

export interface WorkspaceAdministrationDeliveryConfirmationEntry
  extends WorkspaceAdministrationDurableOperationKey {
  readonly resultDigest: string;
}

export interface WorkspaceAdministrationPendingDeliveryPage {
  readonly outboxId: string;
  readonly operations: readonly WorkspaceAdministrationDurableOperationRecord[];
  readonly next?: number;
  readonly confirmation: {
    readonly throughSeq: number;
    readonly prefixDigest: string;
  };
}

export interface WorkspaceAdministrationDeliveryAcknowledgment {
  readonly outboxId: string;
  readonly throughSeq: number;
  readonly prefixDigest: string;
  readonly entries: readonly WorkspaceAdministrationDeliveryConfirmationEntry[];
}

export interface WorkspaceAdministrationDeliveryAcknowledgmentReceipt {
  readonly outboxId: string;
  readonly throughSeq: number;
  readonly prefixDigest: string;
}

export interface WorkspaceAdministrationConsumptionCredential
  extends WorkspaceAdministrationDurableOperationKey {
  readonly outboxId: string;
  readonly resultDigest: string;
}

export type WorkspaceAdministrationDeliveryClaim =
  | { readonly kind: "none" }
  | { readonly kind: "current" }
  | {
      readonly kind: "operation-input";
      readonly input: WorkspaceAdministrationDurableOperation;
    }
  | {
      readonly kind: "operation";
      readonly identity: WorkspaceAdministrationDurableOperationKey;
    };

export interface WorkspaceAdministrationResultDeliveryMechanismPort {
  pending(afterSeq: number): Promise<WorkspaceAdministrationPendingDeliveryPage>;
  acknowledge(
    input: WorkspaceAdministrationDeliveryAcknowledgment,
  ): Promise<WorkspaceAdministrationDeliveryAcknowledgmentReceipt>;
}

export type WorkspaceAdministrationDurableLifecycleState =
  | "recovering"
  | "ready"
  | "degraded"
  | "draining"
  | "closed";

export interface WorkspaceAdministrationDurableLifecycleStatus {
  readonly state: WorkspaceAdministrationDurableLifecycleState;
  readonly diagnostic?: {
    readonly code: string;
    readonly message: string;
    readonly localSeq?: number;
  };
}

export interface WorkspaceAdministrationDurableOperationMechanismPort
  extends WorkspaceAdministrationResultDeliveryMechanismPort {
  initialize(): Promise<void>;
  readonly outboxId: string;
  prepare(
    input: WorkspaceAdministrationDurableOperation,
  ): Promise<WorkspaceAdministrationDurableOperationRecord>;
  commit(
    identity: WorkspaceAdministrationDurableOperationKey,
    confirmation?: { readonly impact: string },
  ): Promise<WorkspaceAdministrationDurableOperationRecord>;
  complete(
    identity: WorkspaceAdministrationDurableOperationKey,
    result: unknown,
  ): Promise<WorkspaceAdministrationDurableOperationRecord>;
  operation(
    identity: WorkspaceAdministrationDurableOperationKey,
  ): WorkspaceAdministrationDurableOperationRecord;
  oldestCommitted(): Promise<
    WorkspaceAdministrationDurableOperationRecord | undefined
  >;
}

export interface WorkspaceAdministrationDurableInfrastructureFailure {
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export interface WorkspaceAdministrationDurableLifecycleApplication {
  start(): Promise<void>;
  close(): Promise<void>;
  hostStatus(): WorkspaceAdministrationDurableLifecycleStatus;
  catalogStatus(): Promise<WorkspaceAdministrationCatalogStatus>;
  list(): Promise<readonly WorkspaceAdministrationView[]>;
  viewByName(displayName: string): Promise<WorkspaceAdministrationView>;
  assertDeliveryMechanismReady(): void;
  pending(afterSeq: number): Promise<WorkspaceAdministrationPendingDeliveryPage>;
  acknowledge(
    input: WorkspaceAdministrationDeliveryAcknowledgment,
  ): Promise<WorkspaceAdministrationDeliveryAcknowledgmentReceipt>;
  prepare(
    input: WorkspaceAdministrationDurableOperation,
  ): Promise<WorkspaceAdministrationDurableOperationRecord>;
  commit(
    identity: WorkspaceAdministrationDurableOperationKey,
    confirmation?: { readonly impact: string },
  ): Promise<WorkspaceAdministrationDurableOperationRecord>;
}

export interface WorkspaceAdministrationResultDeliveryApplication {
  forgetCurrentClaim(): void;
  recover(
    claim: WorkspaceAdministrationDeliveryClaim,
  ): Promise<WorkspaceAdministrationDurableOperationRecord | undefined>;
  capture(
    operation: WorkspaceAdministrationDurableOperationKey,
  ): Promise<WorkspaceAdministrationDurableOperationRecord>;
  consumptionCredential(): WorkspaceAdministrationConsumptionCredential | undefined;
  confirmDelivered(): Promise<void>;
}

export class RecoveredWorkspaceAdministrationOperationsError extends Error {
  readonly code = "LOCAL_WORKSPACE_RESULTS_RECOVERED";
  readonly outboxId: string;
  readonly operations: readonly WorkspaceAdministrationDurableOperationRecord[];

  constructor(
    outboxId: string,
    operations: readonly WorkspaceAdministrationDurableOperationRecord[],
  ) {
    super("已恢复先前未确认的本机工作区操作结果，请查看后重试当前命令");
    this.name = "RecoveredLocalWorkspaceOperationsError";
    this.outboxId = outboxId;
    this.operations = operations.map((operation) => structuredClone(operation));
  }
}

export class CompletedWorkspaceAdministrationOperationError extends Error {
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

export type WorkspaceAdministrationDurableLifecycleDelegate = Pick<
  WorkspaceAdministrationApplication,
  | "status"
  | "list"
  | "viewByName"
  | "previewReset"
  | "executeDurableOperation"
>;

export interface WorkspaceAdministrationCatalogStatus {
  readonly state: "healthy" | "degraded";
  readonly catalogGeneration: string;
  readonly reason?: string;
  readonly resetImpact?: string;
}

export interface WorkspaceAdministrationResetPreview {
  readonly expectedCatalogGeneration: string;
  readonly impact: string;
}

export interface WorkspaceAdministrationControlPort {
  execute<T>(
    requestId: string,
    abort: AbortSignal,
    operation: (control: LocalEnvironmentControlContext) => Promise<T>,
  ): Promise<T>;
}

export interface WorkspaceAdministrationApplication {
  status(): Promise<WorkspaceAdministrationCatalogStatus>;
  list(): Promise<readonly WorkspaceAdministrationView[]>;
  viewByName(displayName: string): Promise<WorkspaceAdministrationView>;
  previewReset(input: {
    readonly expectedCatalogGeneration: string;
    readonly impact: string;
  }): Promise<WorkspaceAdministrationResetPreview>;
  create(
    input: { readonly displayName: string; readonly absolutePath: string },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceAdministrationView>;
  authorizeForControl(
    input: { readonly displayName: string; readonly absolutePath: string },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceControlAuthorization>;
  rename(
    input: {
      readonly currentName: string;
      readonly displayName: string;
      readonly expectedRevision: number;
    },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceAdministrationView>;
  repath(
    input: {
      readonly name: string;
      readonly absolutePath: string;
      readonly expectedRevision: number;
    },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceAdministrationView>;
  remove(
    input: { readonly name: string; readonly expectedRevision: number },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<void>;
  reset(
    input: {
      readonly expectedCatalogGeneration: string;
      readonly confirmedImpact: string;
    },
    execution?: WorkspaceAdministrationResetExecution,
  ): Promise<WorkspaceBindingResetReceipt>;
  executeDurableOperation(
    input: WorkspaceAdministrationDurableOperation,
    execution: WorkspaceAdministrationDurableExecution,
  ): Promise<unknown>;
}

export class WorkspaceAdministrationBusinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceAdministrationBusinessError";
    this.code = code;
  }
}

/**
 * Workspace Administration owns the finite binding CRUD and reset lifecycle
 * use cases. The injected ports provide only serialized binding/recovery
 * effects and local control admission; neither paths nor Authority
 * implementations escape this boundary.
 */
export class WorkspaceAdministrationApplicationService
  implements WorkspaceAdministrationApplication
{
  readonly #deviceId: string;
  readonly #admin: WorkspaceBindingAdminPort;
  readonly #recovery: WorkspaceBindingRecoveryPort;
  readonly #control: WorkspaceAdministrationControlPort;

  constructor(input: {
    readonly deviceId: string;
    readonly admin: WorkspaceBindingAdminPort;
    readonly recovery: WorkspaceBindingRecoveryPort;
    readonly control: WorkspaceAdministrationControlPort;
  }) {
    this.#deviceId = input.deviceId;
    this.#admin = input.admin;
    this.#recovery = input.recovery;
    this.#control = input.control;
  }

  async status(): Promise<WorkspaceAdministrationCatalogStatus> {
    const status = await this.#recovery.status();
    return Object.freeze({
      ...status,
      ...(status.state === "degraded"
        ? { resetImpact: WORKSPACE_CATALOG_RESET_IMPACT }
        : {}),
    });
  }

  async list(): Promise<readonly WorkspaceAdministrationView[]> {
    return this.#execute("workspace-list", undefined, async (control) =>
      Object.freeze((await this.#admin.list(control)).map(toView)),
    );
  }

  async viewByName(displayName: string): Promise<WorkspaceAdministrationView> {
    return this.#execute("workspace-view", undefined, async (control) =>
      toView(await this.#bindingByName(displayName, control)),
    );
  }

  async previewReset(input: {
    readonly expectedCatalogGeneration: string;
    readonly impact: string;
  }): Promise<WorkspaceAdministrationResetPreview> {
    if (input.impact !== WORKSPACE_CATALOG_RESET_IMPACT) {
      throw new TypeError("工作区目录恢复确认内容不完整");
    }
    const status = await this.#recovery.status();
    if (status.catalogGeneration !== input.expectedCatalogGeneration) {
      throw new WorkspaceAdministrationBusinessError(
        "LOCAL_WORKSPACE_CATALOG_CHANGED",
        "工作区目录世代已经变化，请重新查看恢复影响",
      );
    }
    return Object.freeze({
      expectedCatalogGeneration: input.expectedCatalogGeneration,
      impact: WORKSPACE_CATALOG_RESET_IMPACT,
    });
  }

  async create(
    input: { readonly displayName: string; readonly absolutePath: string },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceAdministrationView> {
    return this.#execute("workspace-create", execution, async (control) =>
      toView(await this.#admin.create(input, control)),
    );
  }

  async authorizeForControl(
    input: { readonly displayName: string; readonly absolutePath: string },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceControlAuthorization> {
    const binding = await this.#execute(
      "workspace-authorize",
      execution,
      (control) => this.#admin.create(input, control),
    );
    return Object.freeze({
      deviceId: this.#deviceId,
      bindingRef: binding.bindingRef,
    });
  }

  async rename(
    input: {
      readonly currentName: string;
      readonly displayName: string;
      readonly expectedRevision: number;
    },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceAdministrationView> {
    return this.#execute("workspace-rename", execution, async (control) => {
      const current = await this.#bindingByName(input.currentName, control);
      return toView(
        await this.#admin.update(
          current.bindingRef,
          { displayName: input.displayName },
          input.expectedRevision,
          control,
        ),
      );
    });
  }

  async repath(
    input: {
      readonly name: string;
      readonly absolutePath: string;
      readonly expectedRevision: number;
    },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<WorkspaceAdministrationView> {
    return this.#execute("workspace-repath", execution, async (control) => {
      const current = await this.#bindingByName(input.name, control);
      return toView(
        await this.#admin.update(
          current.bindingRef,
          { absolutePath: input.absolutePath },
          input.expectedRevision,
          control,
        ),
      );
    });
  }

  async remove(
    input: { readonly name: string; readonly expectedRevision: number },
    execution?: WorkspaceAdministrationExecution,
  ): Promise<void> {
    await this.#execute("workspace-remove", execution, async (control) => {
      const current = await this.#bindingByName(input.name, control);
      await this.#admin.remove(
        current.bindingRef,
        input.expectedRevision,
        control,
      );
    });
  }

  async reset(
    input: {
      readonly expectedCatalogGeneration: string;
      readonly confirmedImpact: string;
    },
    execution?: WorkspaceAdministrationResetExecution,
  ): Promise<WorkspaceBindingResetReceipt> {
    if (input.confirmedImpact !== WORKSPACE_CATALOG_RESET_IMPACT) {
      throw new TypeError("工作区目录恢复确认内容不完整");
    }
    const requestId = this.#requestId("workspace-reset", execution);
    const abort = execution?.abort ?? new AbortController().signal;
    await this.#control.execute(requestId, abort, (control) =>
      this.#recovery.beginReset(
        { expectedCatalogGeneration: input.expectedCatalogGeneration },
        {
          ...control,
          confirmation: {
            kind: "workspace-binding-reset",
            token:
              execution?.confirmationToken ??
              randomBytes(32).toString("base64url"),
            requestId,
            catalogGeneration: input.expectedCatalogGeneration,
            issuedAt:
              execution?.confirmationIssuedAt ?? new Date().toISOString(),
          },
        },
      ),
    );
    return this.#recovery.completeReset(requestId, abort);
  }

  async executeDurableOperation(
    input: WorkspaceAdministrationDurableOperation,
    execution: WorkspaceAdministrationDurableExecution,
  ): Promise<unknown> {
    const operation = validateWorkspaceAdministrationDurableOperation(input);
    const commonExecution = {
      operation: execution.operation,
      abort: execution.abort,
    };
    let value: unknown;
    switch (operation.kind) {
      case "create":
        value =
          operation.purpose === "control"
            ? await this.authorizeForControl(
                {
                  displayName: operation.displayName,
                  absolutePath: operation.absolutePath,
                },
                commonExecution,
              )
            : await this.create(
                {
                  displayName: operation.displayName,
                  absolutePath: operation.absolutePath,
                },
                commonExecution,
              );
        break;
      case "rename":
        value = await this.rename(
          {
            currentName: operation.currentName,
            displayName: operation.displayName,
            expectedRevision: operation.expectedRevision,
          },
          commonExecution,
        );
        break;
      case "repath":
        value = await this.repath(
          {
            name: operation.name,
            absolutePath: operation.absolutePath,
            expectedRevision: operation.expectedRevision,
          },
          commonExecution,
        );
        break;
      case "remove":
        await this.remove(
          { name: operation.name, expectedRevision: operation.expectedRevision },
          commonExecution,
        );
        value = null;
        break;
      case "reset":
        if (!execution.confirmationToken) {
          throw new TypeError(
            "Local workspace reset durable confirmation token is invalid",
          );
        }
        value = await this.reset(
          {
            expectedCatalogGeneration: operation.expectedCatalogGeneration,
            confirmedImpact: operation.impact,
          },
          {
            ...commonExecution,
            confirmationToken: execution.confirmationToken,
            confirmationIssuedAt: execution.preparedAt,
          },
        );
        break;
    }
    return validateWorkspaceAdministrationDurableValue(operation, value);
  }

  async #bindingByName(
    displayName: string,
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding> {
    const matches = (await this.#admin.list(control)).filter(
      (binding) => binding.displayName === displayName,
    );
    if (matches.length !== 1) {
      throw new WorkspaceAdministrationBusinessError(
        matches.length === 0
          ? "LOCAL_WORKSPACE_NOT_FOUND"
          : "LOCAL_WORKSPACE_NAME_CONFLICT",
        matches.length === 0
          ? `本机没有名为“${displayName}”的已授权工作区`
          : `本机工作区名称“${displayName}”不唯一`,
      );
    }
    return matches[0]!;
  }

  #execute<T>(
    prefix: string,
    execution: WorkspaceAdministrationExecution | undefined,
    operation: (control: LocalEnvironmentControlContext) => Promise<T>,
  ): Promise<T> {
    const requestId = this.#requestId(prefix, execution);
    return this.#control.execute(
      requestId,
      execution?.abort ?? new AbortController().signal,
      operation,
    );
  }

  #requestId(
    prefix: string,
    execution: WorkspaceAdministrationExecution | undefined,
  ): string {
    const nonce = execution?.operation
      ? operationNonce(execution.operation)
      : `${prefix}:${randomUUID()}`;
    return localEnvironmentControlSubject(this.#deviceId, nonce);
  }
}

type DurableRetryDecision = {
  readonly kind: "retry";
  readonly code: string;
  readonly message: string;
  readonly delayMs: number;
};

type DurableDegradedDecision = {
  readonly kind: "degraded";
  readonly code: string;
  readonly message: string;
};

type DurableInfrastructureDecision =
  | DurableRetryDecision
  | DurableDegradedDecision;

type DurableOperationDecision =
  | {
      readonly kind: "completed";
      readonly result: WorkspaceAdministrationDurableResult;
    }
  | DurableInfrastructureDecision;

const EMPTY_WORKSPACE_ADMINISTRATION_DELIVERY_PREFIX = protocolDigest(
  "LocalWorkspaceOperationPrefix",
  1,
  null,
);

interface WorkspaceAdministrationPendingDelivery {
  readonly outboxId: string;
  readonly confirmation: {
    readonly throughSeq: number;
    readonly prefixDigest: string;
  };
  readonly operations: readonly WorkspaceAdministrationDurableOperationRecord[];
}

/**
 * Owns the finite result-delivery decision above the P10 outbox mechanism.
 * The mechanism only pages and acknowledges durable records; this service
 * decides which result belongs to the current invocation and which recovered
 * results must be presented before new work proceeds.
 */
export class WorkspaceAdministrationResultDeliveryApplicationService
  implements WorkspaceAdministrationResultDeliveryApplication
{
  readonly #mechanism: WorkspaceAdministrationResultDeliveryMechanismPort;
  #pending: WorkspaceAdministrationPendingDelivery | undefined;
  #current: WorkspaceAdministrationDurableOperationRecord | undefined;

  constructor(input: {
    readonly mechanism: WorkspaceAdministrationResultDeliveryMechanismPort;
  }) {
    this.#mechanism = input.mechanism;
  }

  forgetCurrentClaim(): void {
    this.#current = undefined;
  }

  async recover(
    claim: WorkspaceAdministrationDeliveryClaim,
  ): Promise<WorkspaceAdministrationDurableOperationRecord | undefined> {
    if (claim.kind === "none") this.forgetCurrentClaim();
    const currentCredential =
      claim.kind === "current" ? this.consumptionCredential() : undefined;
    const delivery = await this.#readPendingDelivery();
    const claimed = delivery.operations.find((operation) => {
      if (operation.state !== "completed") return false;
      switch (claim.kind) {
        case "none":
          return false;
        case "current":
          return currentCredential !== undefined &&
            delivery.outboxId === currentCredential.outboxId &&
            matchesWorkspaceAdministrationConsumptionCredential(
              operation,
              currentCredential,
            );
        case "operation-input":
          return operation.inputDigest === protocolDigest(
            "LocalWorkspaceOperationInput",
            1,
            validateWorkspaceAdministrationDurableOperation(claim.input),
          );
        case "operation":
          return matchesWorkspaceAdministrationOperationIdentity(
            operation,
            claim.identity,
          );
      }
    });
    this.#pending = delivery;
    this.#current = claimed;
    const unclaimed = delivery.operations.filter(
      (operation) =>
        operation.state === "completed" &&
        (claimed === undefined || operation.localSeq !== claimed.localSeq),
    );
    if (unclaimed.length > 0) {
      throw new RecoveredWorkspaceAdministrationOperationsError(
        delivery.outboxId,
        unclaimed,
      );
    }
    return claimed ? structuredClone(claimed) : undefined;
  }

  async capture(
    operation: WorkspaceAdministrationDurableOperationKey,
  ): Promise<WorkspaceAdministrationDurableOperationRecord> {
    const delivery = await this.#readPendingDelivery();
    const current = delivery.operations.find(
      (candidate) =>
        candidate.state === "completed" &&
        matchesWorkspaceAdministrationOperationIdentity(candidate, operation),
    );
    if (!current?.resultDigest) {
      throw new Error(
        "Local workspace result is not part of the recoverable delivery prefix",
      );
    }
    this.#pending = delivery;
    this.#current = current;
    return structuredClone(current);
  }

  consumptionCredential():
    | WorkspaceAdministrationConsumptionCredential
    | undefined {
    const delivery = this.#pending;
    const operation = this.#current;
    if (!delivery || !operation?.resultDigest) return undefined;
    const credential = Object.freeze({
      outboxId: delivery.outboxId,
      ...workspaceAdministrationOperationIdentityOf(operation),
      resultDigest: operation.resultDigest,
    });
    if (
      !delivery.operations.some((candidate) =>
        matchesWorkspaceAdministrationConsumptionCredential(
          candidate,
          credential,
        ),
      )
    ) {
      throw new Error(
        "Local workspace result is not part of the recoverable delivery prefix",
      );
    }
    return credential;
  }

  async confirmDelivered(): Promise<void> {
    const delivery = this.#pending;
    if (!delivery || delivery.operations.length === 0) return;
    let prefixDigest = delivery.confirmation.prefixDigest;
    const entries = delivery.operations.map((operation) => {
      if (!operation.resultDigest) {
        throw new Error("Local workspace terminal result digest is missing");
      }
      const entry = Object.freeze({
        ...workspaceAdministrationOperationIdentityOf(operation),
        resultDigest: operation.resultDigest,
      });
      prefixDigest = protocolDigest("LocalWorkspaceOperationPrefix", 1, {
        previous: prefixDigest,
        ...entry,
      });
      return entry;
    });
    const throughSeq = delivery.operations.at(-1)!.localSeq;
    const receipt = await this.#mechanism.acknowledge({
      outboxId: delivery.outboxId,
      throughSeq,
      prefixDigest,
      entries,
    });
    if (
      receipt.outboxId !== delivery.outboxId ||
      receipt.throughSeq !== throughSeq ||
      receipt.prefixDigest !== prefixDigest
    ) {
      throw new Error(
        "Local workspace acknowledgment receipt is bound to another delivery",
      );
    }
    this.#pending = undefined;
    this.#current = undefined;
  }

  async #readPendingDelivery(): Promise<WorkspaceAdministrationPendingDelivery> {
    let afterSeq = 0;
    let outboxId: string | undefined;
    let confirmation:
      | { readonly throughSeq: number; readonly prefixDigest: string }
      | undefined;
    const terminal: WorkspaceAdministrationDurableOperationRecord[] = [];
    let terminalPrefixOpen = true;
    for (;;) {
      const page = await this.#mechanism.pending(afterSeq);
      outboxId ??= page.outboxId;
      if (outboxId !== page.outboxId) {
        throw new Error(
          "Local workspace outbox identity changed during delivery recovery",
        );
      }
      confirmation ??= page.confirmation;
      if (
        confirmation.throughSeq !== page.confirmation.throughSeq ||
        confirmation.prefixDigest !== page.confirmation.prefixDigest
      ) {
        throw new Error(
          "Local workspace confirmation watermark changed during delivery recovery",
        );
      }
      for (const operation of page.operations) {
        if (!terminalPrefixOpen) continue;
        const expectedSeq =
          (terminal.at(-1)?.localSeq ?? confirmation.throughSeq) + 1;
        if (
          operation.localSeq !== expectedSeq ||
          (operation.state !== "completed" && operation.state !== "abandoned") ||
          !operation.resultDigest
        ) {
          terminalPrefixOpen = false;
          continue;
        }
        terminal.push(structuredClone(operation));
      }
      if (page.next === undefined) break;
      afterSeq = page.next;
    }
    return Object.freeze({
      outboxId: outboxId ?? "",
      confirmation:
        confirmation ??
        Object.freeze({
          throughSeq: 0,
          prefixDigest: EMPTY_WORKSPACE_ADMINISTRATION_DELIVERY_PREFIX,
        }),
      operations: Object.freeze(terminal),
    });
  }
}

function matchesWorkspaceAdministrationOperationIdentity(
  operation: WorkspaceAdministrationDurableOperationRecord,
  identity: WorkspaceAdministrationDurableOperationKey,
): boolean {
  return (
    operation.localSeq === identity.localSeq &&
    operation.operationId === identity.operationId &&
    operation.inputDigest === identity.inputDigest
  );
}

function matchesWorkspaceAdministrationConsumptionCredential(
  operation: WorkspaceAdministrationDurableOperationRecord,
  credential: WorkspaceAdministrationConsumptionCredential,
): boolean {
  return (
    matchesWorkspaceAdministrationOperationIdentity(operation, credential) &&
    operation.resultDigest === credential.resultDigest
  );
}

function workspaceAdministrationOperationIdentityOf(
  operation: WorkspaceAdministrationDurableOperationRecord,
): WorkspaceAdministrationDurableOperationKey {
  return Object.freeze({
    localSeq: operation.localSeq,
    operationId: operation.operationId,
    inputDigest: operation.inputDigest,
  });
}

/**
 * Owns Workspace Administration's durable operation admission and recovery
 * decisions. The mechanism port persists and replays P10 records but does not
 * decide when an operation is admitted, retried, completed, or degraded.
 */
export class WorkspaceAdministrationDurableLifecycleApplicationService
  implements WorkspaceAdministrationDurableLifecycleApplication
{
  readonly #application: WorkspaceAdministrationDurableLifecycleDelegate;
  readonly #mechanism: WorkspaceAdministrationDurableOperationMechanismPort;
  readonly #observeInfrastructureFailure: (
    error: unknown,
  ) => WorkspaceAdministrationDurableInfrastructureFailure;
  #state: WorkspaceAdministrationDurableLifecycleState | "created" = "created";
  #diagnostic: WorkspaceAdministrationDurableLifecycleStatus["diagnostic"];
  #mechanismReady = false;
  #mutationTail = Promise.resolve();
  #drain: Promise<void> | undefined;
  #recovery: Promise<void> | undefined;
  #retryAbort = new AbortController();
  #attemptAbort: AbortController | undefined;

  constructor(input: {
    readonly application: WorkspaceAdministrationDurableLifecycleDelegate;
    readonly mechanism: WorkspaceAdministrationDurableOperationMechanismPort;
    readonly observeInfrastructureFailure: (
      error: unknown,
    ) => WorkspaceAdministrationDurableInfrastructureFailure;
  }) {
    this.#application = input.application;
    this.#mechanism = input.mechanism;
    this.#observeInfrastructureFailure = input.observeInfrastructureFailure;
  }

  async start(): Promise<void> {
    if (this.#state !== "created") return;
    this.#state = "recovering";
    this.#diagnostic = {
      code: "LOCAL_WORKSPACE_RECOVERING",
      message: "Local workspace host is recovering durable operations",
    };
    await this.#tryInitializeMechanism();
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "created") {
      this.#state = "closed";
      this.#diagnostic = undefined;
      return;
    }
    this.#state = "draining";
    this.#diagnostic = {
      code: "LOCAL_WORKSPACE_DRAINING",
      message: "Local workspace host is draining to a durable safe point",
    };
    this.#retryAbort.abort();
    this.#attemptAbort?.abort();
    await Promise.allSettled(
      [this.#drain, this.#recovery, this.#mutationTail].filter(
        (value): value is Promise<void> => value !== undefined,
      ),
    );
    this.#state = "closed";
    this.#diagnostic = undefined;
  }

  hostStatus(): WorkspaceAdministrationDurableLifecycleStatus {
    const state = this.#state === "created" ? "recovering" : this.#state;
    return Object.freeze({
      state,
      ...(this.#diagnostic
        ? { diagnostic: Object.freeze({ ...this.#diagnostic }) }
        : {}),
    });
  }

  catalogStatus(): Promise<WorkspaceAdministrationCatalogStatus> {
    return this.#application.status();
  }

  list(): Promise<readonly WorkspaceAdministrationView[]> {
    return this.#application.list();
  }

  viewByName(displayName: string): Promise<WorkspaceAdministrationView> {
    return this.#application.viewByName(displayName);
  }

  assertDeliveryMechanismReady(): void {
    if (!this.#mechanismReady) throw this.#stateError();
  }

  pending(afterSeq: number): Promise<WorkspaceAdministrationPendingDeliveryPage> {
    this.assertDeliveryMechanismReady();
    return this.#mechanism.pending(afterSeq);
  }

  acknowledge(
    input: WorkspaceAdministrationDeliveryAcknowledgment,
  ): Promise<WorkspaceAdministrationDeliveryAcknowledgmentReceipt> {
    this.assertDeliveryMechanismReady();
    return this.#mechanism.acknowledge(input);
  }

  async prepare(
    input: WorkspaceAdministrationDurableOperation,
  ): Promise<WorkspaceAdministrationDurableOperationRecord> {
    this.assertDeliveryMechanismReady();
    return this.#serializeMutation(async () => {
      this.#requireWritable();
      if (input.kind === "reset") {
        const preview = await this.#application.previewReset({
          expectedCatalogGeneration: input.expectedCatalogGeneration,
          impact: input.impact,
        });
        return this.#mechanism.prepare({ kind: "reset", ...preview });
      }
      return this.#mechanism.prepare(input);
    });
  }

  async commit(
    identity: WorkspaceAdministrationDurableOperationKey,
    confirmation?: { readonly impact: string },
  ): Promise<WorkspaceAdministrationDurableOperationRecord> {
    this.assertDeliveryMechanismReady();
    const admitted = await this.#serializeMutation(async () => {
      const existing = this.#mechanism.operation(identity);
      const replay =
        existing.state === "committed" || existing.state === "completed";
      if (!replay) this.#requireWritable();
      const committed = await this.#mechanism.commit(identity, confirmation);
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
    const current = this.#mechanism.operation(admitted.committed);
    if (current.state === "completed") return current;
    throw this.#stateError();
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
      let operation: WorkspaceAdministrationDurableOperationRecord | undefined;
      try {
        operation = await this.#mechanism.oldestCommitted();
      } catch (error) {
        const decision = this.#classifyInfrastructureFailure(
          error,
          retryAttempt,
        );
        if (decision.kind === "retry") {
          retryAttempt += 1;
          this.#setDiagnostic(decision);
          if (!(await waitForWorkspaceAdministrationRetry(
            decision.delayMs,
            this.#retryAbort.signal,
          ))) return;
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
        if (!(await waitForWorkspaceAdministrationRetry(
          decision.delayMs,
          this.#retryAbort.signal,
        ))) return;
        continue;
      }
      if (decision.kind === "degraded") {
        this.#degrade(decision, operation.localSeq);
        return;
      }
      try {
        await this.#mechanism.complete(operation, decision.result);
        retryAttempt = 0;
      } catch (error) {
        const completion = this.#classifyInfrastructureFailure(
          error,
          retryAttempt,
        );
        if (completion.kind === "retry") {
          retryAttempt += 1;
          this.#setDiagnostic(completion, operation.localSeq);
          if (!(await waitForWorkspaceAdministrationRetry(
            completion.delayMs,
            this.#retryAbort.signal,
          ))) return;
          continue;
        }
        this.#degrade(completion, operation.localSeq);
        return;
      }
    }
  }

  async #executeDecision(
    operation: WorkspaceAdministrationDurableOperationRecord,
    retryAttempt: number,
  ): Promise<DurableOperationDecision> {
    const abort = new AbortController();
    this.#attemptAbort = abort;
    try {
      const value = await this.#application.executeDurableOperation(
        operation.input,
        {
          operation: {
            outboxId: this.#mechanism.outboxId,
            localSeq: operation.localSeq,
            operationId: operation.operationId,
            inputDigest: operation.inputDigest,
          },
          abort: abort.signal,
          preparedAt: operation.preparedAt,
          ...(operation.confirmationToken
            ? { confirmationToken: operation.confirmationToken }
            : {}),
        },
      );
      return {
        kind: "completed",
        result: workspaceAdministrationDurableSuccess(value ?? null),
      };
    } catch (error) {
      return this.#classifyExecutionFailure(error, retryAttempt);
    } finally {
      if (this.#attemptAbort === abort) this.#attemptAbort = undefined;
    }
  }

  async #tryInitializeMechanism(): Promise<void> {
    try {
      await this.#mechanism.initialize();
      this.#mechanismReady = true;
      const committed = await this.#mechanism.oldestCommitted();
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
      const decision = this.#classifyInfrastructureFailure(error, 0);
      if (decision.kind === "retry") {
        this.#setDiagnostic(decision);
        if (this.#mechanismReady) {
          void this.#ensureDrain();
        } else {
          this.#scheduleMechanismRecovery(decision.delayMs);
        }
      } else {
        this.#degrade(decision);
      }
    }
  }

  #scheduleMechanismRecovery(initialDelayMs: number): void {
    if (this.#recovery) return;
    const recovery = (async () => {
      let attempt = 1;
      let delayMs = initialDelayMs;
      while (this.#state === "recovering" && !this.#mechanismReady) {
        if (!(await waitForWorkspaceAdministrationRetry(
          delayMs,
          this.#retryAbort.signal,
        ))) return;
        try {
          await this.#mechanism.initialize();
          this.#mechanismReady = true;
          void this.#ensureDrain();
          return;
        } catch (error) {
          const decision = this.#classifyInfrastructureFailure(error, attempt);
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

  #classifyExecutionFailure(
    error: unknown,
    attempt: number,
  ): DurableOperationDecision {
    if (isWorkspaceAdministrationDurableBusinessFailure(error)) {
      return {
        kind: "completed",
        result: workspaceAdministrationDurableFailure(
          workspaceAdministrationDurableBusinessErrorCode(error),
          error.message,
        ),
      };
    }
    return this.#classifyInfrastructureFailure(error, attempt);
  }

  #classifyInfrastructureFailure(
    error: unknown,
    attempt: number,
  ): DurableInfrastructureDecision {
    const observed = validateDurableInfrastructureFailure(
      this.#observeInfrastructureFailure(error),
    );
    if (observed.retryAfterMs !== undefined) {
      return {
        kind: "retry",
        code: observed.code,
        message: observed.message,
        delayMs: Math.min(
          2_000,
          Math.max(
            observed.retryAfterMs,
            workspaceAdministrationRetryBackoffMs(attempt),
          ),
        ),
      };
    }
    return {
      kind: "degraded",
      code: observed.code,
      message: observed.message,
    };
  }

  #setDiagnostic(decision: DurableRetryDecision, localSeq?: number): void {
    if (this.#state !== "draining" && this.#state !== "closed") {
      this.#state = "recovering";
    }
    this.#diagnostic = {
      code: decision.code,
      message: decision.message,
      ...(localSeq === undefined ? {} : { localSeq }),
    };
  }

  #degrade(decision: DurableDegradedDecision, localSeq?: number): void {
    if (this.#state === "draining" || this.#state === "closed") return;
    this.#state = "degraded";
    this.#diagnostic = {
      code: decision.code,
      message: decision.message,
      ...(localSeq === undefined ? {} : { localSeq }),
    };
  }

  #requireWritable(): void {
    if (this.#state !== "ready") throw this.#stateError();
  }

  #stateError(): Error & { code: string } {
    const error = new Error(
      this.#diagnostic?.message ??
        "Local workspace management host is not ready",
    ) as Error & { code: string };
    error.code =
      this.#diagnostic?.code ?? "LOCAL_WORKSPACE_HOST_NOT_READY";
    return error;
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function isWorkspaceAdministrationDurableBusinessFailure(
  error: unknown,
): error is Error {
  return (
    error instanceof WorkspaceAdministrationBusinessError ||
    error instanceof WorkspaceBindingNotFoundError ||
    error instanceof WorkspaceBindingConflictError ||
    error instanceof WorkspaceBindingRevisionError ||
    error instanceof WorkspaceBindingCatalogConflictError
  );
}

function workspaceAdministrationDurableBusinessErrorCode(
  error: Error,
): string {
  if (
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    return (error as { readonly code: string }).code;
  }
  if (error instanceof WorkspaceBindingNotFoundError) {
    return "WORKSPACE_BINDING_NOT_FOUND";
  }
  if (error instanceof WorkspaceBindingConflictError) {
    return "WORKSPACE_BINDING_CONFLICT";
  }
  if (error instanceof WorkspaceBindingRevisionError) {
    return "WORKSPACE_BINDING_REVISION";
  }
  return "LOCAL_WORKSPACE_OPERATION_FAILED";
}

function validateDurableInfrastructureFailure(
  value: WorkspaceAdministrationDurableInfrastructureFailure,
): WorkspaceAdministrationDurableInfrastructureFailure {
  if (
    !value ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    (value.retryAfterMs !== undefined &&
      (!Number.isFinite(value.retryAfterMs) || value.retryAfterMs < 0))
  ) {
    throw new TypeError(
      "Workspace administration infrastructure failure is invalid",
    );
  }
  return value;
}

function workspaceAdministrationRetryBackoffMs(attempt: number): number {
  return Math.min(2_000, 50 * 2 ** Math.min(attempt, 5));
}

function waitForWorkspaceAdministrationRetry(
  delayMs: number,
  abort: AbortSignal,
): Promise<boolean> {
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

function operationNonce(identity: WorkspaceAdministrationOperationIdentity): string {
  return [
    "workspace-operation",
    identity.outboxId,
    identity.localSeq,
    identity.operationId,
    identity.inputDigest,
  ].join(":");
}

function toView(binding: LocalWorkspaceBinding): WorkspaceAdministrationView {
  return Object.freeze({
    name: binding.displayName,
    path: binding.absolutePath,
    revision: binding.revision,
    workspaceBindingRevision: binding.workspaceBindingRevision,
  });
}

export function validateWorkspaceAdministrationDurableOperation(
  value: unknown,
): WorkspaceAdministrationDurableOperation {
  const record = value as Record<string, unknown>;
  const keysByKind: Record<
    WorkspaceAdministrationDurableOperation["kind"],
    readonly string[]
  > = {
    create: ["absolutePath", "displayName", "kind", "purpose"],
    rename: ["currentName", "displayName", "expectedRevision", "kind"],
    repath: ["absolutePath", "expectedRevision", "kind", "name"],
    remove: ["expectedRevision", "kind", "name"],
    reset: ["expectedCatalogGeneration", "impact", "kind"],
  };
  if (
    !record ||
    typeof record.kind !== "string" ||
    !(record.kind in keysByKind)
  ) {
    throw new TypeError("Local workspace operation kind is invalid");
  }
  exactRecord(
    record,
    keysByKind[record.kind as WorkspaceAdministrationDurableOperation["kind"]]!,
    "operation",
  );
  for (const [key, item] of Object.entries(record)) {
    if (key === "kind") continue;
    if (key === "purpose") {
      if (item !== "settings" && item !== "control") {
        throw new TypeError("Local workspace create purpose is invalid");
      }
      continue;
    }
    if (key === "expectedRevision") {
      if (!Number.isSafeInteger(item) || (item as number) < 1) {
        throw new TypeError("Local workspace revision is invalid");
      }
    } else if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 4096 ||
      item.includes("\0")
    ) {
      throw new TypeError(`Local workspace operation ${key} is invalid`);
    }
  }
  return structuredClone(value) as WorkspaceAdministrationDurableOperation;
}

export function workspaceAdministrationOperationTarget(
  input: WorkspaceAdministrationDurableOperation,
): string {
  switch (input.kind) {
    case "create":
      return input.displayName;
    case "rename":
      return input.currentName;
    case "repath":
    case "remove":
      return input.name;
    case "reset":
      return input.expectedCatalogGeneration;
  }
}

export function validateWorkspaceAdministrationDurableResult(
  value: unknown,
): WorkspaceAdministrationDurableResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Local workspace operation result is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) {
    const record = exactRecord(value, ["ok", "value"], "operation result");
    return Object.freeze({ ok: true, value: record.value });
  }
  if (candidate.ok === false) {
    const record = exactRecord(value, ["error", "ok"], "operation result");
    const error = exactRecord(
      record.error,
      ["code", "message"],
      "operation error",
    );
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      throw new TypeError("Local workspace operation error is invalid");
    }
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: error.code, message: error.message }),
    });
  }
  throw new TypeError("Local workspace operation result is invalid");
}

export function workspaceAdministrationDurableSuccess(
  value: unknown,
): WorkspaceAdministrationDurableResult {
  return Object.freeze({ ok: true, value });
}

export function workspaceAdministrationDurableFailure(
  code: string,
  message: string,
): WorkspaceAdministrationDurableResult {
  if (!code || !message) {
    throw new TypeError("Local workspace operation error is invalid");
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

export function workspaceAdministrationResultValue(
  input: WorkspaceAdministrationDurableOperation,
  result: WorkspaceAdministrationDurableResult,
): unknown {
  if (!result.ok) {
    throw new CompletedWorkspaceAdministrationOperationError(
      result.error.code,
      result.error.message,
    );
  }
  return validateWorkspaceAdministrationDurableValue(input, result.value);
}

export function validateWorkspaceAdministrationDurableValue(
  input: WorkspaceAdministrationDurableOperation,
  value: unknown,
): unknown {
  if (input.kind === "remove") {
    if (value !== null) {
      throw new TypeError("Local workspace remove result is invalid");
    }
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
    ) {
      throw new TypeError("Local workspace reset receipt is invalid");
    }
    return record;
  }
  return validateWorkspaceAdministrationView(value);
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

function validateWorkspaceAdministrationView(
  value: unknown,
): WorkspaceAdministrationView {
  const record = exactRecord(
    value,
    ["name", "path", "revision", "workspaceBindingRevision"],
    "workspace view",
  );
  if (
    typeof record.name !== "string" ||
    typeof record.path !== "string" ||
    !Number.isSafeInteger(record.revision) ||
    !Number.isSafeInteger(record.workspaceBindingRevision)
  ) {
    throw new TypeError("Local workspace view is invalid");
  }
  return record as unknown as WorkspaceAdministrationView;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Local workspace ${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError(`Local workspace ${label} fields are invalid`);
  }
  return record;
}
