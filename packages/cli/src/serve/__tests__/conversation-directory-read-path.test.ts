import { describe, expect, it, vi } from 'vitest';
import { ConversationProtocolRuntime } from '../conversation-protocol-runtime.js';
import { createLocalConversationDirectoryApplication } from '../local-conversation-directory-application.js';

describe('directory production query path', () => {
  it('uses compact owner metadata for repeated cold queries, never full run replay', async () => {
    const replay = vi.fn(() => { throw Error('directory must not recover RunProjection'); });
    const metadata = vi.fn(async (key: string) => ({ deleted: key.includes('deleted'), count: 100000, baseRevision: 100000,
      clearedThrough: 0, name: key.split(':')[0], activity: '2026-10-09T00:00:00.000Z' }));
    const owner = { ownerEpoch: 1, deviceId: 'device', executorId: 'executor', signer: {}, verifier: {}, artifacts: {},
      acceptsConversationId: () => true,
      controlAdmission: { listCreatedConversationIds: async () => ['one', 'two', 'three', 'deleted'] },
      authorityLog: { durableProjection: () => ({ get: metadata }), readProjection: replay } };
    for (let cold = 0; cold < 2; cold++) {
      const protocol = new ConversationProtocolRuntime({ owner, manager: () => undefined, executorDispatch: {}, assignmentArtifactAuthority: {},
        losslessDataPlane: { kind: 'absent', reason: 'executor-only' }, recoverAuxiliary: async () => {}, interactions: {} } as any);
      const app = createLocalConversationDirectoryApplication({ owner: { listConversations: () => protocol.listSessions(),
        sessionState: protocol.sessionState, runtimeState: () => undefined } as any, observerCount: () => 0 });
      expect(await protocol.listSessions()).toEqual(['one', 'three', 'two']);
      expect(await protocol.sessionExists('deleted')).toBe(false);
      await app.queryList({ limit: 1 }); await app.queryList({ limit: 1 });
    }
    expect(metadata).toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled();
  });
});
