import { randomBytes, randomUUID } from "node:crypto";
import type {
  WorkspaceBindingRecoveryPort,
  WorkspaceBindingResetReceipt,
} from "@zhixing/core/contracts";
import { localEnvironmentControlSubject } from "@zhixing/core/environment";
import type { WorkspaceAdministrationControlPort } from "@zhixing/core/environment/workspace-administration";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

export interface LocalWorkspaceCatalogStatus {
  readonly state: "healthy" | "degraded";
  readonly catalogGeneration: string;
  readonly reason?: string;
  readonly resetImpact?: string;
}

export interface LocalWorkspaceRecoveryAuthority {
  readonly requestNonce: string;
  readonly confirmationToken?: string;
  readonly abort?: AbortSignal;
}

export interface LocalWorkspaceRecoveryApplication {
  status(): Promise<LocalWorkspaceCatalogStatus>;
  reset(
    expectedCatalogGeneration: string,
    confirmedImpact: string,
    authority?: LocalWorkspaceRecoveryAuthority,
  ): Promise<WorkspaceBindingResetReceipt>;
}

export class LocalWorkspaceRecoveryBusinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalWorkspaceRecoveryBusinessError";
    this.code = code;
  }
}

/** Reset/recovery remains a separate local binding pending its own A5 package. */
export class LocalWorkspaceRecoveryService
  implements LocalWorkspaceRecoveryApplication
{
  readonly #deviceId: string;
  readonly #recovery: WorkspaceBindingRecoveryPort;
  readonly #control: WorkspaceAdministrationControlPort;

  constructor(input: {
    readonly deviceId: string;
    readonly recovery: WorkspaceBindingRecoveryPort;
    readonly control: WorkspaceAdministrationControlPort;
  }) {
    this.#deviceId = input.deviceId;
    this.#recovery = input.recovery;
    this.#control = input.control;
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

  async reset(
    expectedCatalogGeneration: string,
    confirmedImpact: string,
    authority?: LocalWorkspaceRecoveryAuthority,
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
    await this.#control.execute(requestId, abort, (control) =>
      this.#recovery.beginReset(
        { expectedCatalogGeneration },
        {
          ...control,
          confirmation: {
            kind: "workspace-binding-reset",
            token:
              authority?.confirmationToken ??
              randomBytes(32).toString("base64url"),
            requestId,
            catalogGeneration: expectedCatalogGeneration,
            issuedAt: new Date().toISOString(),
          },
        },
      ),
    );
    return this.#recovery.completeReset(requestId, abort);
  }
}
