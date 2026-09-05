import {
  createSessionBroadcastTransport,
  type SessionBroadcastTransport,
} from "@zhixing/rpc/session-broadcast";
import { describe, expect, it, vi } from "vitest";
import { AnchorSessionBroadcastLifecycle } from "../anchor-session-broadcast-lifecycle.js";

describe("AnchorSessionBroadcastLifecycle", () => {
  it("keeps stable ports fail-closed until one Server transport is installed", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    const port = lifecycle.port;
    expect(() => port.session("conversation-1", "session.event", { seq: 1 }))
      .toThrow("not active");
    expect(() => port.activity(activity("conversation-1"))).toThrow("not active");

    const first = transport("first");
    lifecycle.install(first.transport);
    expect(lifecycle.port).toBe(port);
    port.session("conversation-1", "session.event", { seq: 1 });
    port.activity(activity("conversation-2"));
    expect(first.notifications).toEqual([
      ["first", "session.event", { seq: 1 }],
      ["first", "session.activity", activity("conversation-2")],
    ]);
    expect(() => lifecycle.install(transport("duplicate").transport))
      .toThrow("already installed");
  });

  it("rejects a structurally forged transport without Server provenance", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    expect(() => lifecycle.install({
      session: vi.fn(),
      activity: vi.fn(),
    } as SessionBroadcastTransport)).toThrow("no Server provenance");
  });

  it("does not let a stale generation release its successor", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    const first = transport("first");
    const firstLease = lifecycle.install(first.transport);
    firstLease.release();

    const second = transport("second");
    const secondLease = lifecycle.install(second.transport);
    firstLease.release();
    lifecycle.port.session("conversation-1", "session.changed", { revision: 2 });
    expect(first.notifications).toEqual([]);
    expect(second.notifications).toEqual([
      ["second", "session.changed", { revision: 2 }],
    ]);

    secondLease.release();
    expect(() => lifecycle.port.session("conversation-1", "session.event", {}))
      .toThrow("not active");
  });

  it("releases the active generation once and cannot be reactivated after close", () => {
    const lifecycle = new AnchorSessionBroadcastLifecycle();
    lifecycle.install(transport("active").transport);
    lifecycle.close();
    lifecycle.close();
    expect(() => lifecycle.port.activity(activity("conversation-1")))
      .toThrow("not active");
    expect(() => lifecycle.install(transport("late").transport)).toThrow("closed");
  });
});

function transport(label: string): {
  readonly transport: SessionBroadcastTransport;
  readonly notifications: unknown[][];
} {
  const notifications: unknown[][] = [];
  const connection = {
    id: label,
    authenticated: true,
    closed: false,
    notify(method: string, params: unknown) {
      notifications.push([label, method, params]);
    },
  };
  return {
    transport: createSessionBroadcastTransport({
      connections: new Set([connection]),
      observerConnectionIds: (conversationId: string) =>
        conversationId === "conversation-1"
          ? new Set([label])
          : new Set<string>(),
    }),
    notifications,
  };
}

function activity(conversationId: string) {
  return {
    conversationId,
    source: "test",
    lastActiveAt: "2026-08-24T00:00:00.000Z",
    unreadHint: true,
    listInvalidated: true,
  } as const;
}
