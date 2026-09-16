import { describe, expect, it, vi } from "vitest";
import type { MeshServiceClient } from "@zhixing/mesh";
import type { MeshServiceDefinition, MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  createMeshConversationCommunication,
  createMeshRunInput,
  registerConversationCommunicationMesh,
} from "../conversation-communication-mesh.js";

describe("conversation communication mesh binding", () => {
  function harness() {
    let service!: MeshServiceDefinition;
    const registry = {
      register: (_id: string, definition: MeshServiceDefinition) => {
        service = definition;
        return () => {};
      },
    } as MeshServiceRegistry;
    const message = {
      role: "user",
      content: [{ type: "text", text: "来自 A" }],
      inputIdentity: { id: "msg-a", source: { kind: "conversation", conversationId: "a" } },
    };
    const port = {
      open: vi.fn(async () => {}),
      receive: vi.fn(async () => [message]),
      close: vi.fn(async () => {}),
    };
    const invoke = vi.fn(async (_source: string, _request: unknown) => ({
      accepted: true,
      messageId: "msg-a",
      runId: "b-run",
      conversationId: "b",
    }));
    const inputFor = vi.fn(async () => port);
    registerConversationCommunicationMesh({
      registry,
      communication: { invoke },
      inputFor,
      authorizePeer: (id) => id === "executor",
    });
    const peer = { peer: { deviceId: "executor" } } as never;
    const request = vi.fn(async (_id: string, payload: Uint8Array) =>
      service.handler(payload, peer, new AbortController().signal),
    );
    return {
      service,
      client: { request } as unknown as MeshServiceClient,
      port,
      invoke,
      inputFor,
      message,
    };
  }

  it("carries stable communication identities and next-Turn inputs through the transport", async () => {
    const h = harness();
    const communication = createMeshConversationCommunication(() => h.client);
    const request = {
      action: "send" as const,
      conversationId: "b",
      operationId: "send-op",
      input: "hello",
    };
    expect(await communication.invoke("a", request)).toMatchObject({
      accepted: true,
      messageId: "msg-a",
    });
    expect(h.invoke).toHaveBeenCalledWith("a", request);
    expect(h.port.open).not.toHaveBeenCalled();
    const address = { conversationId: "b", runId: "b-run", assignmentId: "b-assignment" };
    const input = await createMeshRunInput(() => h.client, address);
    expect(h.inputFor).toHaveBeenCalledWith(address, "executor");
    expect(h.port.open).toHaveBeenCalledOnce();
    expect(await input.receive({ boundary: 2, closing: false })).toEqual([h.message]);
    expect(h.port.receive).toHaveBeenCalledWith({ boundary: 2, closing: false });
    await input.close();
    expect(h.port.close).toHaveBeenCalledOnce();
  });

  it("rejects invalid transport input before executing an application command", async () => {
    const h = harness();
    await expect(
      createMeshConversationCommunication(() => h.client).invoke("a", {
        action: "send",
        conversationId: "b",
        input: "text",
        operationId: "op",
        source: "forged",
      } as never),
    ).rejects.toThrow("参数无效");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.service.authorize?.({ peer: { deviceId: "unknown" } } as never)).toBe(false);
  });

  it("does not turn invalid or failed remote input into an empty successful receive", async () => {
    const h = harness();
    const input = await createMeshRunInput(() => h.client, {
      conversationId: "b",
      runId: "r",
      assignmentId: "ass",
    });
    h.port.receive.mockResolvedValueOnce([{ role: "invalid" }] as never);
    await expect(input.receive({ boundary: 1, closing: true })).rejects.toThrow();
    h.port.receive.mockRejectedValueOnce(new Error("stale assignment"));
    await expect(input.receive({ boundary: 2, closing: true })).rejects.toThrow("stale assignment");
  });
});
