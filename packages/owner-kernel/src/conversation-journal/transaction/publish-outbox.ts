import { Buffer } from "node:buffer";
import type {
  ArtifactStore,
  AuthorityCommitLog,
} from "@zhixing-ai/core/authority";
import type {
  ConversationStatusNotice,
  ControlResult,
  PublishRecord,
} from "@zhixing-ai/core/contracts";
import { decideConversationControlResponse } from "@zhixing-ai/core/conversation/application";
import {
  canonicalize,
  validateMutationBatch,
  validatePublishDecisionForBatch,
  validatePublishDecisionRecord,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import {
  advancementPendingPrefix,
  readAdvancementRecovery,
  registerAdvancementRecoveryProjection,
} from "../../advancement-recovery-index.js";
import type { ConversationControlEnvelope } from "../../control-admission.js";
import { domainPublishDecisionRequired } from "../../conversation-publish-obligations.js";
import { conversationRecoveryPage } from "../../conversation-recovery-index.js";
import {
  corruptRunJournal,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import {
  registerConversationRunReadProjection,
  type ConversationRunValidationBinding,
} from "../../conversation-run-state-index.js";
import { conversationStatusNotice } from "../../conversation-status-projection.js";
import type { ConversationControlResponseInput } from "../../delivery-participant.js";
import type { ConversationFactGroup } from "../contracts.js";
import { runStream } from "../state/common.js";
import type { AssignmentControlFacts } from "../state/views.js";

/** Owner-internal discovery. The run projection validates all contributing facts. */
export async function pendingAdvancementConversations(
  log: AuthorityCommitLog,
  artifacts: ArtifactStore,
  verifier: ProtocolSignatureVerifier,
  after?: string,
  validation?: ConversationRunValidationBinding,
) {
  registerConversationRunReadProjection(
    log,
    artifacts,
    verifier,
    undefined,
    validation,
  );
  registerAdvancementRecoveryProjection(log, artifacts);
  if (after && !after.startsWith(advancementPendingPrefix)) {
    throw new TypeError("Invalid advancement discovery cursor");
  }
  return readAdvancementRecovery(log, async (view) => {
    const page = await view.scan(
      {
        ...(after ? { gt: after } : { gte: advancementPendingPrefix }),
        lt: advancementPendingPrefix + "\uffff",
      },
      16,
    );
    return {
      conversationIds: page.entries.map((row) => {
        if (typeof row.value !== "string") {
          throw new TypeError("Invalid advancement pending directory");
        }
        return row.value;
      }),
      ...(page.continuation ? { next: page.entries.at(-1)!.key } : {}),
    };
  });
}

/**
 * 空批次 cancel-batch 的唯一回执 item:非空批次的用户反馈由逐 run 权威
 * cancelled 投递单源承担;仅当批量决定命中零候选且请求携带渠道回执绑定时,
 * 同一权威决定产出一条以 canonical requestId 幂等的回执。
 */
export function conversationControlResponseDeliveryInputs(
  conversationId: string,
  envelope: ConversationControlEnvelope,
  plan: { readonly result: ControlResult },
  canonicalRequestId: string,
  at: string,
): ConversationControlResponseInput[] {
  const response = decideConversationControlResponse(
    envelope.body,
    plan.result,
  );
  return response
    ? [{ at, conversationId, requestId: canonicalRequestId, ...response }]
    : [];
}

export function conversationStatusNoticesForCommit(
  assignmentFacts: Pick<AssignmentControlFacts, "getStatusHistory">,
  envelope: ConversationFactGroup<unknown>,
  conversationId: string,
  ownerEpoch: number,
): ConversationStatusNotice[] {
  const notices: ConversationStatusNotice[] = [];
  for (const record of envelope.entries) {
    if (record.stream !== runStream(conversationId)) continue;
    const candidate = record.body as ConversationRunJournalRecord;
    if (!("t" in candidate) || candidate.t !== "state") continue;
    const body = candidate;
    const entry = assignmentFacts
      .getStatusHistory(body.runId)
      ?.find((item) => item.statusRevision === body.statusRevision);
    if (!entry) {
      throw corruptRunJournal("Committed run status has no history projection");
    }
    const notice = conversationStatusNotice(
      conversationId,
      ownerEpoch,
      body.runId,
      entry,
      body.assignmentId,
    );
    if (notice) notices.push(notice);
  }
  return notices;
}

type ConversationRecoveryFacts = {
  deleted: boolean;
  controlRecovery: boolean;
  readonly lifecycleFacts: Set<number>;
  readonly lifecycleProjections: Set<number>;
  readonly runStates: Map<string, string>;
  readonly commits: Map<string, number>;
  readonly projected: Set<string>;
  readonly acknowledged: Set<string>;
  readonly terminalFinals: Set<number>;
};

/** 启动恢复发现的折叠状态：只含 Map、Set 与已校验记录，可整体存为投影检查点。 */
interface ConversationRecoveryDiscoveryState {
  readonly facts: Map<string, ConversationRecoveryFacts>;
  readonly publishDecisions: Map<
    string,
    Extract<PublishRecord, { t: "publish-decision" }>
  >;
  readonly publishDomains: Map<string, Set<"session" | "global">>;
}

function emptyRecoveryDiscovery(): ConversationRecoveryDiscoveryState {
  return {
    facts: new Map(),
    publishDecisions: new Map(),
    publishDomains: new Map(),
  };
}

function foldRecoveryDiscovery(
  state: ConversationRecoveryDiscoveryState,
  entry: { readonly stream: string; readonly body: unknown },
): void {
  const factsFor = (conversationId: string) => {
    let facts = state.facts.get(conversationId);
    if (!facts) {
      facts = {
        deleted: false,
        controlRecovery: false,
        lifecycleFacts: new Set(),
        lifecycleProjections: new Set(),
        runStates: new Map(),
        commits: new Map(),
        projected: new Set(),
        acknowledged: new Set(),
        terminalFinals: new Set(),
      };
      state.facts.set(conversationId, facts);
    }
    return facts;
  };
  const publishDecisions = state.publishDecisions;
  const publishDomains = state.publishDomains;
  const body = entry.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const record = body as Record<string, unknown>;
  if (entry.stream.startsWith("run:")) {
    const conversationId = entry.stream.slice("run:".length);
    const facts = factsFor(conversationId);
    if (
      record.t === "session-lifecycle" &&
      typeof record.domainRevision === "number"
    ) {
      facts.lifecycleFacts.add(record.domainRevision);
      if (record.mutation === "delete") facts.deleted = true;
    } else if (
      record.kind === "conversation-lifecycle-projection" &&
      typeof record.domainRevision === "number"
    ) {
      facts.lifecycleProjections.add(record.domainRevision);
    } else if (
      record.t === "state" &&
      typeof record.runId === "string" &&
      typeof record.state === "string"
    ) {
      facts.runStates.set(record.runId, record.state);
    } else if (
      record.t === "committed" &&
      typeof record.assignmentId === "string" &&
      typeof record.commitRevision === "number"
    ) {
      facts.commits.set(record.assignmentId, record.commitRevision);
      const summary = record.readSummary as
        | { controlRecovery?: boolean }
        | undefined;
      if (summary?.controlRecovery !== false) facts.controlRecovery = true;
    } else if (
      record.t === "bundle-ack-observed" &&
      typeof record.assignmentId === "string"
    ) {
      facts.acknowledged.add(record.assignmentId);
    } else if (
      record.kind === "conversation-commit-projection" &&
      typeof record.assignmentId === "string"
    ) {
      facts.projected.add(record.assignmentId);
    }
    return;
  }
  if (
    entry.stream === "publish" &&
    record.t === "publish-decision" &&
    typeof record.assignmentId === "string"
  ) {
    publishDecisions.set(
      record.assignmentId,
      validatePublishDecisionRecord(record),
    );
    const required = new Set<"session" | "global">();
    if (typeof record.sessionCount === "number" && record.sessionCount > 0) {
      required.add("session");
    }
    if (typeof record.globalCount === "number" && record.globalCount > 0) {
      required.add("global");
    }
    publishDomains.set(record.assignmentId, required);
  } else if (
    entry.stream === "publish" &&
    record.t === "publish-progress" &&
    record.state === "settled" &&
    typeof record.assignmentId === "string" &&
    (record.domain === "session" || record.domain === "global")
  ) {
    publishDomains.get(record.assignmentId)?.delete(record.domain);
  } else if (
    entry.stream === "final-outbox" &&
    record.t === "final" &&
    typeof record.conversationId === "string" &&
    typeof record.commitRevision === "number" &&
    (record.state === "published" || record.state === "expired")
  ) {
    factsFor(record.conversationId).terminalFinals.add(record.commitRevision);
  }
}

async function recoveryCandidatesOf(
  state: ConversationRecoveryDiscoveryState,
  artifacts: ArtifactStore,
): Promise<Set<string>> {
  const hasPendingPublish = async (assignmentId: string): Promise<boolean> => {
    const unresolved = state.publishDomains.get(assignmentId);
    if (!unresolved?.size) return false;
    const decision = state.publishDecisions.get(assignmentId)!;
    const text = Buffer.from(
      await artifacts.get(decision.batch.ref),
    ).toString("utf8");
    const batch = validateMutationBatch(JSON.parse(text));
    if (canonicalize(batch) !== text || batch.assignmentId !== assignmentId) {
      throw corruptRunJournal("Recovery publish batch binding is invalid");
    }
    validatePublishDecisionForBatch(decision, batch);
    return [...unresolved].some((domain) =>
      domainPublishDecisionRequired(batch.records, decision.outcomes, domain),
    );
  };
  const result = new Set<string>();
  const openStates = new Set([
    "queued",
    "dispatched",
    "running",
    "cancel-requested",
    "uncertain",
  ]);
  for (const [conversationId, facts] of state.facts) {
    const hasPendingLifecycle = [...facts.lifecycleFacts].some(
      (revision) => !facts.lifecycleProjections.has(revision),
    );
    if (hasPendingLifecycle) {
      result.add(conversationId);
      continue;
    }
    if (facts.controlRecovery) result.add(conversationId);
    if (facts.deleted) continue;
    if ([...facts.runStates.values()].some((runState) => openStates.has(runState))) {
      result.add(conversationId);
      continue;
    }
    for (const [assignmentId, revision] of facts.commits) {
      if (
        !facts.projected.has(assignmentId) ||
        !facts.acknowledged.has(assignmentId) ||
        !facts.terminalFinals.has(revision) ||
        (await hasPendingPublish(assignmentId))
      ) {
        result.add(conversationId);
        break;
      }
    }
  }
  return result;
}

/** Owner-owned startup discovery shares the same publish semantics as commit. */
export async function discoverConversationRecoveryCandidates(
  commits: readonly {
    readonly entries: readonly { readonly stream: string; readonly body: unknown }[];
  }[],
  artifacts: ArtifactStore,
): Promise<Set<string>> {
  const state = emptyRecoveryDiscovery();
  for (const commit of commits) {
    for (const entry of commit.entries) foldRecoveryDiscovery(state, entry);
  }
  return recoveryCandidatesOf(state, artifacts);
}

/**
 * Compatibility query enumerates only current recovery obligations.
 * Production workers consume conversationRecoveryPage instead of a global historical set.
 */
export async function discoverConversationRecoveryCandidatesFromLog(
  log: AuthorityCommitLog,
  artifacts: ArtifactStore,
): Promise<Set<string>> {
  const result = new Set<string>();
  let after: string | undefined;
  do {
    const page = await conversationRecoveryPage(log, artifacts, after);
    for (const id of page.conversationIds) result.add(id);
    after = page.after;
  } while (after);
  return result;
}
