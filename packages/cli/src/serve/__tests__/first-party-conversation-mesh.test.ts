import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "@zhixing/core/protocol";
import { FirstPartyConversationMeshTarget } from "../first-party-conversation-mesh.js";

describe("first-party conversation mesh", () => {
  it("relays only the finite canonical surface and closes the prior generation", async () => {
    const target = new FirstPartyConversationMeshTarget();
    let relay: { notify(method: string, params: unknown): void; onClose(handler: () => void): () => void } | undefined;
    const closed = vi.fn();
    const dispatch = vi.fn(async (input: { connection: typeof relay }) => {
      relay = input.connection;
      relay!.onClose(closed);
      return { items: [] };
    });
    target.bind({ dispatch } as never);
    const first = identity(1, "connection-1");

    const response = await target.handle(
      encode({
        v: 1,
        op: "dispatch",
        surface: first,
        method: "confirmation.list",
        params: { conversationId: "local-device-source-01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      }),
      { peer: { deviceId: "device-source" } } as never,
      new AbortController().signal,
    );
    expect(decode(response)).toMatchObject({ v: 1, ok: true, result: { items: [] } });
    relay!.notify("confirmation.pending", { requestId: "confirm-1" });
    expect(decode(await target.handle(
      encode({ v: 1, op: "poll", surface: first }),
      { peer: { deviceId: "device-source" } } as never,
      new AbortController().signal,
    ))).toMatchObject({
      ok: true,
      notifications: [{ method: "confirmation.pending", params: { requestId: "confirm-1" } }],
    });

    const next = identity(2, "connection-2");
    await target.handle(
      encode({ v: 1, op: "poll", surface: next }),
      { peer: { deviceId: "device-source" } } as never,
      AbortSignal.abort(),
    );
    expect(closed).toHaveBeenCalledTimes(1);

    const stale = decode(await target.handle(
      encode({ v: 1, op: "poll", surface: identity(1, "connection-stale") }),
      { peer: { deviceId: "device-source" } } as never,
      AbortSignal.abort(),
    ));
    expect(stale).toMatchObject({ ok: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary RPC and peer identity drift before dispatch", async () => {
    const target = new FirstPartyConversationMeshTarget();
    const dispatch = vi.fn();
    target.bind({ dispatch } as never);
    const result = decode(await target.handle(
      encode({
        v: 1,
        op: "dispatch",
        surface: identity(1, "connection-1"),
        method: "workspace.binding.admin",
        params: {},
      }),
      { peer: { deviceId: "another-device" } } as never,
      new AbortController().signal,
    ));
    expect(result).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function identity(generation: number, connectionId: string) {
  return {
    deviceId: "device-source",
    surfacePrincipal: "rpc:client-1",
    connectionId,
    generation,
    loopback: true,
  };
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value));
}

function decode(value: Uint8Array): unknown {
  return JSON.parse(Buffer.from(value).toString("utf8"));
}
