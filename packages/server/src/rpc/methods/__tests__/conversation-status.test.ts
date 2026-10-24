import { describe, expect, it, vi } from "vitest";
import { buildBuiltinRegistry } from "../index.js";
import { RPC_ERROR_CODES } from "../../protocol.js";

describe("session.statusHistory", () => {
  it('routes current control targets without permitting history payload or unauthenticated access', async () => {
    const read = vi.fn(async () => ({ targets: [] })), registry = buildBuiltinRegistry();
    const context = { connection: { authenticated: true }, server: { serverInfoRuntime: { conversationRecovery: read } } };
    const request = { mode: 'control-targets', conversationId: 'conversation-b' };
    await expect(registry.dispatch('session.statusHistory', request, context as never)).resolves.toEqual({ targets: [] });
    expect(read).toHaveBeenCalledExactlyOnceWith(request);
    await expect(registry.dispatch('session.statusHistory', { ...request, historyRunIds: ['old'] }, context as never))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    context.connection.authenticated = false;
    await expect(registry.dispatch('session.statusHistory', request, context as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.UNAUTHORIZED });
  });
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


it('accepts bounded owner timeline cursors and rejects malformed history coverage', async () => {
  const read = vi.fn(async () => ({ fragments: [], hasMore: false, reset: false }));
  const registry = buildBuiltinRegistry(), context = { connection: { authenticated: true }, server: { serverInfoRuntime: { conversationRecovery: read } } };
  const history = { key: '0:9007199254740000:9007199254740991', throughLsn: 991 };
  const cursor = { conversationId: 'conversation-b', ownerEpoch: 2, revision: 1, message: 0, block: 0, offset: 0, history };
  const request = { mode: 'body-page', conversationId: 'conversation-b', includeInputs: true, cursor };
  await registry.dispatch('session.statusHistory', request, context as never);
  expect(read).toHaveBeenLastCalledWith(request);
  const through = { logId: 'authority-log', lsn: 991, frameEndOffset: 4096, prefixDigest: 'synthetic-proof' };
  const coverage = { mode: 'control-page', conversationId: 'conversation-b', historyThrough: through };
  await registry.dispatch('session.statusHistory', coverage, context as never);
  expect(read).toHaveBeenLastCalledWith(coverage);
  // 当前集合段的游标与按运行精确读取
  const phased = { mode: 'control-page', conversationId: 'conversation-b', cursor: { conversationId: 'conversation-b', ownerEpoch: 2, clearedThroughLsn: 0, baseItem: 0,
    historyThroughInputLsn: 991, current: { after: '"conversation-b":open-run:"r"' }, upper: through, after: through, item: 0 } };
  const facts = { mode: 'run-facts', conversationId: 'conversation-b', runIds: ['run-1', 'run-2'], historyThroughInputLsn: 991 };
  for (const valid of [phased, { ...phased, cursor: { ...phased.cursor, current: {} } }, facts]) {
    await registry.dispatch('session.statusHistory', valid, context as never);
    expect(read).toHaveBeenLastCalledWith(valid);
  }
  for (const invalid of [{ ...request, includeInputs: false }, ...[
    { ...history, key: '../../source' }, { ...history, throughLsn: -1 }, { ...history, throughLsn: 1.5 }, { ...history, after: false }, { ...history, artifact: 'caller-source' },
  ].map(history => ({ ...request, cursor: { ...cursor, history } })),
    { ...request, direction: 'forward', cursor: { ...cursor, history: { ...history, after: true } } }, { ...coverage, historyThrough: { ...through, lsn: -1 } },
    { ...coverage, historyThroughInputLsn: 991 }, { ...coverage, cursor: phased.cursor },
    { ...phased, cursor: { ...phased.cursor, current: { after: 3 } } }, { ...phased, cursor: { ...phased.cursor, current: { after: 'x', more: true } } },
    { ...phased, cursor: { ...phased.cursor, historyThroughInputLsn: undefined } },
    { ...facts, runIds: [] }, { ...facts, runIds: Array.from({ length: 33 }, (_, i) => 'run-' + i) }, { ...facts, runIds: [''] }, { ...facts, cursor: phased.cursor },
    { ...facts, historyThroughInputLsn: undefined }, { ...facts, historyThroughInputLsn: -1 }]) {
    await expect(registry.dispatch('session.statusHistory', invalid, context as never)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  }
  expect(read).toHaveBeenCalledTimes(5);
});
