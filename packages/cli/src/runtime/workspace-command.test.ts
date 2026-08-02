import { describe, expect, it, vi } from "vitest";
import {
  CompletedLocalWorkspaceOperationError,
  type LocalWorkspaceClient,
  type LocalWorkspaceConsumptionCredential,
} from "./local-workspace-management-host.js";
import { useLocalWorkspaceClient } from "./workspace-command.js";

const credential: LocalWorkspaceConsumptionCredential = {
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
    const failure = new CompletedLocalWorkspaceOperationError(
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
    const failure = new CompletedLocalWorkspaceOperationError(
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
