import { randomUUID } from "node:crypto";
import type {
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
} from "../contracts/ports.js";
import { localEnvironmentControlSubject } from "./workspace-bindings.js";

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

export interface WorkspaceAdministrationControlPort {
  execute<T>(
    requestId: string,
    abort: AbortSignal,
    operation: (control: LocalEnvironmentControlContext) => Promise<T>,
  ): Promise<T>;
}

export interface WorkspaceAdministrationApplication {
  list(): Promise<readonly WorkspaceAdministrationView[]>;
  viewByName(displayName: string): Promise<WorkspaceAdministrationView>;
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
 * Workspace Administration owns the finite binding CRUD use cases. The
 * injected ports provide only serialized binding effects and local control
 * admission; neither paths nor Authority implementations escape this boundary.
 */
export class WorkspaceAdministrationApplicationService
  implements WorkspaceAdministrationApplication
{
  readonly #deviceId: string;
  readonly #admin: WorkspaceBindingAdminPort;
  readonly #control: WorkspaceAdministrationControlPort;

  constructor(input: {
    readonly deviceId: string;
    readonly admin: WorkspaceBindingAdminPort;
    readonly control: WorkspaceAdministrationControlPort;
  }) {
    this.#deviceId = input.deviceId;
    this.#admin = input.admin;
    this.#control = input.control;
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
    const nonce = execution?.operation
      ? operationNonce(execution.operation)
      : `${prefix}:${randomUUID()}`;
    const requestId = localEnvironmentControlSubject(this.#deviceId, nonce);
    return this.#control.execute(
      requestId,
      execution?.abort ?? new AbortController().signal,
      operation,
    );
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
