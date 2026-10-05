import { describe, expect, it, vi } from "vitest";
import { buildBuiltinRegistry } from "../index.js";
import { RPC_ERROR_CODES } from "../../protocol.js";

describe("session.statusHistory", () => {
  it('routes finite recovery reads through the authenticated current owner and validates checkpoint identities', async () => {
    const read = vi.fn(async () => ({ facts: [], hasMore: false, reset: false }));
    const registry = buildBuiltinRegistry();
    const context = { connection: { authenticated: true }, server: { serverInfoRuntime: { conversationRecovery: read } } };
    const point = { logId: 'authority-log', lsn: 11, frameEndOffset: 1024, prefixDigest: 'synthetic-proof' };
    const request = { mode: 'control-page', conversationId: 'conversation-b', cursor: { conversationId: 'conversation-b', ownerEpoch: 2, clearedThroughLsn: 0, baseItem: 0, upper: point, after: point, item: 3 } };
    await registry.dispatch('session.statusHistory', request, context as never);
    expect(read).toHaveBeenCalledExactlyOnceWith(request);
    for (const cursor of [{ ...request.cursor, item: -1 }, { ...request.cursor, baseItem: 0.5 }, { ...request.cursor, conversationId: 'another' }, { ...request.cursor, upper: { ...point, lsn: Infinity } }, { ...request.cursor, body: 'not metadata' }]) {
      await expect(registry.dispatch('session.statusHistory', { ...request, cursor }, context as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    }
    expect(read).toHaveBeenCalledOnce();
    const initial = { mode: 'control-page', conversationId: 'conversation-b', historyRunIds: ['shown-run'] };
    await registry.dispatch('session.statusHistory', initial, context as never);
    expect(read).toHaveBeenLastCalledWith(initial);
    for (const invalid of [{ ...initial, historyRunIds: Array(5).fill('shown-run') }, { ...initial, historyRunIds: [''] },
      { ...request, historyRunIds: ['shown-run'] }, { ...request, cursor: { ...request.cursor, historyThroughCommitRevision: -1 } }]) {
      await expect(registry.dispatch('session.statusHistory', invalid, context as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    }
    expect(read).toHaveBeenCalledTimes(2);
    context.connection.authenticated = false;
    await expect(registry.dispatch('session.statusHistory', request, context as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.UNAUTHORIZED });
  });
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
