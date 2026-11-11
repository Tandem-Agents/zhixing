import { Buffer } from "node:buffer";
import path from "node:path";
import { expect } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing-ai/core/authority";
import { DeliveryAuthority } from "@zhixing-ai/core/delivery";
import type { AuthorityCallContext, Signature } from "@zhixing-ai/core/contracts";
import type { UserTurnInput } from "@zhixing-ai/core/types";
import type { AdvancementControlEvent } from "@zhixing-ai/core/advancement";
import {
  canonicalize, createConversationSealedBundle, sealedBundleArtifact, createSignedTrustRuleSnapshot,
  protocolDigest, type ProtocolSignatureVerifier, type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import type { ImageSource, PostTurnControlOutcome, TurnOriginAdvancementExecution } from "@zhixing-ai/core/types";
import { createTempDir } from "@zhixing-ai/test-utils";
import { ConversationRunJournal, pendingAdvancementConversations } from "../conversation-assignment.js";
import { createOwnerDeliveryParticipant } from "../delivery.js";
import { ConversationSessionStateAdapter } from "../session-state-adapter.js";
import { trackAuthorityLog } from "./durable-io-test-support.js";

/**
 * 真实 owner 上的一次运行：文件 authority log、真实 admit/assign/submitBundle 与会话状态端口。
 * owner 提交用例与接入面的提议装配用例共用。
 */

export const PROPOSAL_NOW = "2026-10-30T12:00:00.000Z";
const EXPIRY = "2026-10-30T13:00:00.000Z";
const CONTROL_EXPIRY = "2026-10-30T12:00:30.000Z";
export const PROPOSAL_CONVERSATION = "conv-1";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return { alg: "test-sha256", keyId: "device:test-owner", sig: protocolDigest(schemaId, version, payload) };
  },
};
const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

export const PROPOSAL: PostTurnControlOutcome = { intent: { kind: "propose_advancement" } };

export function task(text: string): UserTurnInput {
  return { parts: [{ type: "text", text }] };
}

export function hostCtx(requestId: string): AuthorityCallContext {
  return { principal: { kind: "host", component: "advancement-proposal-test" }, requestId, deadlineAt: EXPIRY };
}

export async function createProposalOwnerHarness() {
  const root = await createTempDir("advancement-proposal-commit");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { clock: () => PROPOSAL_NOW, lockWaitMs: 2_000 }));
  const journal = new ConversationRunJournal({
    conversationId: PROPOSAL_CONVERSATION,
    ownerEpoch: 1,
    log,
    artifacts,
    signer,
    verifier,
    submission: { authenticate() {}, authorize() {} },
    authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} },
    delivery: createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 1 }) }),
    clock: () => PROPOSAL_NOW,
  });
  const adapter = new ConversationSessionStateAdapter({ journalFor: () => journal, sessionExists: async () => true });
  let seq = 0;
  const write = (events: readonly AdvancementControlEvent[]) =>
    adapter.mutate(PROPOSAL_CONVERSATION, { kind: "advancement-event", events }, hostCtx(`write-${++seq}`));
  const proposals = () => adapter.listPendingAdvancementProposals(PROPOSAL_CONVERSATION, hostCtx(`proposals-${++seq}`));
  const pendingConversations = async () => (await pendingAdvancementConversations(log, artifacts, verifier)).conversationIds;
  return { artifacts, log, journal, adapter, write, proposals, pendingConversations };
}

export type ProposalOwnerHarness = Awaited<ReturnType<typeof createProposalOwnerHarness>>;

/** 一次完整的运行：耐久接纳 → 指派 → 提交带运行记录的封包；返回提交结果。 */
export async function commitProposalRun(
  h: ProposalOwnerHarness,
  input: {
    runId: string; turnId: string; text: string; enabledControls?: readonly string[]; postTurnControl?: PostTurnControlOutcome;
    /** 用户输入附带的图片（随运行记录的用户消息持久化）。 */
    images?: readonly ImageSource[];
    /** 耐久 ingress 上的推进执行标记。 */
    advancementExecution?: TurnOriginAdvancementExecution;
  },
) {
  const assignmentId = `assignment-${input.runId}`;
  const ingress = {
    kind: "first-party" as const, surfacePrincipal: "rpc:test", deviceId: "device:test", ingressId: input.turnId, receivedAt: PROPOSAL_NOW,
    turnOrigin: {
      channel: "rpc" as const,
      ...(input.enabledControls ? { enabledControls: input.enabledControls } : {}),
      ...(input.advancementExecution ? { advancementExecution: input.advancementExecution } : {}),
    },
  };
  const images = input.images ?? [];
  const userInput: UserTurnInput = { parts: [{ type: "text", text: input.text }, ...images.map((source) => ({ type: "image" as const, source }))] };
  await h.journal.admit({
    ingressKey: input.turnId, runId: input.runId, queuedPosition: 0,
    userInput, invocation: { kind: "agent", source: "interactive" }, ingress,
  } as never);
  const userMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: input.text }, ...images.map((source) => ({ type: "image" as const, source }))],
  };
  const windowRef = await h.artifacts.put(Buffer.from(canonicalize([userMessage])));
  const trust = createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: PROPOSAL_NOW }, signer);
  const manifestBody = { v: 1 as const, baseRef: { execution: "conversation" as const, conversationId: PROPOSAL_CONVERSATION, baseRevision: 0 },
    requires: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1, skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1, permissionSnapshotVersion: 1 },
    protocolVersion: "1", tools: [], mcpServers: [], environment: {}, credentialBindings: [] };
  const controlBody = { v: 1 as const, controlLeaseId: `control-${input.runId}`, assignmentId,
    authority: { execution: "conversation" as const, conversationId: PROPOSAL_CONVERSATION, ownerEpoch: 1 }, renewalSeq: 1, issuedAt: PROPOSAL_NOW, expiry: CONTROL_EXPIRY };
  const permissionBody = { v: 1 as const, snapshotVersion: 1, snapshotDigest: trust.digest,
    binding: { execution: "conversation" as const, runId: input.runId, conversationId: PROPOSAL_CONVERSATION, ownerEpoch: 1 },
    assignmentId, executorId: "executor-test", controlLeaseId: `control-${input.runId}`, issuedAt: PROPOSAL_NOW, expiry: CONTROL_EXPIRY };
  const capabilityBody = { v: 1 as const, capId: `capability-${input.runId}`, executorId: "executor-test",
    scope: { execution: "conversation" as const, conversationId: PROPOSAL_CONVERSATION }, ownerEpoch: 1,
    methods: ["submission.submitBundle"] as const, resources: [`conversation:${PROPOSAL_CONVERSATION}`] as const,
    assignmentId, issuedAt: PROPOSAL_NOW, expiry: CONTROL_EXPIRY };
  const resourceBody = { v: 1 as const, reservationId: `reservation-${input.runId}`, admissionClass: "interactive" as const,
    workload: { kind: "run" as const, id: input.runId, attempt: 1 },
    scopeBinding: { kind: "conversation" as const, conversationId: PROPOSAL_CONVERSATION, ownerEpoch: 1 },
    audience: { executorId: "executor-test" }, budget: { maxCalls: 10, maxTokens: 10_000 },
    domain: { kind: "local" as const, localDomainId: "local:device-1", localGovernorEpoch: 1 },
    activation: { kind: "assignment" as const, assignmentId }, issuedAt: PROPOSAL_NOW, expiry: CONTROL_EXPIRY };
  const resourceWithDigest = { ...resourceBody, digest: protocolDigest("ResourceLease", 1, resourceBody) };
  const dispatch = await h.journal.assign({ v: 1, execution: "conversation", assignmentId, executorId: "executor-test",
    manifest: { ...manifestBody, digest: protocolDigest("ExecutionManifest", 1, manifestBody) },
    controlLease: { ...controlBody, signature: signer.sign("ControlLease", 1, controlBody) },
    permissionLease: { ...permissionBody, signature: signer.sign("PermissionSnapshotLease", 1, permissionBody) },
    capabilities: [{ ...capabilityBody, signature: signer.sign("AuthorityCapability", 1, capabilityBody) }],
    resourceLease: { ...resourceWithDigest, signature: signer.sign("ResourceLease", 1, resourceWithDigest) },
    dependencyArtifacts: [], issuedAt: PROPOSAL_NOW,
    work: { t: "conversation", runId: input.runId, conversationId: PROPOSAL_CONVERSATION, ownerEpoch: 1, baseRevision: 0,
      ingress, contentAssets: [], windowInput: { t: "full", windowEpoch: 1, messages: { ref: windowRef } }, controlContext: [] } } as never);
  const bundle = createConversationSealedBundle({
    assignmentId, executorId: "executor-test",
    streamFinal: { finalSeq: 1, streamDigest: "sha256:" + "0".repeat(64) },
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    usageFinal: { reportDigest: "sha256:" + "0".repeat(64), upToUsageSeq: 0 }, dependencyArtifacts: [],
    body: { t: "conversation", runId: input.runId, conversationId: PROPOSAL_CONVERSATION, ownerEpoch: 1, baseRevision: 0,
      runRecord: {
        type: "run", runId: input.runId, runIndex: 1, timestamp: PROPOSAL_NOW,
        messages: [userMessage, { role: "assistant", content: [{ type: "text", text: "先确认验收标准再推进。" }] }],
        ...(input.postTurnControl ? { postTurnControl: input.postTurnControl } : {}),
      },
      contentAssets: [] },
  } as never);
  await h.artifacts.put(sealedBundleArtifact(bundle).bytes);
  return h.journal.submitBundle(bundle, {
    principal: { kind: "assignment", capability: dispatch.envelope.capabilities[0]! },
    requestId: `commit-${input.runId}`, deadlineAt: CONTROL_EXPIRY,
  });
}
