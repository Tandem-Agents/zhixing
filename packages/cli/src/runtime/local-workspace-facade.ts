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
  ): Promise<LocalWorkspaceView> {
    return this.#withControl(
      `workspace-create:${randomUUID()}`,
      async (control) =>
        toView(
          await this.#admin.create({ displayName, absolutePath }, control),
        ),
    );
  }

  async authorizeForControl(
    displayName: string,
    absolutePath: string,
  ): Promise<{ deviceId: string; bindingRef: string }> {
    const binding = await this.#withControl(
      `workspace-authorize:${randomUUID()}`,
      (control) => this.#admin.create({ displayName, absolutePath }, control),
    );
    return { deviceId: this.#deviceId, bindingRef: binding.bindingRef };
  }

  async rename(
    currentName: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<LocalWorkspaceView> {
    return this.#withControl(
      `workspace-rename:${randomUUID()}`,
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
    );
  }

  async repath(
    name: string,
    absolutePath: string,
    expectedRevision: number,
  ): Promise<LocalWorkspaceView> {
    return this.#withControl(
      `workspace-repath:${randomUUID()}`,
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
    );
  }

  async remove(name: string, expectedRevision: number): Promise<void> {
    await this.#withControl(
      `workspace-remove:${randomUUID()}`,
      async (control) => {
        const current = await this.#bindingByName(name, control);
        await this.#admin.remove(
          current.bindingRef,
          expectedRevision,
          control,
        );
      },
    );
  }

  async reset(
    expectedCatalogGeneration: string,
    confirmedImpact: string,
  ): Promise<WorkspaceBindingResetReceipt> {
    if (confirmedImpact !== WORKSPACE_CATALOG_RESET_IMPACT) {
      throw new TypeError("工作区目录恢复确认内容不完整");
    }
    const requestNonce = `workspace-reset:${randomUUID()}`;
    const requestId = localEnvironmentControlSubject(
      this.#deviceId,
      requestNonce,
    );
    await this.#withLease(requestId, async (lease) => {
      await this.#recovery.beginReset(
        { expectedCatalogGeneration },
        {
          requestId,
          lease,
          abort: new AbortController().signal,
          confirmation: {
            kind: "workspace-binding-reset",
            token: randomBytes(32).toString("base64url"),
            requestId,
            catalogGeneration: expectedCatalogGeneration,
            issuedAt: new Date().toISOString(),
          },
        },
      );
    });
    return this.#recovery.completeReset(
      requestId,
      new AbortController().signal,
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
      throw new Error(
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
  ): Promise<T> {
    const requestId = localEnvironmentControlSubject(
      this.#deviceId,
      requestNonce,
    );
    return this.#withLease(requestId, (lease) =>
      operation({
        requestId,
        lease,
        abort: new AbortController().signal,
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
