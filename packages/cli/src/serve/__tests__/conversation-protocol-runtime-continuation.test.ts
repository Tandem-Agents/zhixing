// 拆分自 conversation-protocol-runtime.test.ts（按主题分文件以便并行执行）：continuation。
import { StorageMaintenanceAdmissionError } from "@zhixing/core/resources";
import { userTurnInputFromText, type Message } from "@zhixing/core";
import { protocolDigest } from "@zhixing/core/protocol";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import { createConversationControlEnvelope } from "@zhixing/owner-kernel/control-admission";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import { projectSessionTurn } from "@zhixing/rpc";
import type { PostTurnControlOutcome } from "@zhixing/core/types";
import { createTempDir } from "@zhixing/test-utils";
import { expect, it, vi, onTestFinished } from "vitest";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { FileMeshBootstrapStore } from "../mesh-bootstrap-store.js";
import { registerConversationReadProjection } from "../../../../owner-kernel/src/conversation-read-index.js";
import { stagingArea } from "../../../../owner-kernel/src/__tests__/imported-base-fixture.js";
import { ConversationTransferTarget, selectConversationAuthorityRecords, loadCommittedConversationBase } from "@zhixing/owner-kernel/conversation-transfer";
import { canonicalize, prepareConversationTransferManifest, createSignedSourceFreezeProof } from "@zhixing/core/protocol";
import { createLocalOwnerAssemblyFixture, fixtureLocalOwnerRuntime } from "./local-owner-assembly-fixture.js";
import { TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, registerActiveConversation, expectSettled, MemorySecretStore, worksceneContinuationHarness } from "./conversation-protocol-runtime-fixture.js";

it('retains cancelled-child advancement cleanup only until the durable session cancellation', async () => {
  const control: PostTurnControlOutcome = { intent: { kind: 'enter', sceneId: 'reports', handoff: { goal: 'report', constraints: [], completed: [], remaining: ['finish'] } } };
  const f = await worksceneContinuationHarness(undefined, { initialConversationId: 'main-handoff', firstControl: control, withAdvancement: true });
  onTestFinished(async () => { await f.protocol.stopRecoveryLoop(); await f.manager.disposeAll(); });
  await f.start(); await f.application.recover('main-handoff');
  const child = (await f.protocol.worksceneContinuationSources('ws:reports:primary'))[0]!;
  await f.protocol.cancel({ conversationId: child.conversationId, runId: child.runId, requestId: 'cancel-entrusted-child',
    principal: f.protocol.controlPrincipal({ surfacePrincipal: child.surfacePrincipal, connectionId: 'cancel-child' }) });
  f.protocol.releaseConversation(child.conversationId);
  const directory = registerConversationReadProjection(f.authority.authorityLog, f.authority.artifacts, f.authority.verifier);
  expect(await directory.get(JSON.stringify(child.conversationId) + ':continuation-advancement:' + JSON.stringify(child.runId)))
    .toEqual({ conversationId: 'main-handoff', sessionId: 'adv-continuation' });
  expect((await f.protocol.worksceneContinuationSources(child.conversationId))[0]?.state).toBe('cancelled');
  await f.application.recover(child.conversationId);
  expect(f.cancelAdvancement).toHaveBeenCalledOnce();
  expect(f.cancelAdvancement).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'main-handoff', advancementSessionId: 'adv-continuation' }));
  expect(await f.protocol.worksceneContinuationSources(child.conversationId)).toEqual([]);
  f.protocol.releaseConversation(child.conversationId); await f.application.recover(child.conversationId);
  expect(f.cancelAdvancement).toHaveBeenCalledOnce();
}, 120_000);

it.each([4, 16])('retires precisely stopped committed delegation history at scale %i', async size => {
  const handoff: PostTurnControlOutcome = { intent: { kind: 'enter', sceneId: 'reports', handoff: { goal: 'report', constraints: [], completed: [], remaining: ['finish'] } } };
  const f = await worksceneContinuationHarness(() => handoff);
  onTestFinished(async () => { await f.protocol.stopRecoveryLoop(); await f.manager.disposeAll(); });
  for (let i = 0; i < size; i++) {
    if (!i) await f.start();
    else {
      const managed = await f.manager.getOrCreate('main-handoff');
      expectSettled(await projectSessionTurn({ manager: f.manager, managed, text: 'next task', turnId: `task-${i}`,
        runOptions: { source: 'interactive', surfacePrincipal: 'rpc:owner', turnContext: { turnId: `task-${i}` } }, notify: () => {} }));
    }
    await f.application.recover('main-handoff');
    const source = (await f.protocol.worksceneContinuationSources('main-handoff')).at(-1)!;
    await f.protocol.cancel({ conversationId: source.conversationId, runId: source.runId, requestId: `precise-${i}`,
      principal: f.protocol.controlPrincipal({ surfacePrincipal: 'rpc:owner', connectionId: 'scale-stop' }) });
    await f.application.recover('main-handoff');
    expect((await f.protocol.worksceneContinuationSources(source.conversationId, { runId: source.runId }))[0]).toMatchObject({ state: 'committed', current: false });
  }
  f.protocol.releaseConversation('main-handoff'); f.protocol.releaseConversation('ws:reports:primary');
  const directory = registerConversationReadProjection(f.authority.authorityLog, f.authority.artifacts, f.authority.verifier);
  const scan = directory.scan.bind(directory); let rows = 0;
  const probe = vi.spyOn(directory, 'scan').mockImplementation(async (...args) => { const page = await scan(...args); rows += page.entries.length; return page; });
  try {
    expect(await f.protocol.worksceneContinuationSources('main-handoff')).toEqual([]);
    expect(await f.protocol.worksceneContinuationSources('ws:reports:primary')).toEqual([]);
    expect(await f.application.tasks('main-handoff')).toEqual([]);
    expect(rows).toBe(0);
    console.log('PRECISE_STOP_HISTORY', JSON.stringify({ size, rows }));
  } finally { probe.mockRestore(); }
}, 180_000);

it.each(['current', 'legacy'] as const)('continues a truly metered local conversation after %s adoption and cold restart', async format => {
  let executions = 0;
  const run: SessionRuntime['run'] = async function* (messages, options) {
    executions++;
    const meter = options?.modelCallResourceMeter;
    if (!meter) throw Error('Missing real resource meter');
    const usage = await meter.reserve({ callIndex: 1, tokenUpperBound: 8 });
    await meter.consume({ usageId: usage.usageId, tokens: 4 });
    const assistant: Message = { role: 'assistant', content: [{ type: 'text', text: `metered-${executions}` }] };
    yield { type: 'text_delta', text: `metered-${executions}` };
    return { agentResult: { reason: 'completed', message: assistant, usage: { inputTokens: 2, outputTokens: 2 } },
      runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage: { inputTokens: 2, outputTokens: 2 } },
      newMessages: [assistant], durationMs: 1 };
  };
  const f = await createLocalOwnerAssemblyFixture({ profile: 'anchor-executor', run });
  onTestFinished(async () => { await f.assembly.close(); await f.authority.startupCleanup.run(); });
  await f.assembly.start();
  const conversationId = await f.port.createConversation();
  expectSettled(await f.runTurn({ conversationId, text: 'before adoption', turnId: 'local-consume' }));
  const sourceLog = f.authority.executorLog, source = f.assembly.transferSource();
  const consumes = (await sourceLog.readAll()).flatMap(c => c.entries).filter(e => e.stream === 'governor' && (e.body as { t?: string }).t === 'consume');
  expect(consumes).toHaveLength(1); expect(consumes[0]!.body).toMatchObject({ tokens: 4 });
  const store = await FileMeshBootstrapStore.open(f.home, f.authority.identityKey, { secretStore: f.secretStore });
  await store.initializeLocalHome({ key: f.authority.identityKey, identity: f.authority.identity, roles: ['anchor', 'executor'], at: new Date().toISOString(), homeId: `metered-${format}` });
  await store.loadCurrentTrust();
  const transferId = 'xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const request = { requestId: 'adopt-metered', transferId, targetDeviceId: f.authority.deviceId, conversationId, sourceOwnerEpoch: 1 };
  const context = { principal: { kind: 'host' as const, component: 'legacy-export-fixture' }, requestId: 'snapshot', deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const snapshot = { meta: await f.port.sessionState.readSessionMeta(conversationId, context),
    taskList: await f.port.sessionState.readTaskList(conversationId, context),
    transcript: (await f.port.sessionState.readTranscriptTail(conversationId, context)).records,
    advancement: await f.port.sessionState.readAdvancementState(conversationId, context) };
  console.log('METERED_ADOPTION_PHASE', format, 'source prepare');
  await source.prepare(request);
  if (format === 'legacy') {
    // Historical serializer, before signing: domain facts retain their real
    // source LSN/time, but this format never carried native envelope provenance.
    const checkpoint = await sourceLog.checkpoint();
    const selected = await selectConversationAuthorityRecords(await sourceLog.readAll(), conversationId, f.authority.artifacts, f.authority.verifier);
    const records = selected.records.map(({ sourceItem: _item, sourceEnvelopeDigest: _digest, ...record }) => record);
    const recordsRef = await f.authority.artifacts.put(Buffer.from(canonicalize(records)));
    const sessionState = await f.authority.artifacts.put(Buffer.from(canonicalize(snapshot)));
    const streams = [...new Set(records.map(record => record.stream))].sort((a,b) => a.localeCompare(b)).map(stream => {
      const selected = records.filter(record => record.stream === stream);
      return { stream, firstLsn: selected[0]!.lsn, lastLsn: selected.at(-1)!.lsn, recordCount: selected.length,
        digest: protocolDigest('ConversationTransferLogicalStream', 1, { stream, records: selected }) };
    });
    const manifest = prepareConversationTransferManifest({ v: 1, ...request, sourceDeviceId: f.authority.deviceId, nextOwnerEpoch: 2,
      lastLsn: checkpoint.lsn, authorityBase: { checkpoint, records: recordsRef, sessionState, reducerVersion: 'conversation-session-state-v1' }, streams, contentAssets: selected.references });
    const manifestRef = await f.authority.artifacts.put(manifest.bytes);
    const proof = createSignedSourceFreezeProof({ v: 1, transferId, scope: 'conversation', subject: conversationId,
      sourceEpoch: 1, checkpointDigest: manifestRef.digest, lastLsn: checkpoint.lsn }, f.authority.signer);
    await sourceLog.append([{ stream: `transfer:${transferId}`, body: { v: 1, t: 'frozen', transferId, manifest: manifestRef, proof } }]);
  }
  console.log('METERED_ADOPTION_PHASE', format, 'source freeze');
  const frozen = await source.freeze(transferId);
  const target = new ConversationTransferTarget({ deviceId: f.authority.deviceId, log: f.authority.authorityLog, artifacts: f.authority.artifacts,
    staging: stagingArea(), signer: f.authority.signer, verifier: f.authority.verifier, isActiveSource: id => id === f.authority.deviceId,
    acceptsSourceConversationId: (device, id) => device === f.authority.deviceId && id === conversationId,
    conversationExists: () => false, sourceOwnerEpoch: () => 1, reducerVersion: 'conversation-session-state-v1' });
  await target.prepare({ v: 1, t: 'prepared', ...request, sourceDeviceId: f.authority.deviceId, nextOwnerEpoch: 2 });
  console.log('METERED_ADOPTION_PHASE', format, 'target import');
  await target.import({ transferId, manifestRef: frozen.manifestRef, proof: frozen.proof, source: source.readPort });
  const originalTransaction = f.authority.authorityLog.transactProjection.bind(f.authority.authorityLog);
  const legacyWriter = format === 'legacy' ? vi.spyOn(f.authority.authorityLog, 'transactProjection').mockImplementation(async (...args: any[]) => {
    const decide = args[2];
    args[2] = async (...input: any[]) => {
      const result = await decide(...input);
      if (result.kind !== 'append') return result;
      return { ...result, entries: result.entries.map((entry: any) => {
        if (entry.body.t !== 'conversation-transfer-committed-base') return entry;
        const { ownerBasis: _basis, ...body } = entry.body; return { ...entry, body: { ...body, v: 1 } };
      }) };
    };
    return (originalTransaction as any)(...args);
  }) : undefined;
  console.log('METERED_ADOPTION_PHASE', format, 'target commit');
  let committed;
  try { committed = await target.commit(transferId); } finally { legacyWriter?.mockRestore(); }
  console.log('METERED_ADOPTION_PHASE', format, 'source accept');
  await source.acceptCommit({ manifest: frozen.manifest, commit: committed.commit });
  expect((await f.authority.authorityLog.readAll()).flatMap(c => c.entries).some(e => e.stream === 'governor' && (e.body as { t?: string }).t === 'consume')).toBe(false);
  console.log('METERED_ADOPTION_PHASE', format, 'source close');
  await f.assembly.close(); await store.stopStorageMaintenance(); await f.authority.startupCleanup.run();

  console.log('METERED_ADOPTION_PHASE', format, 'target restart');
  const authority = await setupAuthorityRuntime({ zhixingHome: f.home, secretStore: f.secretStore });
  let manager!: ConversationManager;
  const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
  const factory: RuntimeFactory = { create: async id => ({ ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: id, run, abort: () => false, async dispose() {} }) };
  manager = new ConversationManager(factory, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {},
    appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: 'owner-log', appended: true }) });
  onTestFinished(async () => { await protocol.stopRecoveryLoop(); await manager.disposeAll(); });
  console.log('METERED_ADOPTION_PHASE', format, 'target base');
  const restored = await loadCommittedConversationBase(authority.authorityLog, authority.artifacts, authority.verifier, transferId);
  await protocol.installCommittedConversationTransfer(restored);
  const asset = await authority.artifacts.put(Buffer.from('target upload'));
  const grant = { kind: 'asset-upload' as const, scope: { domain: 'conversation' as const, conversationId, ownerEpoch: 2 },
    surfacePrincipal: 'surface:local:first-party', requestId: 'adopted-surface-upload', assets: [asset],
    payloadDigest: protocolDigest('AdoptedUploadFixture', 1, asset) };
  await expect(authority.surfaceAssets.issue({ ...grant, scope: { ...grant.scope, ownerEpoch: 1 } })).rejects.toThrow();
  expect((await authority.surfaceAssets.issue(grant)).scope).toEqual(grant.scope);

  const managed = await manager.getOrCreate(conversationId);
  console.log('METERED_ADOPTION_PHASE', format, 'target execute');
  expectSettled(await projectSessionTurn({ manager, managed, text: 'after adoption', turnId: 'target-consume',
    runOptions: { source: 'interactive', surfacePrincipal: 'surface:local:first-party', turnContext: { turnId: 'target-consume' } }, notify: () => {} }));
  expectSettled(await projectSessionTurn({ manager, managed, text: 'after adoption', turnId: 'target-consume',
    runOptions: { source: 'interactive', surfacePrincipal: 'surface:local:first-party', turnContext: { turnId: 'target-consume' } }, notify: () => {} }));
  expect(executions).toBe(2); // Exact duplicate ingress never executes or consumes twice.
  const local = fixtureLocalOwnerRuntime(authority);
  const oldOwner = new ConversationRunJournal({ conversationId, ownerEpoch: 1, log: authority.executorLog, artifacts: authority.artifacts,
    signer: authority.signer, verifier: authority.verifier, resources: local.resources,
    currentAuthority: { deviceId: authority.deviceId, executorId: authority.executorId },
    submission: { authenticate() {}, authorize() {} },
    authority: { decideAtPrefix() { throw Error('Fenced source cannot commit'); } }, projection: { async project() {} } });
  await expect(oldOwner.admit({ runId: 'stale-source', ingressKey: 'stale-source', queuedPosition: 1,
    userInput: userTurnInputFromText('stale source'), invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'surface:local:first-party', deviceId: authority.deviceId, ingressId: 'stale-source', receivedAt: new Date().toISOString() } })).rejects.toThrow();
  const tail = await protocol.sessionState.readTranscriptTail(conversationId, context);
  expect(tail.records).toHaveLength(2);
  const after = (await authority.executorLog.readAll()).flatMap(c => c.entries).filter(e => e.stream === 'governor' && (e.body as { t?: string }).t === 'consume');
  expect(after).toHaveLength(2);
}, 120_000);

it.each([{kind:'single',fault:'none'},{kind:'single',fault:'pressure'},{kind:'batch',fault:'permanent'}] as const)('fences page-two $kind cancellation with $fault while another conversation progresses', async ({kind,fault}) => {
  const home = await createTempDir('controller-r4-cancel-page');
  const secrets = new MemorySecretStore();
  const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: secrets });
  let manager!: ConversationManager;
  const factory = { create: vi.fn(async (_conversationId: string) => { throw Error('controller observed cancelled work entering runtime preparation'); }) };
  const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
  manager = new ConversationManager(factory, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
  const source = { principal: { surfacePrincipal: 'rpc:owner', deviceId: authority.deviceId, connectionId: 'desktop' } };
  const ids = Array.from({length: 33}, (_,i) => 'controller-cancel-page-' + i).sort((a,b) =>
    protocolDigest('PendingCancellation',1,a).localeCompare(protocolDigest('PendingCancellation',1,b)));
  const targetRequest = ids.at(-1)!;
  const runs = new Map<string,string>();
  for (const conversationId of ['aa-target','zz-noise','cc-healthy']) {
    await registerActiveConversation(authority,conversationId,new Date().toISOString());
    const admission=await protocol.admit({conversationId,input:'queued', invocation:{kind:'agent',source:'interactive'},
      options:{source:'interactive',turnContext:{turnId:conversationId}},surfacePrincipal:'rpc:owner'});
    runs.set(conversationId,admission.runId);
  }
  for (const requestId of ids) {
    const conversationId=requestId===targetRequest?'aa-target':'zz-noise';
    const envelope=createConversationControlEnvelope({requestId,source,body:requestId===targetRequest&&kind==='batch'?{t:'cancel-batch',conversationId,ownerEpoch:1}:{t:'cancel',conversationId,runId:runs.get(conversationId)!,ownerEpoch:1}});
    await expect(authority.controlAdmission.applyAuthority({envelope,source,stream:'run:'+conversationId,
      initial:null,reducer:()=>null,decide:()=>{throw Error('leave durable received');}})).rejects.toThrow('leave durable received');
  }
  await protocol.stopRecoveryLoop();
  const coldAuthority=await setupAuthorityRuntime({zhixingHome:home,secretStore:secrets});
  let coldManager!: ConversationManager;
  const cold=createProtocol({authority:coldAuthority,manager:()=>coldManager,interactions:new DurableConversationInteractionObserver()});
  coldManager=new ConversationManager(factory,undefined,{durableTurnExecutor:cold,onTurnCommitted:()=>{}});
  let available=fault==='none'; const failures=vi.fn();
  const apply=ConversationRunJournal.prototype.applyControl;
  const blocked=vi.spyOn(ConversationRunJournal.prototype,'applyControl').mockImplementation(function(input){
    if(input.envelope.requestId===targetRequest&&!available) { failures(); return Promise.reject(fault==='pressure'?new StorageMaintenanceAdmissionError({kind:'backpressured',blockedBy:'readBytes',retryAfterMs:1}):Error('permanent target failure')); }
    return apply.call(this,input);
  });
  try {
    const page=await coldAuthority.controlAdmission.pendingCancellations();
    expect(page.envelopes).toHaveLength(32);
    expect(page.envelopes.some(e=>e.requestId===targetRequest)).toBe(false);
    await cold.recover();
    const remaining=(await coldAuthority.controlAdmission.pendingCancellations()).envelopes.map(e=>e.requestId);
    const calls=factory.create.mock.calls;
    console.log('CONTROLLER_CANCEL_PAGE',JSON.stringify({targetRequest,remaining,runtimePreparations:calls.length,firstCall:calls[0]}));
    if(fault==='none') expect(remaining).not.toContain(targetRequest); else { expect(remaining).toContain(targetRequest); expect(failures).toHaveBeenCalled(); }
    expect(factory.create.mock.calls.some(([id])=>id==='aa-target')).toBe(false);
    expect(factory.create.mock.calls.some(([id])=>id==='cc-healthy')).toBe(true);
    available=true; await cold.recover();
    expect((await coldAuthority.controlAdmission.pendingCancellations(undefined,{conversationId:'aa-target',runId:runs.get('aa-target')!})).envelopes).toEqual([]);
    expect(factory.create.mock.calls.some(([id])=>id==='aa-target')).toBe(false);
  } finally {blocked.mockRestore();await cold.stopRecoveryLoop();await manager.disposeAll();await coldManager.disposeAll();}
},120000);
