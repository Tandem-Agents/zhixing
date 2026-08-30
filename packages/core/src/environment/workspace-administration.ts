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
