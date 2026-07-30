import { randomUUID } from "node:crypto";
import type {
  LocalWorkspaceBinding,
  WorkspaceBindingResetReceipt,
} from "@zhixing/core/contracts";
import type { CoreHostLink } from "./core-host-connection.js";
import {
  createLocalWorkspaceTransfer,
  removeLocalWorkspaceTransfer,
} from "./local-workspace-transfer.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

export interface LocalWorkspaceCatalogStatus {
  readonly state: "healthy" | "degraded";
  readonly catalogGeneration: string;
  readonly reason?: string;
  readonly resetImpact?: string;
}

/** Loopback-only settings facade. Raw paths never enter RPC payloads. */
export class RpcLocalWorkspaceFacade {
  constructor(private readonly link: CoreHostLink) {}

  async status(): Promise<LocalWorkspaceCatalogStatus> {
    const client = await this.link.getClient();
    return client.request("workspace.localStatus", {});
  }

  async list(): Promise<LocalWorkspaceBinding[]> {
    const client = await this.link.getClient();
    const result = await client.request<{
      workspaces: LocalWorkspaceBinding[];
    }>("workspace.localList", {});
    return result.workspaces;
  }

  async create(
    displayName: string,
    absolutePath: string,
  ): Promise<LocalWorkspaceBinding & { deviceId: string }> {
    const transfer = await createLocalWorkspaceTransfer({
      displayName,
      absolutePath,
    });
    try {
      const client = await this.link.getClient();
      return await client.request("workscene.authorizeLocalWorkspace", {
        transferToken: transfer.token,
      });
    } finally {
      await removeLocalWorkspaceTransfer(transfer.token).catch(() => {});
    }
  }

  async rename(
    bindingRef: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<LocalWorkspaceBinding> {
    const client = await this.link.getClient();
    return client.request("workspace.localRename", {
      bindingRef,
      displayName,
      expectedRevision,
      requestId: `workspace-rename:${randomUUID()}`,
    });
  }

  async repath(
    bindingRef: string,
    absolutePath: string,
    expectedRevision: number,
  ): Promise<LocalWorkspaceBinding> {
    const transfer = await createLocalWorkspaceTransfer({
      displayName: "workspace-repath",
      absolutePath,
    });
    try {
      const client = await this.link.getClient();
      return await client.request("workspace.localRepath", {
        bindingRef,
        expectedRevision,
        transferToken: transfer.token,
      });
    } finally {
      await removeLocalWorkspaceTransfer(transfer.token).catch(() => {});
    }
  }

  async remove(
    bindingRef: string,
    expectedRevision: number,
  ): Promise<void> {
    const client = await this.link.getClient();
    await client.request("workspace.localRemove", {
      bindingRef,
      expectedRevision,
      requestId: `workspace-remove:${randomUUID()}`,
    });
  }

  async reset(
    expectedCatalogGeneration: string,
    confirmedImpact: string,
  ): Promise<WorkspaceBindingResetReceipt> {
    if (confirmedImpact !== WORKSPACE_CATALOG_RESET_IMPACT) {
      throw new TypeError("工作区目录恢复确认内容不完整");
    }
    const requestId = `workspace-reset:${randomUUID()}`;
    const client = await this.link.getClient();
    return client.request("workspace.localReset", {
      expectedCatalogGeneration,
      requestId,
      confirmationToken: randomUUID(),
      confirmationIssuedAt: new Date().toISOString(),
      confirmedImpact,
    });
  }
}
