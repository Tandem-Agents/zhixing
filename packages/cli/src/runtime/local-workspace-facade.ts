import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuthorityCallContext,
  ImmediateRootResourceLease,
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
  WorkspaceBindingRecoveryPort,
  WorkspaceBindingResetReceipt,
} from "@zhixing/core/contracts";
import { localEnvironmentControlSubject } from "@zhixing/core/environment";
import type { ExecutorResourceGovernor } from "@zhixing/executor";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

const CONTROL_BUDGET = { maxCalls: 8 };

export interface LocalWorkspaceView {
  readonly name: string;
  readonly path: string;
  readonly revision: number;
  readonly workspaceBindingRevision: number;
}

export interface LocalWorkspaceCatalogStatus {
  readonly state: "healthy" | "degraded";
  readonly catalogGeneration: string;
  readonly reason?: string;
  readonly resetImpact?: string;
}

export interface LocalWorkspaceFacadeOptions {
  readonly deviceId: string;
  readonly executorId: string;
  readonly admin: WorkspaceBindingAdminPort;
  readonly recovery: WorkspaceBindingRecoveryPort;
  readonly resources: ExecutorResourceGovernor;
}

export interface LocalWorkspaceOperationAuthority {
  readonly requestNonce: string;
  readonly confirmationToken?: string;
  readonly abort?: AbortSignal;
}

export class LocalWorkspaceBusinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalWorkspaceBusinessError";
    this.code = code;
  }
}

/**
 * Target-device settings adapter. It calls the local ports directly; neither
 * raw paths nor recovery capabilities cross an RPC or mesh boundary.
 */
export class LocalWorkspaceFacade {
  readonly #deviceId: string;
  readonly #executorId: string;
  readonly #admin: WorkspaceBindingAdminPort;
  readonly #recovery: WorkspaceBindingRecoveryPort;
  readonly #resources: ExecutorResourceGovernor;

  constructor(options: LocalWorkspaceFacadeOptions) {
    this.#deviceId = options.deviceId;
    this.#executorId = options.executorId;
    this.#admin = options.admin;
    this.#recovery = options.recovery;
    this.#resources = options.resources;
  }

  async status(): Promise<LocalWorkspaceCatalogStatus> {
    const status = await this.#recovery.status();
    return {
      ...status,
      ...(status.state === "degraded"
        ? { resetImpact: WORKSPACE_CATALOG_RESET_IMPACT }
        : {}),
    };
  }

  async list(): Promise<LocalWorkspaceView[]> {
    return this.#withControl(`workspace-list:${randomUUID()}`, async (control) =>
      (await this.#admin.list(control)).map(toView),
    );
  }

  async create(
    displayName: string,
    absolutePath: string,
    authority?: LocalWorkspaceOperationAuthority,
  ): Promise<LocalWorkspaceView> {
    return this.#withControl(
      authority?.requestNonce ?? `workspace-create:${randomUUID()}`,
      async (control) =>
        toView(
          await this.#admin.create({ displayName, absolutePath }, control),
        ),
      authority?.abort,
    );
  }

  async authorizeForControl(
    displayName: string,
    absolutePath: string,
    authority?: LocalWorkspaceOperationAuthority,
  ): Promise<{ deviceId: string; bindingRef: string }> {
    const binding = await this.#withControl(
      authority?.requestNonce ?? `workspace-authorize:${randomUUID()}`,
      (control) => this.#admin.create({ displayName, absolutePath }, control),
      authority?.abort,
    );
    return { deviceId: this.#deviceId, bindingRef: binding.bindingRef };
  }

  async rename(
    currentName: string,
    displayName: string,
    expectedRevision: number,
    authority?: LocalWorkspaceOperationAuthority,
  ): Promise<LocalWorkspaceView> {
    return this.#withControl(
      authority?.requestNonce ?? `workspace-rename:${randomUUID()}`,
      async (control) => {
        const current = await this.#bindingByName(currentName, control);
        return toView(
          await this.#admin.update(
            current.bindingRef,
            { displayName },
            expectedRevision,
            control,
          ),
        );
      },
      authority?.abort,
    );
  }

  async repath(
    name: string,
    absolutePath: string,
    expectedRevision: number,
    authority?: LocalWorkspaceOperationAuthority,
  ): Promise<LocalWorkspaceView> {
    return this.#withControl(
      authority?.requestNonce ?? `workspace-repath:${randomUUID()}`,
      async (control) => {
        const current = await this.#bindingByName(name, control);
        return toView(
          await this.#admin.update(
            current.bindingRef,
            { absolutePath },
            expectedRevision,
            control,
          ),
        );
      },
      authority?.abort,
    );
  }

  async remove(
    name: string,
    expectedRevision: number,
    authority?: LocalWorkspaceOperationAuthority,
  ): Promise<void> {
    await this.#withControl(
      authority?.requestNonce ?? `workspace-remove:${randomUUID()}`,
      async (control) => {
        const current = await this.#bindingByName(name, control);
        await this.#admin.remove(
          current.bindingRef,
          expectedRevision,
          control,
        );
      },
      authority?.abort,
    );
  }

  async reset(
    expectedCatalogGeneration: string,
    confirmedImpact: string,
    authority?: LocalWorkspaceOperationAuthority,
  ): Promise<WorkspaceBindingResetReceipt> {
    if (confirmedImpact !== WORKSPACE_CATALOG_RESET_IMPACT) {
      throw new TypeError("工作区目录恢复确认内容不完整");
    }
    const requestNonce = authority?.requestNonce ?? `workspace-reset:${randomUUID()}`;
    const requestId = localEnvironmentControlSubject(
      this.#deviceId,
      requestNonce,
    );
    const abort = authority?.abort ?? new AbortController().signal;
    await this.#withLease(requestId, async (lease) => {
      await this.#recovery.beginReset(
        { expectedCatalogGeneration },
        {
          requestId,
          lease,
          abort,
          confirmation: {
            kind: "workspace-binding-reset",
            token: authority?.confirmationToken ?? randomBytes(32).toString("base64url"),
            requestId,
            catalogGeneration: expectedCatalogGeneration,
            issuedAt: new Date().toISOString(),
          },
        },
      );
    });
    return this.#recovery.completeReset(
      requestId,
      abort,
    );
  }

  async #bindingByName(
    displayName: string,
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding> {
    const matches = (await this.#admin.list(control)).filter(
      (binding) => binding.displayName === displayName,
    );
    if (matches.length !== 1) {
      throw new LocalWorkspaceBusinessError(
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

  #withControl<T>(
    requestNonce: string,
    operation: (control: LocalEnvironmentControlContext) => Promise<T>,
    abort = new AbortController().signal,
  ): Promise<T> {
    const requestId = localEnvironmentControlSubject(
      this.#deviceId,
      requestNonce,
    );
    return this.#withLease(requestId, (lease) =>
      operation({
        requestId,
        lease,
        abort,
      }),
    );
  }

  async #withLease<T>(
    requestId: string,
    operation: (lease: ImmediateRootResourceLease) => Promise<T>,
  ): Promise<T> {
    const context: AuthorityCallContext = {
      principal: { kind: "host", component: "resource-governor" },
      requestId,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const lease = await this.#resources.acquireRoot(
      { kind: "control", id: requestId, attempt: 1 },
      CONTROL_BUDGET,
      { admissionClass: "interactive", entry: "environment-control" },
      context,
      { executorId: this.#executorId },
    );
    let failed = true;
    try {
      const result = await operation(lease);
      failed = false;
      return result;
    } finally {
      try {
        await this.#resources.settle(lease, context);
      } finally {
        await this.#resources.release(lease, context).catch((error) => {
          if (!failed) throw error;
        });
      }
    }
  }
}

function toView(binding: LocalWorkspaceBinding): LocalWorkspaceView {
  return {
    name: binding.displayName,
    path: binding.absolutePath,
    revision: binding.revision,
    workspaceBindingRevision: binding.workspaceBindingRevision,
  };
}
