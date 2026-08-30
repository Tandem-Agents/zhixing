import { describe, expect, it, vi } from "vitest";
import {
  CompletedWorkspaceAdministrationOperationError,
  type WorkspaceAdministrationConsumptionCredential,
} from "@zhixing/core/environment/workspace-administration";
import {
  type LocalWorkspaceClient,
} from "./local-workspace-management-host.js";
import {
  createWorksceneAndReadWorkspaceView,
  useLocalWorkspaceClient,
} from "./workspace-command.js";

const credential: WorkspaceAdministrationConsumptionCredential = {
  outboxId: "outbox-a",
  localSeq: 1,
  operationId: "workspace-operation-a",
  inputDigest: "sha256:input",
  resultDigest: "sha256:result",
};

function client(confirmDelivered: () => Promise<void>): LocalWorkspaceClient {
  return {
    status: vi.fn(),
    list: vi.fn(),
    viewByName: vi.fn(),
    create: vi.fn(),
    authorizeForControl: vi.fn(),
    rename: vi.fn(),
    repath: vi.fn(),
    remove: vi.fn(),
    previewReset: vi.fn(),
    confirmReset: vi.fn(),
    consumptionCredential: () => credential,
    confirmDelivered,
  };
}

describe("useLocalWorkspaceClient", () => {
  it("confirms a completed business failure only after its delivery callback succeeds", async () => {
    const order: string[] = [];
    const failure = new CompletedWorkspaceAdministrationOperationError(
      "WORKSPACE_POLICY_REJECTED",
      "rejected by policy",
    );
    await expect(
      useLocalWorkspaceClient(
        client(async () => {
          order.push("confirmed");
        }),
        async () => {
          throw failure;
        },
        {
          result: vi.fn(),
          recovered: vi.fn(),
          failure: async (error, deliveredCredential) => {
            expect(error).toBe(failure);
            expect(deliveredCredential).toEqual(credential);
            order.push("delivered");
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(order).toEqual(["delivered", "confirmed"]);
    expect(failure.deliveryConfirmed).toBe(true);
  });

  it("retains a completed business failure when its delivery callback fails", async () => {
    const confirmDelivered = vi.fn(async () => undefined);
    const deliveryFailure = new Error("presentation unavailable");
    const failure = new CompletedWorkspaceAdministrationOperationError(
      "WORKSPACE_POLICY_REJECTED",
      "rejected by policy",
    );
    await expect(
      useLocalWorkspaceClient(
        client(confirmDelivered),
        async () => {
          throw failure;
        },
        {
          result: vi.fn(),
          recovered: vi.fn(),
          failure: async () => {
            throw deliveryFailure;
          },
        },
      ),
    ).rejects.toBe(deliveryFailure);
    expect(confirmDelivered).not.toHaveBeenCalled();
    expect(failure.deliveryConfirmed).toBe(false);
  });
});

describe("createWorksceneFromLocalWorkspaceAuthorization", () => {
  it("creates with the legacy authorization wire and then reads the domain view when metadata is absent", async () => {
    const order: string[] = [];
    const scene = { sceneId: "scene-a", name: "Paper" };
    const create = vi.fn(async () => {
      order.push("create");
      return scene as never;
    });
    const workspace = client(async () => undefined);
    vi.mocked(workspace.viewByName).mockImplementation(async () => {
      order.push("view");
      return {
        name: "Paper",
        path: "C:\\paper",
        revision: 1,
        workspaceBindingRevision: 7,
      };
    });

    await expect(
      createWorksceneAndReadWorkspaceView(
        { create },
        workspace,
        "Paper",
        {
          deviceId: "device-a",
          bindingRef: "binding-a",
        },
        credential,
      ),
    ).resolves.toEqual({
      scene,
      authorization: { deviceId: "device-a", bindingRef: "binding-a" },
      workspace: {
        name: "Paper",
        path: "C:\\paper",
        revision: 1,
        workspaceBindingRevision: 7,
      },
    });
    expect(create).toHaveBeenCalledWith(
      "Paper",
      { deviceId: "device-a", bindingRef: "binding-a" },
      expect.stringMatching(/^workscene-create:sha256:/u),
    );
    expect(workspace.viewByName).toHaveBeenCalledWith("Paper");
    expect(workspace.list).not.toHaveBeenCalled();
    expect(order).toEqual(["create", "view"]);
  });
});
