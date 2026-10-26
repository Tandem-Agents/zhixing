// 拆分自 assignment-ledger.test.ts（按主题分文件以便并行执行）：execution-matrix。
import path from "node:path";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { CONVERSATION_RUN_INTERNAL_RECORD_TYPES, CONVERSATION_RUN_RECORD_SHAPES, ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import { channelSurfacePrincipal } from "@zhixing/owner-kernel/control-admission";
import { createTempDir } from "@zhixing/test-utils";
import { ConversationTransferSource, ConversationTransferTarget, readConversationTransferState } from "@zhixing/owner-kernel/conversation-transfer";
import { ConversationBaseSource } from "../../../owner-kernel/src/conversation-base-source.js";
import { bindConversationAnchorTenure } from "../../../cli/src/serve/conversation-anchor-tenure.js";
import { installVerifiedAnchorTenure } from "../../../owner-kernel/src/__tests__/imported-base-fixture.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { InProcessAssignmentSubmission } from "../assignment-ledger.js";
import { selectConversationAuthorityRecords } from "@zhixing/owner-kernel/conversation-transfer";
import { NOW, EXECUTOR_ID, CONVERSATION_ID, ASSIGNMENT_ID, DURABLE_IO_TEST_TIMEOUT_MS, memoryStagingArea, submission, createHarness, ingress, ownerContext, submissionContext, sealDefaultBundle, ConversationBehaviorRecordType, ConversationRecordBehaviorSpec, CONVERSATION_BEHAVIOR_SCENARIOS, CONVERSATION_RECOVERY_PROBES, ConversationRecoveryProbeId, CONVERSATION_RECORD_BEHAVIOR, expectConversationRejected, expectConversationGuardReplayAccepted, replayFixtureLog } from "./assignment-ledger-fixture.js";

// 多本日志的耐久读写：与同文件的迁移用例一样给耐久读写时限，不受全集并行负载下 5 秒默认时限的影响
it('exports source-bound conversation facts without transferring source delivery effects', async () => {
  const responder = { channelId: 'feishu', platformSubject: 'transfer-fixture-user', tenant: 'fixture' };
  const harness = await createHarness({ ingress: { kind: 'channel', surfacePrincipal: channelSurfacePrincipal(responder), responder,
    replyTarget: { channelId: 'feishu', to: 'fixture-chat' }, deviceId: 'device-1', ingressId: 'transfer-fixture', receivedAt: NOW } });
  await harness.ledger.dispatch(harness.dispatch.envelope, harness.dispatch.activation, ownerContext(ASSIGNMENT_ID, 'executor.dispatch'));
  await new InProcessAssignmentSubmission({ ledger: harness.ledger, owner: harness.journal }).startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
  const bundle = await sealDefaultBundle(harness.ledger, 'transfer fixture result');
  await harness.journal.submitBundle(bundle, submissionContext(harness.unsigned));
  const commits = await harness.log.readAll();
  const selected = await selectConversationAuthorityRecords(commits, CONVERSATION_ID, harness.artifacts, harness.identity);
  expect(commits.some(commit => commit.entries.some(entry => entry.stream === 'delivery'))).toBe(true);
  expect(selected.records.some(record => record.stream === 'delivery' || record.stream === 'governor')).toBe(false);
  for (const record of selected.records) {
    const envelope = commits.find(commit => commit.lsn === record.lsn)!;
    expect(record.sourceEnvelopeDigest).toBe(envelope.envelopeDigest);
    expect(envelope.entries[record.sourceItem!]).toEqual({ stream: record.stream, body: record.body });
  }

}, DURABLE_IO_TEST_TIMEOUT_MS);

it('adopts authenticated execution facts, restarts, and admits a new target run without replaying source effects', async () => {
  const responder = { channelId: 'feishu', platformSubject: 'adopted-consumer', tenant: 'fixture' };
  const harness = await createHarness({ ingress: { kind: 'channel', surfacePrincipal: channelSurfacePrincipal(responder), responder,
    replyTarget: { channelId: 'feishu', to: 'fixture-chat' }, deviceId: 'device-1', ingressId: 'adopted-consumer', receivedAt: NOW } });
  await harness.ledger.dispatch(harness.dispatch.envelope, harness.dispatch.activation, ownerContext(ASSIGNMENT_ID, 'executor.dispatch'));
  await new InProcessAssignmentSubmission({ ledger: harness.ledger, owner: harness.journal }).startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
  await harness.journal.submitBundle(await sealDefaultBundle(harness.ledger, 'adopted consumer result'), submissionContext(harness.unsigned));
  const sourceCommits = await harness.log.readAll();
  expect(sourceCommits.some(commit => commit.entries.some(entry => entry.stream === 'delivery'))).toBe(true);

  const targetRoot = await createTempDir('adopted-consumer-target');
  const targetArtifacts = new FileArtifactStore(path.join(targetRoot, 'artifacts'));
  const targetLog = new FileAuthorityCommitLog(path.join(targetRoot, 'authority'), targetArtifacts, { clock: () => NOW });
  onTestFinished(() => targetLog.stopStorageMaintenance());
  const tenure = await installVerifiedAnchorTenure(targetLog, NOW);
  const staging = memoryStagingArea(), transferId = 'xfer-01ARZ3NDEKTSV4RRFFQ69G5FAW', sourceOwnerEpoch = 3, nextOwnerEpoch = 4;
  const source = new ConversationTransferSource({ deviceId: 'device-1', log: harness.log, artifacts: harness.artifacts,
    signer: harness.identity, verifier: harness.identity, acceptsConversationId: id => id === CONVERSATION_ID,
    isCurrentAnchor: id => id === tenure.anchorDeviceId,
    conversationState: async () => ({ exists: true, deleted: false, ownerEpoch: sourceOwnerEpoch }),
    settleConversation: async () => {
      // The real execution ledger proves its acknowledgement before the source
      // prefix can be frozen, exactly as the production settle step does.
      await harness.ledger.acknowledge(ASSIGNMENT_ID, 8);
      const snapshot = await harness.ledger.queryLedger(ASSIGNMENT_ID, ownerContext(ASSIGNMENT_ID, 'executor.queryLedger'));
      if (!('fromSeq' in snapshot)) await harness.journal.observeBundleAcknowledgement(ASSIGNMENT_ID, snapshot);
      await harness.journal.resumeLifecycleProjections(async () => {});
      await harness.journal.resumeCommittedProjections();
      await harness.journal.publishPendingFinals(async () => {});
    },
    snapshotSessionState: async () => ({ reducerVersion: 'session-state-v1', value: { meta: await harness.journal.sessionMeta(), taskList: await harness.journal.taskList(),
      transcript: (await harness.journal.transcriptTail()).records, advancement: null } }),
    clock: () => NOW });
  const prepared = { requestId: 'request-1', transferId, targetDeviceId: tenure.anchorDeviceId, conversationId: CONVERSATION_ID, sourceOwnerEpoch };
  await source.prepare(prepared);
  const frozen = await source.freeze(transferId);
  const target = new ConversationTransferTarget({ deviceId: tenure.anchorDeviceId, log: targetLog, artifacts: targetArtifacts, staging: staging.port,
    signer: harness.identity, verifier: harness.identity, isActiveSource: id => id === 'device-1',
    acceptsSourceConversationId: (device, id) => device === 'device-1' && id === CONVERSATION_ID, conversationExists: () => false,
    sourceOwnerEpoch: () => sourceOwnerEpoch, reducerVersion: 'session-state-v1' });
  await target.prepare({ v: 1, t: 'prepared', ...prepared, sourceDeviceId: 'device-1', nextOwnerEpoch });
  await target.import({ transferId, manifestRef: frozen.manifestRef, proof: frozen.proof, source: source.readPort });
  const committed = await target.commit(transferId);
  await source.acceptCommit({ manifest: frozen.manifest, commit: committed.commit });
  const publication = await target.committedBaseSource(transferId);

  // Authenticated conversation facts cross the boundary; native source
  // governor and delivery effects are not replayed on the target.
  const records = await publication.source.recordsPage(0, 63);
  expect(records.some(record => record.stream === `run:${CONVERSATION_ID}`)).toBe(true);
  expect(records.some(record => record.stream === 'delivery' || record.stream === 'governor')).toBe(false);
  const targetCommits = await targetLog.readAll();
  expect(targetCommits.some(commit => commit.entries.some(entry => entry.stream === 'delivery'))).toBe(false);

  expect((await target.committedBase(transferId)).manifest.conversationId).toBe(CONVERSATION_ID);

  // Restart: a cold reopen of the target authority still serves the adopted base.
  await targetLog.stopStorageMaintenance();
  const reopenedArtifacts = new FileArtifactStore(path.join(targetRoot, 'artifacts'));
  const reopenedLog = new FileAuthorityCommitLog(path.join(targetRoot, 'authority'), reopenedArtifacts, { clock: () => NOW });
  onTestFinished(() => reopenedLog.stopStorageMaintenance());
  bindConversationAnchorTenure(reopenedLog);
  const state = await readConversationTransferState(reopenedLog, transferId, harness.identity);
  expect(state?.phase).toBe('committed');
  const reopened = await ConversationBaseSource.open({ log: reopenedLog, artifacts: reopenedArtifacts, verifier: harness.identity,
    state: state!, ownerCheckpoint: await reopenedLog.checkpoint() });
  if (!reopened.ready) await reopened.prepare();
  const reopenedRecords = await reopened.recordsPage(0, 63);
  expect(reopenedRecords.some(record => record.stream === `run:${CONVERSATION_ID}`)).toBe(true);
  const owner = new ConversationRunJournal({ conversationId: CONVERSATION_ID, ownerEpoch: nextOwnerEpoch,
    log: reopenedLog, artifacts: reopenedArtifacts, signer: harness.identity, verifier: harness.identity,
    currentAuthority: { deviceId: tenure.anchorDeviceId, executorId: EXECUTOR_ID },
    submission, authority: harness.authority, projection: { async project() {} }, clock: () => NOW });
  await owner.installImportedBase(reopened);
  const before = await reopenedLog.checkpoint();
  await owner.admit({ runId: 'target-followup', ingressKey: 'target-followup', queuedPosition: 1,
    userInput: { parts: [{ type: 'text', text: 'continue on target' }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'surface:user-1', deviceId: tenure.anchorDeviceId, ingressId: 'target-followup', receivedAt: NOW } });
  expect(await owner.runState('target-followup')).toBe('queued');
  expect((await reopenedLog.checkpoint()).lsn).toBeGreaterThan(before.lsn);
  expect((await reopenedLog.readAll()).flatMap(commit => commit.entries).some(entry => entry.stream === 'delivery')).toBe(false);

}, 120_000);

describe("conversation record execution-point behavior matrix", () => {
  it("binds every conversation record type to a producing scenario", () => {
    expect(Object.keys(CONVERSATION_RECORD_BEHAVIOR).sort()).toEqual(
      [
        ...Object.keys(CONVERSATION_RUN_RECORD_SHAPES),
        ...CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
      ].sort(),
    );
    const referencedRecoveryProbes = new Set<ConversationRecoveryProbeId>();
    for (const [recordType, spec] of Object.entries(CONVERSATION_RECORD_BEHAVIOR)) {
      if (spec.recovery.kind === "not-applicable") {
        expect(spec.recovery.reason.length, recordType).toBeGreaterThan(20);
      } else {
        referencedRecoveryProbes.add(spec.recovery.id);
      }
    }
    expect([...referencedRecoveryProbes].sort()).toEqual(
      Object.keys(CONVERSATION_RECOVERY_PROBES).sort(),
    );
  });

  it.each(Object.entries(CONVERSATION_RECOVERY_PROBES))(
    "recovery contract %s executes its real consumer",
    async (_id, probe) => probe(),
    20_000,
  );

  it.each(Object.keys(CONVERSATION_RECORD_BEHAVIOR) as ConversationBehaviorRecordType[])(
    "%s: real production, full/guard acceptance, adversarial-vector rejection",
    async (recordType) => {
      const spec = CONVERSATION_RECORD_BEHAVIOR[
        recordType
      ] as ConversationRecordBehaviorSpec;
      const behavior = await CONVERSATION_BEHAVIOR_SCENARIOS[spec.scenario]();
      const stream =
        spec.stream === "session-activity"
          ? `session-activity:${behavior.conversationId}`
          : `run:${behavior.conversationId}`;
      const records = await behavior.log.readStream<Record<string, unknown>>(
        stream,
      );
      const produced = records.filter((record) => {
        const body = record.body as { t?: string; kind?: string };
        return body.t === recordType || body.kind === recordType;
      });
      expect(produced.length, recordType).toBeGreaterThan(0);
      await behavior.fullProbe();
      if (behavior.guardProbe) {
        await expectConversationGuardReplayAccepted(behavior.guardProbe);
      }
      const target = produced[produced.length - 1];
      if (!target) throw new Error("matrix target record is missing");
      const vector = spec.corrupt
        ? spec.corrupt(structuredClone(target.body) as Record<string, unknown>)
        : structuredClone(target.body);
      const corruptStream =
        spec.corruptStream === "session-activity"
          ? `session-activity:${behavior.conversationId}`
          : spec.corruptStream === "run"
            ? `run:${behavior.conversationId}`
            : stream;
      await expectConversationRejected(async () => {
        await replayFixtureLog(behavior).append([{ stream: corruptStream, body: vector }]);
        await behavior.fullProbe();
      });
      if (behavior.guardProbe) {
        const guardBehavior =
          await CONVERSATION_BEHAVIOR_SCENARIOS[spec.scenario]();
        const guardRecords =
          await guardBehavior.log.readStream<Record<string, unknown>>(
            spec.stream === "session-activity"
              ? `session-activity:${guardBehavior.conversationId}`
              : `run:${guardBehavior.conversationId}`,
          );
        const guardTarget = guardRecords.filter((record) => {
          const body = record.body as { t?: string; kind?: string };
          return body.t === recordType || body.kind === recordType;
        }).at(-1);
        if (!guardTarget) {
          throw new Error("matrix guard target record is missing");
        }
        const guardVector = spec.corrupt
          ? spec.corrupt(
              structuredClone(guardTarget.body) as Record<string, unknown>,
            )
          : structuredClone(guardTarget.body);
        await expectConversationRejected(async () => {
        await replayFixtureLog(guardBehavior).append([
          {
            stream:
              spec.corruptStream === "session-activity"
                ? `session-activity:${guardBehavior.conversationId}`
                : spec.corruptStream === "run"
                  ? `run:${guardBehavior.conversationId}`
                  : spec.stream === "session-activity"
                    ? `session-activity:${guardBehavior.conversationId}`
                    : `run:${guardBehavior.conversationId}`,
            body: guardVector,
          },
        ]);
        await guardBehavior.guardProbe!();
        });
      }
    },
    20_000,
  );
});

/** An older writer can leave invalid domain facts in storage. Keep recovery
 * rejection coverage even when the current registered projections reject them
 * before append. This log still uses the real storage implementation. */
