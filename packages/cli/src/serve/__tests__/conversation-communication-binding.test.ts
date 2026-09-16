import { describe, expect, it, vi } from "vitest";
import { localConversationId } from "@zhixing/core/conversation";
import { routeAddressedConversationCommunication } from "../conversation-communication-binding.js";
import type { ConversationCommunicationTransport } from "../conversation-tools.js";

describe("communication current-owner routing", () => {
  const id = localConversationId("device-original", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  it.each(["read", "send", "observe"] as const)("routes %s from a third executor through Anchor after the original device has been removed", async (action) => {
    const accepted = { status: "accepted", messageId: "message-stable" };
    const invoke = vi.fn(async () => accepted);
    const request = action === "send" ? { action, conversationId: id, operationId: "stable", input: "核实" }
      : action === "observe" ? { action, conversationId: id, messageId: "message-stable" } : { action, conversationId: id };
    const routeAtAnchor: ConversationCommunicationTransport = { invoke: (source, request) => {
      if (request.action === "discover") throw new Error("unexpected discovery");
      return routeAddressedConversationCommunication({ deviceId: "device-anchor", anchorDeviceId: "device-anchor", members: ["device-anchor", "device-third"],
        anchor: { communication: { invoke }, owns: async conversation => conversation === id }, remote: () => { throw new Error("removed device must not be contacted"); },
      }, source, request);
    } };
    const remote = vi.fn((deviceId: string) => { expect(deviceId).toBe("device-anchor"); return routeAtAnchor; });
    await expect(routeAddressedConversationCommunication({ deviceId: "device-third", anchorDeviceId: "device-anchor", members: ["device-anchor", "device-third"], remote }, "source-a", request)).resolves.toBe(accepted);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("source-a", request);
  });

  it("forwards an unadopted address from Anchor to its original owner, without rewriting identity", async () => {
    const invoke = vi.fn(async () => "original");
    const remote = vi.fn(() => ({ invoke }));
    const request = { action: "read" as const, conversationId: id };
    await expect(routeAddressedConversationCommunication({ deviceId: "device-anchor", anchorDeviceId: "device-anchor", members: ["device-original"], remote,
      anchor: { communication: { invoke: vi.fn() }, owns: async () => false },
    }, "source", request)).resolves.toBe("original");
    expect(remote).toHaveBeenCalledWith("device-original");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("source", request);
  });

  it.each(["frozen", "importing"] as const)("does not bypass the local %s fence", async (state) => {
    const invoke = vi.fn(); const remote = vi.fn();
    await expect(routeAddressedConversationCommunication({ deviceId: "device-original", anchorDeviceId: "device-anchor", members: ["device-original"], remote,
      local: { communication: { invoke }, owner: { currentAuthority: async () => ({ state, deviceId: "device-original", ownerEpoch: 1 }) } },
    }, "source", { action: "read", conversationId: id })).rejects.toThrow("接管中");
    expect(invoke).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled();
  });
});
