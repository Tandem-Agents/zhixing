import { describe, expect, it, vi } from "vitest";
import { buildBuiltinRegistry } from "../index.js";
import { RPC_ERROR_CODES } from "../../protocol.js";

describe("session.statusHistory", () => {
  const params = { conversationId: "conversation-b", cursors: [{ runId: "run-b", afterStatusRevision: 2 }] };

  it("projects the current owner's status and retained end cursor without opening finality", async () => {
    const page = { notices: [], next: [{ conversationId: params.conversationId, ...params.cursors[0] }] };
    const read = vi.fn(async () => page), open = vi.fn();
    const registry = buildBuiltinRegistry();
    const context = { connection: { authenticated: true }, server: { serverInfoRuntime: { conversationStatus: read, openFirstPartyFinality: open } } };
    await expect(registry.dispatch("session.statusHistory", params, context as never)).resolves.toEqual(page);
    expect(read).toHaveBeenCalledExactlyOnceWith(page.next);
    expect(open).not.toHaveBeenCalled();
    context.connection.authenticated = false;
    await expect(registry.dispatch("session.statusHistory", params, context as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.UNAUTHORIZED });
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects malformed, unbounded, duplicate and cross-conversation cursors before reading", async () => {
    const read = vi.fn();
    const context = { connection: { authenticated: true }, server: { serverInfoRuntime: { conversationStatus: read } } };
    const registry = buildBuiltinRegistry();
    for (const value of [null, {}, { ...params, cursors: [] },
      { ...params, cursors: Array.from({ length: 65 }, (_, i) => ({ runId: `r-${i}`, afterStatusRevision: 0 })) },
      { ...params, cursors: [params.cursors[0], params.cursors[0]] },
      ...[-1, 0.5, "0", null].map(revision => ({ ...params, cursors: [{ runId: "r", afterStatusRevision: revision }] })),
      { ...params, cursors: [{ ...params.cursors[0], conversationId: "other" }] },
    ]) {
      await expect(registry.dispatch("session.statusHistory", value, context as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    }
    expect(read).not.toHaveBeenCalled();
    await expect(registry.dispatch("session.statusHistory", params, { connection: { authenticated: true }, server: {} } as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.BUSY });
  });
});
