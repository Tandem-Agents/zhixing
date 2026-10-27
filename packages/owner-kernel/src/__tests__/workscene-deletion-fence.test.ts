import path from 'node:path';
import { FileArtifactStore, FileAuthorityCommitLog } from '@zhixing/core/authority';
import type { GlobalControlCallContext, Signature } from '@zhixing/core/contracts';
import { protocolDigest } from '@zhixing/core/protocol';
import { AnchorWorksceneGlobalStateAdapter } from '@zhixing/core/workscene';
import { createTempDir } from '@zhixing/test-utils';
import { expect, it, onTestFinished } from 'vitest';
import { AnchorResourceGovernor } from '../resource-governor.js';
import { ControlAdmissionJournal, createInitialControlEnvelope } from '../control-admission.js';
import { ConversationRunJournal } from '../conversation-assignment.js';
import { trackAuthorityLog } from './durable-io-test-support.js';

const NOW = '2026-10-05T00:00:00.000Z';
const CONVERSATION = 'ws:scene-a:primary';
const signer = { sign(schema: string, version: number, payload: unknown): Signature { return { alg: 'test-sha256', keyId: 'device:test', sig: protocolDigest(schema, version, payload) }; } };
const verifier = { verify(schema: string, version: number, payload: unknown, signature: Signature) { expect(signature).toEqual(signer.sign(schema, version, payload)); } };

function context(requestId: string, expectedRevision?: number): GlobalControlCallContext {
  return {
    principal: { kind: 'host', component: 'workscene-fence-test' },
    requestId,
    authority: { domain: 'global', anchorEpoch: 1 },
    deadlineAt: '2026-10-05T01:00:00.000Z',
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  } as GlobalControlCallContext;
}

function inputRequest(log: FileAuthorityCommitLog, artifacts: FileArtifactStore, id: string) {
  const source = { principal: { surfacePrincipal: 'rpc:test', deviceId: 'device:test', connectionId: `input-${id}` },
    ingress: { kind: 'first-party' as const, surfacePrincipal: 'rpc:test', deviceId: 'device:test', ingressId: `ingress-${id}`, receivedAt: NOW } };
  const envelope = createInitialControlEnvelope({ requestId: `request-${id}`, source, at: NOW, body: { t: 'input',
    conversationId: CONVERSATION, ownerEpoch: 1, ingress: { ingressId: `ingress-${id}`, source: 'first-party' },
    input: { parts: [{ type: 'text', text: `input ${id}` }] }, invocation: { kind: 'agent', source: 'interactive' } } });
  return { admission: new ControlAdmissionJournal(log, artifacts), envelope, source, runId: `run-${id}` };
}

it('rejects input and reports the conversation deleted once its workscene is deleted, before any conversation tombstone', async () => {
  const root = await createTempDir('workscene-deletion-fence');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts, { clock: () => NOW }));
  // 场景删除的清理只确认完成、不写会话墓碑：留下“场景已删、会话尚未删除”的窗口
  const workscenes = new AnchorWorksceneGlobalStateAdapter({
    log, anchorEpoch: 1, removeScene: async () => {}, clock: () => NOW, sceneIdFactory: () => 'scene-a',
  });
  onTestFinished(() => workscenes.stop());
  const resources = new AnchorResourceGovernor({ log, signer, verifier, guard: { assert() {} }, anchorEpoch: 1,
    localExecutorId: 'device:test', reporterKeyFor: () => 'device:test', clock: () => NOW });
  const journal = new ConversationRunJournal({ conversationId: CONVERSATION, ownerEpoch: 1, log, artifacts, signer, verifier,
    resources, submission: { authenticate() {}, authorize() {} }, authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} }, clock: () => NOW });

  const created = await workscenes.mutate({ kind: 'workscene-create', name: 'Project' }, context('create'));
  if (created.kind !== 'workscene-applied') throw new Error('unexpected workscene result');
  expect(await journal.recoveryDeleted()).toBe(false);
  expect((await journal.applyInputControl(inputRequest(log, artifacts, 'before'))).kind).toBe('applied');

  await expect(workscenes.mutate(
    { kind: 'workscene-delete', sceneId: 'scene-a', expectedRevision: created.scene.revision },
    context('delete', created.scene.revision),
  )).resolves.toMatchObject({ kind: 'workscene-deleted' });
  expect(await journal.recoveryDeleted()).toBe(true);
  const after = await journal.applyInputControl(inputRequest(log, artifacts, 'after'));
  expect(after).toMatchObject({ kind: 'applied', result: { status: 'rejected', error: { code: 'fence-rejected' } } });
  // 同一请求重放保持同一拒绝，不在场景删除之后被接纳
  expect(await journal.applyInputControl(inputRequest(log, artifacts, 'after'))).toMatchObject({ kind: 'replayed' });
}, 60_000);
