import { describe, expect, it, vi } from "vitest";
import { projectSessionTurn } from "@zhixing/rpc/session-turn-stream";
import {
  createServerConfirmationBinding,
  createServerConversationBinding,
} from "./server-product-bindings.js";

vi.mock("@zhixing/rpc/session-turn-stream", () => ({
  projectSessionTurn: vi.fn(async () => undefined),
}));

describe("Server product bindings", () => {
  it("clips owner state and executes a turn without exposing ManagedSession", async () => {
    const managed = { turnCount: 7, internal: "must-not-cross" };
    const observerIds = new Set(["connection-1"]);
    const manager = {
      getSession: () => managed,
      getObserverConnectionIds: () => observerIds,
      list: () => [{
        conversationId: "conversation-1",
        busy: true,
        pendingCount: 2,
        internal: "must-not-cross",
      }],
    };
    const binding = createServerConversationBinding(manager as never);
    const abortSignal = new AbortController().signal;
    const notify = vi.fn();
    const onPostTurnControlIntent = vi.fn();
    const userInput = { content: "hello" } as never;
    const turnContext = { turnId: "turn-1" } as never;

    expect(binding.list()).toEqual([{
      conversationId: "conversation-1",
      busy: true,
      pendingCount: 2,
    }]);
    expect(binding).not.toHaveProperty("getSession");
    expect(binding.getObserverConnectionIds("conversation-1")).not.toBe(
      observerIds,
    );

    await binding.executeTurn({
      conversationId: "conversation-1",
      userInput,
      turnId: "turn-1",
      abortSignal,
      turnContext,
      surfacePrincipal: "surface-1",
      notify,
      onPostTurnControlIntent,
    });
    expect(projectSessionTurn).toHaveBeenCalledOnce();
    expect(projectSessionTurn).toHaveBeenCalledWith(expect.objectContaining({
      manager,
      managed,
      input: userInput,
      turnId: "turn-1",
      runOptions: {
        abortSignal,
        turnContext,
        surfacePrincipal: "surface-1",
        turnIndex: 7,
        source: "interactive",
      },
      notify,
      abortSignal,
      onPostTurnControlIntent,
    }));
  });

  it("clips HubEntry internals and forwards durable confirmation resolution", async () => {
    const request = { id: "request-1" };
    const pending = {
      request,
      conversationId: "conversation-1",
      brokerId: "must-not-cross",
    };
    const resolveDurably = vi.fn(async () => true);
    const hub = {
      listAllPending: () => [pending],
      findEntry: (requestId: string) => requestId === "request-1" ? pending : undefined,
      resolveDurably,
    };

    const binding = createServerConfirmationBinding(hub as never);

    const expected = { request, conversationId: "conversation-1" };
    expect(binding.listPending()).toEqual([expected]);
    expect(binding.findPending("request-1")).toEqual(expected);
    expect(binding.findPending("request-1")).not.toHaveProperty("brokerId");
    await expect(binding.resolve("request-1", { kind: "allow-once" }))
      .resolves.toBe(true);
    expect(resolveDurably).toHaveBeenCalledWith("request-1", {
      kind: "allow-once",
    });
  });
});
