import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import type { CoreHostLink } from "./core-host-connection.js";
import { readLocalWorkspaceTransfer } from "./local-workspace-transfer.js";
import { RpcLocalWorkspaceFacade } from "./rpc-local-workspace-facade.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

describe("RpcLocalWorkspaceFacade", () => {
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.ZHIXING_HOME;
    process.env.ZHIXING_HOME = await createTempDir("local-workspace-facade");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = previousHome;
  });

  it("hands raw paths to the co-located host without placing them on RPC", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const link = fakeLink(async (method, params) => {
      calls.push({ method, params });
      const token = (params as { transferToken: string }).transferToken;
      const transfer = await readLocalWorkspaceTransfer(token);
      return {
        bindingRef: "binding-a",
        revision: 1,
        displayName: transfer.displayName,
        absolutePath: transfer.absolutePath,
        workspaceBindingRevision: 1,
        deviceId: "device-a",
      };
    });
    const facade = new RpcLocalWorkspaceFacade(link);
    const target = "C:\\private\\project";

    await expect(facade.create("Project", target)).resolves.toMatchObject({
      bindingRef: "binding-a",
      deviceId: "device-a",
    });
    expect(calls[0]?.method).toBe("workscene.authorizeLocalWorkspace");
    expect(JSON.stringify(calls[0]?.params)).not.toContain(target);
    expect(JSON.stringify(calls[0]?.params)).not.toContain("absolutePath");
  });

  it("uses a token for repath and requires the exact reset impact", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const link = fakeLink(async (method, params) => {
      calls.push({ method, params });
      if (method === "workspace.localRepath") {
        const token = (params as { transferToken: string }).transferToken;
        const transfer = await readLocalWorkspaceTransfer(token);
        return {
          bindingRef: "binding-a",
          revision: 2,
          displayName: "Project",
          absolutePath: transfer.absolutePath,
          workspaceBindingRevision: 2,
        };
      }
      return {
        requestId: (params as { requestId: string }).requestId,
        confirmationDigest: "sha256:confirmation",
        previousCatalogGeneration: "catalog-a",
        catalogGeneration: "catalog-b",
        logId: "log-b",
        capabilityRevision: 2,
        preparedAt: "2026-07-30T00:00:00.000Z",
      };
    });
    const facade = new RpcLocalWorkspaceFacade(link);
    const target = "C:\\private\\next";

    await facade.repath("binding-a", target, 1);
    expect(JSON.stringify(calls[0]?.params)).not.toContain(target);
    await expect(
      facade.reset("catalog-a", "partial confirmation"),
    ).rejects.toThrow("确认内容不完整");
    await expect(
      facade.reset("catalog-a", WORKSPACE_CATALOG_RESET_IMPACT),
    ).resolves.toMatchObject({ catalogGeneration: "catalog-b" });
  });
});

function fakeLink(
  request: (method: string, params: unknown) => Promise<unknown>,
): CoreHostLink {
  return {
    async getClient() {
      return { request } as never;
    },
    onNotification: vi.fn(() => () => {}),
  };
}
