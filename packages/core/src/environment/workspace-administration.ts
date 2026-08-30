import { randomBytes, randomUUID } from "node:crypto";
import type {
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
  WorkspaceBindingRecoveryPort,
  WorkspaceBindingResetReceipt,
} from "../contracts/ports.js";
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
