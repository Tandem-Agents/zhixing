import { Buffer } from "node:buffer";
import { userTurnInputFromMessages, type Message } from "@zhixing-ai/core";
import {
  advancementSubmissionRequestId,
  freezeAdvancementSessions,
  isAdvancementControlEvent,
  type AdvancementControlEvent,
  type AdvancementSession,
  type AdvancementSubmissionReceipt,
} from "@zhixing-ai/core/advancement";
import {
  AuthorityStorageError,
  collectArtifactRefs,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  resolveDispatchArtifactClosure,
  TransactionArtifactReferenceError,
  type ArtifactStore,
  type AuthorityCommitLog,
  type AuthorityLogSnapshot,
  type DurableLogCheckpoint,
  type DurableProjectionReadContext,
  type ProjectionCursor,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AuthorityCallContext,
  AuthorityError,
  CancelProofBody,
  ChannelMessageRef,
  ChannelResponderRef,
  CommitEnvelope,
  ContentAssetRef,
  ConversationChannelChallengeToken,
  ConversationControlCursor,
  ConversationControlFact,
  ConversationInputCursor,
  ConversationInputPage,
  ConversationInvocation,
  ConversationRecoveryPage,
  ConversationRecoveryRequest,
  ConversationRunOutcomesPage,
  ConversationRunState,
  ConversationStatusNotice,
  DataPlaneTicket,
  DispatchResult,
  ExplicitEnvironmentSelection,
  FinalFrame,
  IngressContext,
  IntentStreamRecord,
  IsoTime,
  JsonValue,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
  PublishConflictNotice,
  PublishResultNotice,
  RootResourceWorkload,
  SealedBundle,
  SessionMeta,
  SessionStagedMutation,
  StreamFrame,
  SupersedeProof,
  TaskListState,
  TranscriptCursor,
  TranscriptPage,
  TranscriptRunRecord,
  TrustRuleHitMirrorEntry,
  TrustSedimentMirrorEntry,
  UncertainResolutionFact,
  UserTurnInput,
} from "@zhixing-ai/core/contracts";
import { parseConversationId } from "@zhixing-ai/core/conversation";
import {
  projectPublishConflicts,
  projectPublishResults,
  type ConversationMessageStatus,
} from "@zhixing-ai/core/conversation/application";
import { registerDeliveryAuthorityProjection } from "@zhixing-ai/core/delivery";
import type { RunInputPort } from "@zhixing-ai/core/loop";
import {
  applyValidatedAssignmentEntry,
  assignmentActivationDigest,
  buildConversationActivationPayload,
  byteDigest,
  canonicalize,
  controlLeaseBindsDispatchEnvelope,
  createAssignmentLedgerValidationState,
  createSignedConversationEnvelope,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  interactionMirrorBatchDigest,
  sealedBundleArtifact,
  signConversationActivation,
  validateAssignmentEntry,
  validateCancelProof,
  validateChannelChallengeToken,
  validateContentAssetRefs,
  validateConversationActivation,
  validateConversationEnvelope,
  validateConversationInteractionMirrorBatch,
  validateConversationInvocation,
  validateConversationSealedBundle,
  validateDispatchConflictProof,
  validateDispatchRejectionProof,
  validateDispatchResult,
  validateExplicitEnvironmentSelection,
  validateIngressContext,
  validateLedgerEvidencePage,
  validateLedgerSnapshot,
  validateMutationBatch,
  validateNonEmptyUserTurnInput,
  validatePublishDecisionForBatch,
  validateStreamFrame,
  validateSupersedeProof,
  validateTranscriptRunRecord,
  verifyProtocolStep,
  type ConversationInteractionMirrorBatch,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedConversationEnvelope,
} from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  StorageMaintenanceCancelledError,
} from "@zhixing-ai/core/resources";
import {
  isWorksceneDeletedAt,
  registerWorksceneAuthorityProjection,
  WORKSCENE_AUTHORITY_PROJECTION_ID,
} from "@zhixing-ai/core/workscene";
import type {
  WorksceneContinuationQuery,
  WorksceneContinuationSource,
} from "@zhixing-ai/core/workscene/application";
import {
  advancementPendingProposals,
  advancementPendingRun,
  advancementRecoveryHead,
  advancementRecoveryPrefix,
  advancementRecoveryRoot,
  readAdvancementRecovery,
  registerAdvancementRecoveryProjection,
  type AdvancementCleanupWork,
} from "../advancement-recovery-index.js";
import type { PendingChannelChallenge } from "../channel-challenge-outbox.js";
import {
  validateConversationChannelChallengeRecord,
  type ConversationChannelChallengePreparedRecord,
} from "../channel-interaction-records.js";
import {
  CONVERSATION_IDENTITY_PROJECTION_ID,
  CONTROL_PROJECTION_ID,
  conversationIdentityExistsAt,
  hasPendingCancellationForRun,
  registerControlAdmissionProjection,
  registerConversationIdentityProjection,
  type ControlAdmissionJournal,
  type ControlAdmissionOutcome,
  type ConversationControlEnvelope,
  type InitialControlEnvelope,
  type TrustedControlSource,
} from "../control-admission.js";
import {
  conversationBaseKey,
  conversationViewAt,
  registerConversationBaseSource,
  type ConversationBaseBinding,
} from "../conversation-base-registry.js";
import type { ConversationBaseSource } from "../conversation-base-source.js";
import { ConversationBodyReader } from "../conversation-body-reader.js";
import { readInputTextPage } from "../conversation-input-reader.js";
import { ConversationMessageInputReader } from "../conversation-message-input-reader.js";
import { domainPublishDecisionRequired } from "../conversation-publish-obligations.js";
import {
  ConversationReadIndex,
  openRunState,
  sourceOrder,
  type ControlRead,
} from "../conversation-read-index.js";
import {
  assertExactRecordKeys,
  assertIdentifier,
  assertNonNegativeSafeInteger,
  assertPlainRecord,
  assertPositiveSafeInteger,
  assertConversationRunRecord,
  corruptRunJournal,
  type ConversationRunJournalRecord,
} from "../conversation-run-contracts.js";
import {
  readIndexedConversationAuthority,
  readIndexedPendingDispatch,
  readIndexedPendingProjections,
  readIndexedRecoveryAssignments,
} from "../conversation-run-queries.js";
import { readConversationRunRoot } from "../conversation-run-state-extras.js";
import {
  CONVERSATION_RUN_STATE_PROJECTION_ID,
  conversationStateFieldPrefix,
  decodeConversationState,
  readConversationStateField,
  readConversationSubmissionState,
  registerConversationRunProjection,
} from "../conversation-run-state-index.js";
import {
  conversationDecisionScope,
  readConversationExactValue,
} from "../conversation-run-state-view.js";
import { ConversationSessionReadModel } from "../conversation-session-read-model.js";
import { conversationStatusNotice } from "../conversation-status-projection.js";
import { ConversationTimelineReader } from "../conversation-timeline-reader.js";
import {
  registerConversationTransferProjection,
  type ConversationTransferAuthorityRecord,
} from "../conversation-transfer.js";
import {
  DEFERRED_INTENT_PROJECTION_ID,
  type DeferredIntentConversationAuthorityState,
} from "../deferred-global-intents.js";
import type { ConversationDeliveryParticipant } from "../delivery-participant.js";
import type { AssignmentResourceCoordinator } from "../resource-governor.js";
import {
  type AssignmentSubmissionAuthorization,
  type AssignmentSubmissionAuthorizer,
  type AssignmentSubmissionIdentity,
  type AssignmentSubmissionPreflightPort,
  type AssignmentSubmissionPreflightResult,
  type DataPlaneTicketFacts,
  type DataPlaneTicketIssueRequest,
} from "../shared-protocol/contracts.js";
import {
  assertSubmissionContextIdentity,
  assertSubmissionGuardActivatedCapability,
  authenticateAssignmentSubmission,
  authorizeAssignmentSubmissionCapability,
  hasCurrentSubmissionAuthority,
} from "../shared-protocol/submission-authorization.js";
import {
  AssignmentSerialQueue,
  type TrustRuleHitBatchState,
  type TrustRuleHitPort,
} from "../trust-rule-hits.js";
import {
  emptyConversationRunProjection,
  FINAL_OUTBOX_RETENTION_MS,
  SessionActivityRejectedError,
  type AssignedProjection,
  type CommittedConversationResult,
  type ConversationAbortTicketAuthorizer,
  type ConversationCancelRequest,
  type ConversationCancelResult,
  type ConversationChannelFrameAdoption,
  type ConversationCommitAuthority,
  type ConversationCommitLogRecord,
  type ConversationCommitProjection,
  type ConversationCommitProjectionInput,
  type ConversationFactGroup,
  type ConversationLifecycleProjection,
  type ConversationLifecycleProjectionInput,
  type ConversationMutationPublisher,
  type ConversationProjectionRecord,
  type ConversationRunControlDescriptor,
  type ConversationRunJournalOptions,
  type ConversationTrustSedimentPort,
  type ConversationUncertainResolutionFact,
  type PendingConversationDispatch,
  type PendingConversationFence,
  type PendingConversationInput,
  type PendingLifecycleProjection,
  type PreparedStored,
  type RunProjection,
} from "./contracts.js";
import {
  decideAdmitRun,
  decideAdvancementEvents,
  decideAssertInputExecutor,
  decideCloseRunInput,
  decideCompleteLifecycleProjection,
  decideDeleteWorksceneSession,
  decideInputControl,
  decideOpenRunInput,
  decideReceiveRunInput,
  decideTouchWorksceneSession,
} from "./operations/admission-input.js";
import {
  decideAdoptConversationChannelFrame,
  decideAuthorizeChannelCallback,
  decideCloseChannelChallenge,
  decideDataPlaneTicketFacts,
  decideInteractionMirror,
  decideIssueDataPlaneTicket,
  decideRecordChannelChallengeDelivered,
  decideRevokeDataPlaneTicket,
} from "./operations/channel-tickets.js";
import {
  decideAcceptNotStartedTermination,
  decideAcceptSupersedeAlreadyStarted,
  decideCloseQueuedRun,
  decideControlEnvelope,
  decideConversationCancel,
  decideFailAssignedRun,
  decideMarkAssignmentUncertain,
  decideRequestSupersede,
  decideSubmitCancelProof,
} from "./operations/control-cancel-supersede.js";
import {
  decideAcknowledgeDispatch,
  decideAssign,
  decideAssignmentSchedulingState,
  decideAssignPreflight,
  decideReconcileStarted,
  decideRecordDispatchConflict,
  decideReportStarted,
  type AssignDecision,
} from "./operations/dispatch-assign.js";
import {
  decideCommitProjectionProgress,
  decideGuardBundleRejection,
  decideObserveBundleAcknowledgementAtState,
  decideObserveBundleAcknowledgementPreflight,
  decideSubmitBundleGuardCommittedFastPath,
  decideSubmitBundlePreflightAtState,
  decideSubmitBundleSelectPreflight,
} from "./operations/terminal-commit.js";
import {
  conversationStatusDeliveryInputs,
  prepareStored,
  submissionCommitSidecars,
  validateConversationBundleClosure,
} from "./replay/bundle-binding.js";
import {
  requireAssignedEnvelope,
  requireLocalAssignedCommit,
} from "./state/assignment-control.js";
import { validateTicketIssueRequest } from "./state/channel-tickets.js";
import {
  canonicalTime,
  runStream,
  snapshot,
  truncateUtf8,
  withoutSignature,
} from "./state/common.js";
import {
  assertLedgerAcknowledgesCommittedConversationBundle,
  finalFrame,
  rejected,
} from "./state/commit-publish.js";
import {
  applyCommittedSessionMutations,
  assertCanonicalActivityTime,
  assertWorksceneIdentity,
  reduceConversationSessionFact,
} from "./state/session-domain.js";
import {
  readConversationDecisionFacts,
  readConversationGuardDecisionFacts,
  type ConversationDecisionFacts,
  type ConversationGuardDecisionFacts,
  type ReadonlyAssignedFact,
} from "./state/views.js";
import {
  decideTrustRuleHitBatchState,
  decideTrustRuleHitPrecheck,
  prepareBundleCompanionRecordsAtPrefix,
  prepareConversationBundleSubmission,
  prepareTrustRuleHitMirrorSession,
  prepareTrustSedimentsForMirrorBatch,
  type PreparedConversationGlobalRecord,
} from "./submission/prepared-submission.js";
import { ConversationProjectionCoordinator } from "./transaction/coordinator.js";
import {
  conversationControlResponseDeliveryInputs,
  conversationStatusNoticesForCommit,
} from "./transaction/publish-outbox.js";

export class ConversationRunJournal implements AssignmentSubmissionPreflightPort {
  readonly #conversationId: string;
  readonly #ownerEpoch: number;

  /** 该权威日志绑定会话——端口适配层据此核对会话绑定。 */
  get conversationId(): string {
    return this.#conversationId;
  }

  readonly #log: AuthorityCommitLog;
  readonly #readIndex: ConversationReadIndex;
  readonly #sessionRead: ConversationSessionReadModel<RunProjection>;
  readonly #messageRead: ConversationMessageInputReader;
  readonly #artifacts: ArtifactStore;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #submission: AssignmentSubmissionAuthorizer;
  readonly #authority: ConversationCommitAuthority;
  readonly #projection: ConversationCommitProjection;
  readonly #publisher: ConversationMutationPublisher | undefined;
  readonly #delivery: ConversationDeliveryParticipant | undefined;
  readonly #resources: AssignmentResourceCoordinator | undefined;
  readonly #clock: () => string;
  readonly #legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly #currentAuthority:
    | {
        readonly deviceId: string;
        readonly executorId?: string;
      }
    | undefined;
  readonly #trustSediments: ConversationTrustSedimentPort | undefined;
  readonly #trustRuleHits: TrustRuleHitPort | undefined;
  readonly #mirrorQueue = new AssignmentSerialQueue();
  readonly #statusListeners = new Set<
    (notice: ConversationStatusNotice) => void | Promise<void>
  >();
  readonly #coordinator: ConversationProjectionCoordinator;

  constructor(options: ConversationRunJournalOptions) {
    assertIdentifier(options.conversationId, "Conversation id");
    assertPositiveSafeInteger(options.ownerEpoch, "Owner epoch");
    this.#conversationId = options.conversationId;
    this.#ownerEpoch = options.ownerEpoch;
    this.#log = options.log;
    this.#readIndex = new ConversationReadIndex(
      options.log,
      options.artifacts,
      options.verifier,
    );
    this.#sessionRead = new ConversationSessionReadModel(
      options.log,
      this.#readIndex,
      options.conversationId,
      () => emptyConversationRunProjection(this.#conversationId),
      this.#reduceSessionRead,
    );
    this.#messageRead = new ConversationMessageInputReader(
      options.log,
      this.#readIndex,
      options.artifacts,
      options.conversationId,
    );
    this.#artifacts = options.artifacts;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#submission = options.submission;
    this.#authority = options.authority;
    this.#projection = options.projection;
    this.#publisher = options.publisher;
    this.#delivery = options.delivery;
    if (options.delivery) registerDeliveryAuthorityProjection(options.log);
    this.#resources = options.resources;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#legacyAbortTickets = options.legacyAbortTickets;
    registerConversationRunProjection(
      options.log,
      options.artifacts,
      options.verifier,
      options.legacyAbortTickets,
      {
        delivery: options.delivery,
        currentAuthority: options.currentAuthority,
        resources: options.resources,
      },
    );
    this.#currentAuthority = options.currentAuthority;
    this.#trustSediments = options.trustSediments;
    this.#trustRuleHits = options.trustRuleHits;
    registerConversationIdentityProjection(options.log, options.artifacts);
    registerControlAdmissionProjection(options.log, options.artifacts);
    if (options.currentAuthority) {
      registerConversationTransferProjection(options.log, options.verifier);
    }
    this.#coordinator = new ConversationProjectionCoordinator({
      conversationId: this.#conversationId,
      ownerEpoch: this.#ownerEpoch,
      log: this.#log,
      artifacts: this.#artifacts,
      verifier: this.#verifier,
      legacyAbortTickets: this.#legacyAbortTickets,
      delivery: this.#delivery,
      resources: this.#resources,
      currentAuthority: this.#currentAuthority,
      publishStatusNotices: (notices) => this.#publishStatusNotices(notices),
    });
  }

  get hasRecoveredInputProjection(): boolean {
    return this.#coordinator.hasRecoveredInputProjection;
  }

  async sessionMeta(): Promise<SessionMeta> {
    return this.#readIndex.meta(this.#conversationId, this.#ownerEpoch);
  }

  async transcriptTail(
    cursor?: TranscriptCursor,
    limit = 50,
  ): Promise<TranscriptPage> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
      throw new TypeError("Transcript page limit must be between 1 and 500");
    }
    if (cursor && cursor.shardId !== "owner-log") {
      throw new TypeError("Transcript cursor belongs to another session store");
    }
    const before = await this.#readIndex.state(this.#conversationId);
    const reader = new ConversationBodyReader(
      this.#readIndex,
      this.#artifacts,
      this.#conversationId,
      this.#ownerEpoch,
    );
    const records: TranscriptRunRecord[] = [];
    let commit = await this.#readIndex.latest(this.#conversationId);
    let more = false;
    while (commit) {
      let source = await reader.source(commit);
      while ("ready" in source) {
        await new Promise<void>(setImmediate);
        source = await reader.source(commit);
      }
      const runIndex = (await reader.json.value(
        source.ref,
        [...source.keys, "runIndex"],
        128,
      )) as number;
      if (!cursor || runIndex < cursor.runIndex) {
        if (records.length === limit) {
          more = true;
          break;
        }
        let value: unknown = JSON.parse(
          Buffer.from(await this.#artifacts.get(source.ref)).toString("utf8"),
        );
        for (const key of source.keys) {
          value = (value as Record<string | number, unknown>)[key];
        }
        records.unshift(
          validateTranscriptRunRecord(value as TranscriptRunRecord, commit.runId),
        );
      }
      commit = await this.#readIndex.latest(
        this.#conversationId,
        commit.commitRevision,
      );
    }
    const after = await this.#readIndex.state(this.#conversationId);
    if (after.deleted || after.clearId !== before.clearId) {
      throw Error("Conversation history generation changed");
    }
    return {
      records,
      ...(more && records[0]
        ? { next: { shardId: "owner-log", runIndex: records[0].runIndex } }
        : {}),
    };
  }

  async taskList(): Promise<TaskListState> {
    return this.#coordinator.select((facts) =>
      snapshot(facts.session.taskList as TaskListState, "Session task list"),
    );
  }

  /** Retry decisions use their original input, never a later list or a new index target. */
  async taskListBeforeMutation(
    requestId: string,
  ): Promise<TaskListState | undefined> {
    assertIdentifier(requestId, "Task-list mutation request id");
    const revision = await this.#coordinator.select((facts) => {
      const request = facts.session.getSessionMutationDigest(requestId);
      if (!request) return undefined;
      if (!facts.session.hasTaskListRequestId(requestId)) {
        throw new Error("Request belongs to another session mutation");
      }
      return request.domainRevision;
    }, conversationDecisionScope({ requestId }));
    if (revision === undefined) return undefined;
    return this.#sessionRead.beforeRevision(
      () => revision,
      (state) => snapshot(state.taskList, "Task-list mutation base"),
    );
  }

  async sessionMutationRequest(
    requestId: string,
  ): Promise<
    { readonly digest: string; readonly domainRevision: number } | undefined
  > {
    assertIdentifier(requestId, "Session mutation request id");
    return this.#sessionRead.read((state) =>
      structuredClone(state.sessionMutationDigests.get(requestId)),
    );
  }

  async advancementWriteRequest(
    requestId: string,
  ): Promise<
    | {
        readonly eventsDigest: string;
        readonly domainRevision: number;
        readonly receipt?: AdvancementSubmissionReceipt;
      }
    | undefined
  > {
    assertIdentifier(requestId, "Advancement write request id");
    if (this.#coordinator.readBaseGeneration === 0) {
      return readConversationExactValue(
        this.#log,
        this.#conversationId,
        "advancementWrites",
        requestId,
      );
    }
    return this.#sessionRead.read((state) =>
      structuredClone(state.advancementWrites.get(requestId)),
    );
  }

  async pendingChannelChallenges(): Promise<readonly PendingChannelChallenge[]> {
    return this.#coordinator.select(
      (facts) =>
        [...facts.tickets.channelInteractions.preparedByChallenge.values()]
          .filter(
            (prepared): prepared is ConversationChannelChallengePreparedRecord =>
              prepared.ref.execution === "conversation" &&
              !facts.tickets.channelInteractions.closedByChallenge.has(
                prepared.token.challengeId,
              ),
          )
          .map((prepared) => {
            const delivered =
              facts.tickets.channelInteractions.deliveredByChallenge.get(
                prepared.token.challengeId,
              );
            return {
              prepared: structuredClone(prepared),
              ...(delivered ? { delivered: structuredClone(delivered) } : {}),
            };
          }),
      conversationDecisionScope({}),
    );
  }

  async recordChannelChallengeDelivered(input: {
    readonly challengeId: string;
    readonly receipt: {
      readonly acceptedAt: string;
      readonly platformMessage?: ChannelMessageRef;
    };
  }): Promise<void> {
    const record = await verifyProtocolStep(() =>
      validateConversationChannelChallengeRecord(
        {
          t: "channel-challenge-delivered",
          challengeId: input.challengeId,
          receipt: input.receipt,
        },
        this.#verifier,
      ),
    );
    await this.#coordinator.transact<void>(
      (facts) =>
        decideRecordChannelChallengeDelivered({
          conversationId: this.#conversationId,
          challengeId: input.challengeId,
          record,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ input }),
    );
  }

  async closeChannelChallenge(input: {
    readonly challengeId: string;
    readonly outcome: "cancelled" | "expired";
    readonly at: string;
  }): Promise<void> {
    const record = await verifyProtocolStep(() =>
      validateConversationChannelChallengeRecord(
        {
          t: "channel-challenge-closed",
          challengeId: input.challengeId,
          outcome: input.outcome,
          at: input.at,
        },
        this.#verifier,
      ),
    );
    await this.#coordinator.transact<void>(
      (facts) =>
        decideCloseChannelChallenge({
          conversationId: this.#conversationId,
          challengeId: input.challengeId,
          record,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ input }),
    );
  }

  async adoptConversationChannelFrame(
    frameInput: StreamFrame,
  ): Promise<ConversationChannelFrameAdoption> {
    const frame = validateStreamFrame(frameInput);
    const ref = frame.ref;
    if (
      ref.execution !== "conversation" ||
      ref.conversationId !== this.#conversationId ||
      ref.ownerEpoch !== this.#ownerEpoch
    ) {
      throw new TypeError(
        "Conversation channel frame belongs to a different authority",
      );
    }
    const payload = frame.payload;
    if (payload.kind !== "interaction") return {};

    const transaction =
      await this.#coordinator.transact<ConversationChannelFrameAdoption>(
        (facts, context) =>
          decideAdoptConversationChannelFrame({
            conversationId: this.#conversationId,
            frame,
            at: context.at,
            signer: this.#signer,
            verifier: this.#verifier,
            facts,
          }),
        [],
        [],
        conversationDecisionScope({ frameInput }),
      );
    return transaction.value;
  }

  async authorizeConversationChannelCallback(input: {
    readonly token: ConversationChannelChallengeToken;
    readonly responder: ChannelResponderRef;
    readonly at?: string;
  }): Promise<{
    readonly assignmentId: string;
    readonly interactionRequestId: string;
  }> {
    const token = await verifyProtocolStep(() =>
      validateChannelChallengeToken(input.token, this.#verifier),
    );
    if (token.ref.execution !== "conversation") {
      throw new TypeError(
        "Conversation channel callback requires a conversation token",
      );
    }
    return this.#coordinator.select(
      (facts) =>
        decideAuthorizeChannelCallback({
          token: token as Extract<typeof token, { ref: { execution: "conversation" } }>,
          responder: input.responder,
          activeAt: input.at ?? this.#clock(),
          facts,
        }),
      conversationDecisionScope({ input }),
    );
  }

  async primeImportedReadBase(
    records: readonly ConversationTransferAuthorityRecord[],
  ): Promise<void> {
    await this.#coordinator.runSerial(async () => {
      this.#coordinator.bumpReadBaseGeneration();
      await this.#readIndex.installBase(records);
      this.#sessionRead.installBase(records);
      this.#messageRead.installBase(records);
    });
  }

  async installImportedBase(source: ConversationBaseSource): Promise<void> {
    await this.#coordinator.runSerial(async () => {
      this.#coordinator.setImportedBaseSource(source);
      registerConversationBaseSource(this.#artifacts, source);
      this.#readIndex.installBaseView(source);
      this.#messageRead.installBaseView(source);
      this.#sessionRead.installBaseSource({
        current: () => this.#readImportedSessionState(source),
        atRevision: (through) =>
          this.#readImportedSessionState(source, through),
      });
    });
  }

  async #readImportedSessionState(
    source: ConversationBaseSource,
    throughRevision?: number,
  ): Promise<RunProjection> {
    const state = emptyConversationRunProjection(this.#conversationId);
    if (throughRevision === undefined) {
      return source.read(async (view) => {
        const root = await readConversationRunRoot(view, this.#conversationId);
        state.domainRevision = root.domainRevision;
        state.deleted = root.deleted;
        state.clearedThroughLsn = root.clearedThroughLsn;
        state.taskList = structuredClone(root.taskList ?? { items: [] });
        state.sessionName = root.sessionName;
        state.modelSelection = root.modelSelection ? structuredClone(root.modelSelection) : undefined;
        state.sessionMeta = root.sessionMeta;
        state.lastActiveAt = root.lastActiveAt;
        if (root.latestSegment) state.segments.push(root.latestSegment);
        for (const name of [
          "sessionMetaByRequest",
          "sessionMutationDigests",
          "advancementWrites",
          "advancementSessions",
          "taskListRequestIds",
        ] as const) {
          const p = conversationStateFieldPrefix(
            this.#conversationId,
            `extra-${name}`,
          );
          let after: string | undefined;
          do {
            const page = await view.scan(
              { ...(after ? { gt: after } : { gte: p }), lt: `${p}\uffff` },
              64,
            );
            for (const entry of page.entries) {
              const row = entry.value as unknown as {
                key: string;
                value: JsonValue;
              };
              if (typeof row.key !== "string") {
                throw corruptRunJournal("Imported session row has no identity");
              }
              if (name === "taskListRequestIds") {
                state.taskListRequestIds.add(row.key);
              } else {
                (state[name] as Map<string, unknown>).set(
                  row.key,
                  decodeConversationState(row.value),
                );
              }
            }
            after = page.continuation ? page.entries.at(-1)!.key : undefined;
          } while (after);
        }
        return state;
      });
    }
    const p = "source/session-range/";
    let after: string | undefined;
    do {
      const page = await source.read((view) =>
        view.scan(
          { ...(after ? { gt: after } : { gte: p }), lt: `${p}\uffff` },
          64,
        ),
      );
      for (const entry of page.entries) {
        if (currentMaintenanceAbortSignal().aborted) {
          throw new StorageMaintenanceCancelledError();
        }
        const range = entry.value as unknown as {
          firstRevision: number;
          lastRevision: number;
          firstRecord: number;
        };
        if (range.firstRevision > throughRevision) return state;
        const group = await source.group(range.firstRecord);
        if (!group) {
          throw corruptRunJournal(
            "Imported session revision has no source group",
          );
        }
        for (const record of group.entries) {
          if (state.domainRevision >= throughRevision) break;
          if (record.stream === runStream(this.#conversationId)) {
            await this.#reduceSessionFacts(
              state,
              record,
              group,
              group.sourceLsn,
              throughRevision,
            );
          }
        }
        if (state.domainRevision >= throughRevision) return state;
      }
      after = page.continuation ? page.entries.at(-1)!.key : undefined;
    } while (after);
    return state;
  }

  async restoreRecoveryCheckpoint(): Promise<boolean> {
    return this.#coordinator.restoreRecoveryCheckpoint();
  }

  discardProjectionCheckpoints(): void {
    this.#coordinator.discardProjectionCheckpoints();
  }

  async primeRecoverySnapshot(
    snapshotValue: AuthorityLogSnapshot<unknown>,
  ): Promise<void> {
    await this.#coordinator.primeRecoverySnapshot(snapshotValue);
  }

  async authorityState(): Promise<{
    readonly domainRevision: number;
    readonly commitRevision: number;
    readonly deleted: boolean;
    readonly hasDurableIdentity: boolean;
    readonly pendingLifecycleProjections: number;
  }> {
    if (
      this.#coordinator.readBaseGeneration === 0 &&
      !this.#coordinator.importedBaseSource
    ) {
      const exact = await this.#coordinator.readCurrentIndexed((view) =>
        readIndexedConversationAuthority(view, this.#conversationId),
      );
      if (exact !== undefined) return exact;
    }
    return this.#coordinator.select(
      (facts) => ({
        domainRevision: facts.session.domainRevision,
        commitRevision: facts.commitPublish.latestCommit?.commitRevision ?? 0,
        deleted: facts.session.deleted,
        hasDurableIdentity:
          facts.session.hasDurableIdentity ??
          (facts.session.sessionMeta !== undefined ||
            facts.queueInput.hasAnyAdmitted() ||
            facts.session.hasAnyLifecycleRequests()),
        pendingLifecycleProjections:
          facts.session.pendingLifecycleCount ??
          facts.session.pendingLifecycleProjectionSize,
      }),
      conversationDecisionScope({}),
    );
  }

  async transactDeferredIntent<Value>(input: {
    readonly ownerEpoch: number;
    readonly candidateReferences?: readonly ArtifactRef[];
    readonly decide: (
      state: DeferredIntentConversationAuthorityState,
      projection: DurableProjectionReadContext,
      transaction: import("@zhixing-ai/core/authority").ProjectionTransactionContext,
    ) =>
      | import("@zhixing-ai/core/authority").ProjectionTransactionDecision<
          IntentStreamRecord,
          Value
        >
      | Promise<
          import("@zhixing-ai/core/authority").ProjectionTransactionDecision<
            IntentStreamRecord,
            Value
          >
        >;
  }): Promise<Value> {
    if (input.ownerEpoch !== this.#ownerEpoch) {
      throw new TypeError(
        "Deferred intent transaction belongs to another owner epoch",
      );
    }
    const transaction = await this.#coordinator.transact<Value>(
      async (facts, authorityPrefix) =>
        input.decide(
          {
            ownerEpoch: this.#ownerEpoch,
            hasDurableIdentity:
              facts.session.hasDurableIdentity === true ||
              facts.session.sessionMeta !== undefined ||
              facts.queueInput.hasAnyAdmitted() ||
              facts.session.hasAnyLifecycleRequests() ||
              (await conversationIdentityExistsAt(
                authorityPrefix.readProjection(
                  CONVERSATION_IDENTITY_PROJECTION_ID,
                ),
                this.#conversationId,
              )),
            deleted: facts.session.deleted,
          },
          authorityPrefix.readProjection(DEFERRED_INTENT_PROJECTION_ID),
          authorityPrefix,
        ),
      input.candidateReferences ?? [],
      [CONVERSATION_IDENTITY_PROJECTION_ID, DEFERRED_INTENT_PROJECTION_ID],
      conversationDecisionScope({ input }),
    );
    return transaction.value;
  }

  async touchWorksceneSession(input: {
    readonly requestId: string;
    readonly sceneId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string }> {
    try {
      assertPlainRecord(input, "Session activity input");
      assertExactRecordKeys(
        input,
        ["at", "requestId", "sceneId"],
        "Session activity input",
      );
      assertIdentifier(input.requestId, "Session activity request id");
      assertIdentifier(input.sceneId, "Session activity scene id");
      assertCanonicalActivityTime(input.at);
      assertWorksceneIdentity(this.#conversationId, input.sceneId);
    } catch (error) {
      throw new SessionActivityRejectedError(
        error instanceof Error
          ? error.message
          : "Session activity input is invalid",
        { cause: error },
      );
    }
    const transaction = await this.#coordinator.transact<{
      readonly revision: number;
      readonly at: string;
    }>(
      (facts) =>
        decideTouchWorksceneSession({
          conversationId: this.#conversationId,
          requestId: input.requestId,
          sceneId: input.sceneId,
          at: input.at,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ input }),
    );
    return transaction.value;
  }

  async deleteWorksceneSession(input: {
    readonly requestId: string;
    readonly sceneId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string } | undefined> {
    assertPlainRecord(input, "Session deletion input");
    assertExactRecordKeys(
      input,
      ["at", "requestId", "sceneId"],
      "Session deletion input",
    );
    assertIdentifier(input.requestId, "Session deletion request id");
    assertIdentifier(input.sceneId, "Session deletion scene id");
    assertCanonicalActivityTime(input.at);
    assertWorksceneIdentity(this.#conversationId, input.sceneId);
    const transaction = await this.#coordinator.transact<
      { readonly revision: number; readonly at: string } | undefined
    >(
      (facts) =>
        decideDeleteWorksceneSession({
          conversationId: this.#conversationId,
          requestId: input.requestId,
          sceneId: input.sceneId,
          at: input.at,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ input }),
    );
    return transaction.value;
  }

  async lifecycleRequest(
    requestId: string,
  ): Promise<ConversationLifecycleProjectionInput | undefined> {
    assertIdentifier(requestId, "Session lifecycle request id");
    return this.#coordinator.select((facts) => {
      const lifecycle = facts.session.getLifecycleByRequest(requestId);
      const sessionMeta = facts.session.getSessionMetaByRequest(requestId);
      const record: PendingLifecycleProjection | undefined =
        lifecycle ??
        (sessionMeta?.operation === "delete"
          ? {
              mutation: "delete",
              domainRevision: sessionMeta.domainRevision,
              requestId: sessionMeta.requestId,
            }
          : undefined);
      return record
        ? {
            conversationId: this.#conversationId,
            mutation: record.mutation,
            domainRevision: record.domainRevision,
            requestId: record.requestId,
          }
        : undefined;
    }, conversationDecisionScope({ requestId }));
  }

  async completeLifecycleProjection(
    input: Omit<ConversationLifecycleProjectionInput, "conversationId">,
  ): Promise<boolean> {
    assertIdentifier(input.requestId, "Session lifecycle request id");
    const transaction = await this.#coordinator.transact<boolean>(
      (facts) =>
        decideCompleteLifecycleProjection({
          conversationId: this.#conversationId,
          request: input,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ input }),
    );
    return transaction.value;
  }

  async resumeLifecycleProjections(
    project: ConversationLifecycleProjection,
  ): Promise<number> {
    const pending = await this.#coordinator.select(
      (facts) =>
        [...facts.session.listPendingLifecycleProjections()]
          .sort((left, right) => left.domainRevision - right.domainRevision)
          .map((record) => snapshot(record, "Pending lifecycle projection")),
      conversationDecisionScope({ project }),
    );
    let projected = 0;
    for (const record of pending) {
      const input = {
        conversationId: this.#conversationId,
        mutation: record.mutation,
        domainRevision: record.domainRevision,
        requestId: record.requestId,
      } as const;
      await project(input);
      if (await this.completeLifecycleProjection(input)) projected += 1;
    }
    return projected;
  }

  onStatus(
    listener: (notice: ConversationStatusNotice) => void | Promise<void>,
  ): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async admit(input: {
    readonly ingressKey: string;
    readonly runId: string;
    readonly userInput: UserTurnInput;
    readonly attachments?: readonly ContentAssetRef[];
    readonly ingress: IngressContext;
    readonly invocation: ConversationInvocation;
    readonly environment?: ExplicitEnvironmentSelection;
    readonly queuedPosition: number;
  }): Promise<void> {
    assertIdentifier(input.ingressKey, "Ingress key");
    assertIdentifier(input.runId, "Run id");
    validateNonEmptyUserTurnInput(input.userInput);
    if (
      !Number.isSafeInteger(input.queuedPosition) ||
      input.queuedPosition < 0
    ) {
      throw new TypeError("Queued position must be a non-negative safe integer");
    }
    const userInput = snapshot(input.userInput, "Run input");
    const ingress = validateIngressContext(input.ingress);
    const invocation = validateConversationInvocation(input.invocation);
    const environment =
      input.environment === undefined
        ? undefined
        : validateExplicitEnvironmentSelection(input.environment);
    if (environment && ingress.kind !== "first-party") {
      throw new TypeError(
        "Only first-party admission may carry an environment selection",
      );
    }
    const attachments = validateContentAssetRefs(input.attachments ?? [], {
      allowEmpty: true,
      label: "Run admission attachments",
    });
    const prepared = await prepareStored(userInput, this.#artifacts);
    const admitted: Extract<ConversationRunJournalRecord, { t: "admitted" }> = {
      t: "admitted",
      ingressKey: input.ingressKey,
      runId: input.runId,
      input: prepared.stored,
      ...(attachments.length > 0 ? { attachments } : {}),
      ingress,
      invocation,
      ...(environment ? { environment } : {}),
      queuedPosition: input.queuedPosition,
    };

    await this.#coordinator.transact<void>(
      (facts) =>
        decideAdmitRun({
          conversationId: this.#conversationId,
          ingressKey: input.ingressKey,
          runId: input.runId,
          userInput,
          ingress,
          invocation,
          environment,
          attachments,
          queuedPosition: input.queuedPosition,
          admitted,
          facts,
        }),
      collectArtifactRefs([prepared.references, attachments]),
      [],
      conversationDecisionScope({ input }),
    );
  }

  /** 原子接纳普通输入：追加到可接收的 Run，或创建后续排队 Run。 */
  async applyInputControl(input: {
    readonly admission: ControlAdmissionJournal;
    readonly envelope: InitialControlEnvelope;
    readonly source: TrustedControlSource;
    readonly runId: string;
  }): Promise<ControlAdmissionOutcome> {
    assertIdentifier(input.runId, "Run id");
    const body = input.envelope.body;
    if (body.t !== "input") {
      throw new TypeError(
        "Conversation input admission requires an input request",
      );
    }
    validateNonEmptyUserTurnInput(body.input);
    const userInput = snapshot(body.input, "Run input");
    const invocation = validateConversationInvocation(body.invocation);
    const environment =
      body.environment === undefined
        ? undefined
        : validateExplicitEnvironmentSelection(body.environment);
    const attachments = validateContentAssetRefs(body.attachments ?? [], {
      allowEmpty: true,
      label: "Control input attachments",
    });
    const prepared = await prepareStored(userInput, this.#artifacts);
    await input.admission.prepareRecovery();
    const sceneId = this.#worksceneFence();
    const apply = (
      basis: { state: RunProjection; cursor: ProjectionCursor } | undefined,
      onProjected: (state: RunProjection, cursor: ProjectionCursor) => void,
    ) =>
      input.admission.applyAuthority<RunProjection, InitialControlEnvelope>({
        envelope: input.envelope,
        source: input.source,
        stream: runStream(this.#conversationId),
        initial: emptyConversationRunProjection(this.#conversationId),
        ...(basis ? { targetBase: basis } : {}),
        readProjectionIds: [
          ...this.#coordinator.deliveryProjectionIds(),
          ...(sceneId === undefined ? [] : [WORKSCENE_AUTHORITY_PROJECTION_ID]),
        ],
        onProjected,
        reducer: (state, record, commit) =>
          this.#coordinator.reduceRunProjection(
            state,
            record as LogicalRecord<ConversationCommitLogRecord>,
            commit as CommitEnvelope<ConversationCommitLogRecord>,
          ),
        candidateReferences: prepared.references,
        companionStreams: this.#delivery ? ["delivery"] : [],
        prepareCompanions: async (state, context, plan) => {
          const statuses = conversationStatusDeliveryInputs(
            this.#conversationId,
            state,
            plan.authorityEntries ?? [],
            context.authorityPrefix.at,
          );
          const delivery =
            (await this.#delivery?.prepareConversationStatuses(
              statuses,
              context.authorityPrefix,
              plan.authorityEntries ?? [],
            )) ?? {
              accepted: true as const,
              records: [],
              stagedRevisions: new Map(),
              stagedConflicts: new Map(),
            };
          if (!delivery.accepted) {
            throw corruptRunJournal(delivery.error.message);
          }
          return delivery.records;
        },
        onCommitted: (state, commit) => {
          this.#publishStatusNotices(
            conversationStatusNoticesForCommit(
              readConversationDecisionFacts(state).assignment,
              commit,
              this.#conversationId,
              this.#ownerEpoch,
            ),
          );
        },
        decide: async (state, context) => {
          const worksceneDeleted =
            sceneId !== undefined &&
            (await isWorksceneDeletedAt(
              context.authorityPrefix.readProjection(
                WORKSCENE_AUTHORITY_PROJECTION_ID,
              ),
              sceneId,
            ));
          return decideInputControl({
            conversationId: this.#conversationId,
            ownerEpoch: this.#ownerEpoch,
            runId: input.runId,
            userInput,
            invocation,
            environment,
            attachments,
            storedInput: prepared.stored,
            request: context.envelope.body,
            ingress: context.ingress,
            nextLsn: context.authorityPrefix.nextLsn,
            worksceneDeleted,
            facts: readConversationDecisionFacts(state),
          });
        },
      });
    return this.#coordinator.withRunProjection(
      (basis, publish) => {
        const application = () => apply(basis, publish);
        const transact = () =>
          this.#delivery ? this.#delivery.coordinate(application) : application();
        return this.#resources
          ? this.#resources.coordinate(transact, {
              caller: "conversation-journal.input",
            })
          : transact();
      },
      conversationDecisionScope({ input }),
    );
  }

  /** 执行方取得通用输入端口；领域消息和消费事实仍只属于本 owner。 */
  async assertInputExecutor(
    runId: string,
    assignmentId: string,
    executorId: string,
  ): Promise<void> {
    await this.#coordinator.select(
      (facts) =>
        decideAssertInputExecutor({
          runId,
          assignmentId,
          executorId,
          facts,
        }),
      conversationDecisionScope({ runId, assignmentId, executorId }),
    );
  }

  async openRunInput(
    runId: string,
    assignmentId: string,
  ): Promise<RunInputPort> {
    await this.#coordinator.transact<void>(
      (facts) =>
        decideOpenRunInput({
          conversationId: this.#conversationId,
          runId,
          assignmentId,
          facts,
        }),
      [],
      [],
      this.#coordinator.exactCommandScope({ runId, assignmentId }),
    );
    return {
      receive: (boundary) =>
        this.receiveRunInput(runId, assignmentId, boundary),
      close: () => this.closeRunInput(runId, assignmentId),
    };
  }

  async receiveRunInput(
    runId: string,
    assignmentId: string,
    input: { readonly boundary: number; readonly closing: boolean },
  ): Promise<readonly Message[]> {
    if (!Number.isSafeInteger(input.boundary) || input.boundary < 1) {
      throw new TypeError("Invalid input boundary");
    }
    const result = await this.#coordinator.transact<readonly Message[]>(
      (facts) =>
        decideReceiveRunInput({
          conversationId: this.#conversationId,
          runId,
          assignmentId,
          boundary: input.boundary,
          closing: input.closing,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ runId, assignmentId, input }),
    );
    return result.value;
  }

  async closeRunInput(runId: string, assignmentId: string): Promise<void> {
    await this.#coordinator.transact<void>(
      (facts) =>
        decideCloseRunInput({
          conversationId: this.#conversationId,
          runId,
          assignmentId,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ runId, assignmentId }),
    );
  }

  async messageStatus(
    messageId: string,
  ): Promise<ConversationMessageStatus | undefined> {
    return this.#messageRead.messageStatus(messageId);
  }

  async messageInputsOutsideHistory() {
    return this.#messageRead.messageInputsOutsideHistory();
  }

  async recoveryDeleted(): Promise<boolean> {
    if ((await this.#readIndex.state(this.#conversationId)).deleted === true) {
      return true;
    }
    const sceneId = this.#worksceneFence();
    if (sceneId === undefined) return false;
    return (
      await this.#log.transactDurableProjection(
        WORKSCENE_AUTHORITY_PROJECTION_ID,
        async (view) => ({
          kind: "return" as const,
          value: await isWorksceneDeletedAt(view, sceneId),
        }),
      )
    ).value;
  }

  #worksceneFence(): string | undefined {
    const scope = parseConversationId(this.#conversationId).scope;
    if (scope.kind !== "workscene") return undefined;
    registerWorksceneAuthorityProjection(this.#log);
    return scope.sceneId;
  }

  async recoveryPage(
    request: ConversationRecoveryRequest,
    legacyBase?: {
      readonly id: string;
      readonly records: readonly ConversationTransferAuthorityRecord[];
      readonly clearId?: string;
      readonly clearedThroughLsn: number;
    },
  ): Promise<ConversationRecoveryPage> {
    if (request.conversationId !== this.#conversationId) {
      throw new TypeError("Recovery cursor belongs to another conversation");
    }
    if (request.mode === "control-targets") {
      return this.#readIndex.controlTargets(this.#conversationId);
    }
    if (request.mode === "body-page") {
      const generation = this.#coordinator.readBaseGeneration;
      const page = await (request.includeInputs || request.cursor?.history
        ? new ConversationTimelineReader(
            this.#readIndex,
            this.#artifacts,
            this.#conversationId,
            this.#ownerEpoch,
          ).page(request)
        : new ConversationBodyReader(
            this.#readIndex,
            this.#artifacts,
            this.#conversationId,
            this.#ownerEpoch,
          ).page(request));
      return generation === this.#coordinator.readBaseGeneration
        ? page
        : { fragments: [], hasMore: true, reset: true };
    }
    if (request.mode === "context") {
      return new ConversationBodyReader(
        this.#readIndex,
        this.#artifacts,
        this.#conversationId,
        this.#ownerEpoch,
      ).context();
    }
    if (request.mode === "completion") {
      assertIdentifier(request.runId, "Completion run id");
      if (
        request.ownerEpoch !== undefined &&
        request.ownerEpoch !== this.#ownerEpoch
      ) {
        throw new Error("Completion owner generation changed");
      }
      const commit = await this.#readIndex.commit(
        this.#conversationId,
        request.runId,
      );
      if (!commit) {
        return {
          conversationId: this.#conversationId,
          runId: request.runId,
          ownerEpoch: this.#ownerEpoch,
        };
      }
      const summary = await new ConversationBodyReader(
        this.#readIndex,
        this.#artifacts,
        this.#conversationId,
        this.#ownerEpoch,
      ).summary(commit);
      if ("ready" in summary) {
        throw Error("Committed metadata index is being prepared");
      }
      return {
        conversationId: this.#conversationId,
        runId: request.runId,
        ownerEpoch: this.#ownerEpoch,
        commitRevision: commit.commitRevision,
        summary,
      };
    }
    if (request.mode === "run-outcomes") {
      if (!Array.isArray(request.runIds) || request.runIds.length > 32) {
        throw new TypeError("Run outcome request exceeds 32 runs");
      }
      for (const runId of request.runIds) {
        assertIdentifier(runId, "Run outcome id");
      }
      for (;;) {
        const base = this.#coordinator.readBase();
        const visibility = await this.#readIndex.outsideVisibility(
          this.#conversationId,
        );
        if (visibility.deleted) return { entries: [] };
        const runIds = [...new Set(request.runIds)];
        const controls = await this.#readIndex.control(
          this.#conversationId,
          runIds,
        );
        const statusAt = await this.#readIndex.statusAt(
          this.#conversationId,
          runIds,
        );
        const imported =
          !!this.#coordinator.importedBaseSource || !!legacyBase;
        const entries = runIds.map((runId: string, index: number) => {
          const status = controls.get(runId);
          const at = statusAt[index];
          type State = ConversationRunOutcomesPage["entries"][number]["state"];
          if (!status?.entry) {
            return {
              runId,
              state: (status?.commit
                ? "committed"
                : imported
                  ? "unknown"
                  : "missing") as State,
            };
          }
          const visible =
            !!at &&
            at.statusRevision === status.entry.statusRevision &&
            (at.local
              ? at.lsn > visibility.localClearedLsn
              : !visibility.baseHidden && at.lsn > visibility.baseClearedLsn);
          if (!visible) return { runId, state: "unknown" as State };
          const state: State = status.entry.state;
          const reason =
            status.entry.reason &&
            (state === "failed" || state === "expired" || state === "cancelled")
              ? status.entry.reason.slice(0, 512)
              : undefined;
          return { runId, state, ...(reason ? { reason } : {}) };
        });
        if (this.#coordinator.sameReadBase(base)) return { entries };
      }
    }
    if (request.mode === "run-facts") {
      if (!Array.isArray(request.runIds) || request.runIds.length > 32) {
        throw new TypeError("Run fact request exceeds 32 runs");
      }
      for (const runId of request.runIds) assertIdentifier(runId, "Run fact id");
      const through = request.historyThroughInputLsn;
      if (!Number.isSafeInteger(through) || through < 0) {
        throw new TypeError("Invalid ordered history boundary");
      }
      for (;;) {
        const base = this.#coordinator.readBase();
        if ((await this.#readIndex.state(this.#conversationId)).deleted) {
          return { entries: [] };
        }
        const runIds = [...new Set(request.runIds)];
        const controls = await this.#readIndex.control(
          this.#conversationId,
          runIds,
        );
        const statusAt = await this.#readIndex.statusAt(
          this.#conversationId,
          runIds,
        );
        const entries: {
          order: string;
          fact: Exclude<ConversationControlFact, { kind: "input" }>;
        }[] = [];
        for (const [index, runId] of runIds.entries()) {
          const status = controls.get(runId)!;
          const at = statusAt[index];
          const covered =
            !!at &&
            at.statusRevision === status.entry?.statusRevision &&
            (!at.local || at.lsn <= through);
          const fact =
            covered && !openRunState(status.entry!.state)
              ? this.#statusFact(runId, status, true)
              : undefined;
          if (fact) {
            entries.push({
              order: sourceOrder(at!.local, at!.lsn, at!.item),
              fact,
            });
          }
          const final = status.commit
            ? await this.#readIndex.final(this.#conversationId, runId)
            : undefined;
          if (
            final &&
            final.lsn <= through &&
            final.commitRevision === status.commit!.commitRevision
          ) {
            entries.push({
              order: sourceOrder(true, final.lsn, final.item),
              fact: {
                kind: "final",
                frame: finalFrame(
                  {
                    t: "final",
                    conversationId: this.#conversationId,
                    runId,
                    commitRevision: final.commitRevision,
                    digest: final.digest,
                    state: "pending",
                  },
                  await this.#readIndex.finalConflicts(status.commit!),
                ),
              },
            });
          }
        }
        entries.sort((a, b) =>
          a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
        );
        if (this.#coordinator.sameReadBase(base)) return { entries };
      }
    }
    const importedSource = this.#coordinator.importedBaseSource;
    const sourceMeta = importedSource
      ? ((await importedSource.read((view) =>
          view.get(`directory/${JSON.stringify(this.#conversationId)}:meta`),
        )) as unknown as { clearId?: string; clearedLsn?: number } | undefined)
      : undefined;
    const base = importedSource
      ? {
          id: importedSource.namespace,
          clearId: sourceMeta?.clearId,
          clearedThroughLsn: sourceMeta?.clearedLsn ?? 0,
          count: importedSource.recordCount,
          page: (start: number) => importedSource.recordsPage(start),
        }
      : legacyBase
        ? {
            ...legacyBase,
            count: legacyBase.records.length,
            page: async (start: number) =>
              legacyBase.records.slice(start, start + 63),
          }
        : undefined;
    const readGeneration = this.#coordinator.readBaseGeneration;
    const head = await this.#log.checkpoint();
    const lifecycleOf = async () => {
      const meta = await this.#readIndex.state(this.#conversationId);
      return {
        cleared: meta.clearedLsn ?? 0,
        clearId: meta.clearId,
        deleted: !!meta.deleted,
      };
    };
    const lifecycle = await lifecycleOf();
    const baseVisible = !!base && lifecycle.clearId === base.clearId;
    const targetClear = baseVisible ? 0 : lifecycle.cleared;
    const supplied = request.cursor;
    const reset =
      !!supplied &&
      (supplied.conversationId !== this.#conversationId ||
        supplied.clearedThroughLsn !== lifecycle.cleared ||
        supplied.clearId !== lifecycle.clearId ||
        supplied.baseId !== base?.id ||
        supplied.upper.logId !== head.logId ||
        supplied.upper.lsn > head.lsn);
    if (supplied && !reset && supplied.upper.lsn > 0) {
      await this.#log.readEnvelopeAt(supplied.upper);
    }
    if (request.mode === "input-page") {
      assertIdentifier(request.runId, "Run input history id");
      if (supplied && "runId" in supplied && supplied.runId !== request.runId) {
        throw new TypeError("Run input cursor identity changed");
      }
      const cursor: ConversationInputCursor =
        request.cursor && !reset
          ? { ...request.cursor, ownerEpoch: this.#ownerEpoch }
          : {
              conversationId: this.#conversationId,
              runId: request.runId,
              ownerEpoch: this.#ownerEpoch,
              clearedThroughLsn: lifecycle.cleared,
              clearId: lifecycle.clearId,
              baseId: base?.id,
              upper: head,
              position: 0,
              part: 0,
              offset: 0,
              contentOffset: 0,
            };
      if (lifecycle.deleted || (cursor.imported && !baseVisible)) {
        return { cursor, hasMore: false, reset: true };
      }
      const selected = await this.#readIndex.input(
        this.#conversationId,
        request.runId,
        cursor.position,
        cursor.inputKey,
        !!cursor.imported,
        cursor.imported ? base?.clearedThroughLsn ?? 0 : targetClear,
        cursor.upper.lsn,
      );
      if (!selected) {
        const current = await lifecycleOf();
        return {
          cursor,
          hasMore: false,
          reset:
            reset ||
            readGeneration !== this.#coordinator.readBaseGeneration ||
            current.deleted ||
            current.cleared !== cursor.clearedThroughLsn ||
            current.clearId !== cursor.clearId,
        };
      }
      const position = selected.pointer.position;
      const contentOffset =
        position === cursor.position ? cursor.contentOffset : 0;
      const piece = await readInputTextPage(
        this.#artifacts,
        selected.input,
        position === cursor.position ? cursor.part : 0,
        position === cursor.position ? cursor.offset : 0,
      );
      const current = await lifecycleOf();
      if (
        readGeneration !== this.#coordinator.readBaseGeneration ||
        current.deleted ||
        current.cleared !== cursor.clearedThroughLsn ||
        current.clearId !== cursor.clearId
      ) {
        return { cursor, hasMore: false, reset: true };
      }
      if ("preparing" in piece) return { cursor, hasMore: true, reset };
      const next: ConversationInputCursor = {
        ...cursor,
        position: piece.final ? position + 1 : position,
        part: piece.final ? 0 : piece.part,
        offset: piece.final ? 0 : piece.offset,
        contentOffset: piece.final ? 0 : contentOffset + piece.text.length,
      };
      const page: ConversationInputPage = {
        ...(piece.emittedPart !== undefined || piece.final
          ? {
              input: {
                identity: structuredClone(selected.pointer.identity),
                text: piece.text,
                contentOffset,
                final: piece.final,
                ...(piece.emittedPart !== undefined
                  ? {
                      part: piece.emittedPart,
                      partOffset: piece.partOffset!,
                      partFinal: piece.partFinal!,
                      ...(piece.material ? { material: piece.material } : {}),
                    }
                  : {}),
              },
            }
          : {}),
        cursor: next,
        hasMore: true,
        reset,
      };
      return page;
    }
    if (
      request.historyRunIds &&
      (request.historyRunIds.length > 4 || request.cursor)
    ) {
      throw new TypeError("Invalid consumed history boundary");
    }
    const through = request.historyThrough;
    if (
      through !== undefined &&
      (request.cursor ||
        through.logId !== head.logId ||
        !Number.isSafeInteger(through.lsn) ||
        through.lsn < 0 ||
        through.lsn > head.lsn)
    ) {
      throw new TypeError("Invalid ordered history boundary");
    }
    const origin =
      !request.cursor || reset || request.cursor.after.lsn === 0
        ? await this.#log.originCheckpoint()
        : undefined;
    if (
      through &&
      (through.lsn === 0
        ? through.frameEndOffset !== origin!.frameEndOffset ||
          through.prefixDigest !== origin!.prefixDigest
        : (await this.#log.readEnvelopeAt(through), false))
    ) {
      throw new TypeError("Invalid ordered history boundary");
    }
    if (
      through &&
      (lifecycle.cleared > through.lsn ||
        (importedSource && !(await this.#baseActiveAt(importedSource, through))))
    ) {
      return {
        facts: [],
        cursor: {
          conversationId: this.#conversationId,
          ownerEpoch: this.#ownerEpoch,
          clearedThroughLsn: lifecycle.cleared,
          clearId: lifecycle.clearId,
          baseId: base?.id,
          baseItem: 0,
          upper: head,
          after: origin!,
          item: 0,
        },
        hasMore: false,
        reset: true,
      };
    }
    let historyThroughCommitRevision =
      through === undefined
        ? 0
        : ((await this.#readIndex.historyCommit(
            this.#conversationId,
            through.lsn,
          ))?.commitRevision ?? 0);
    for (const runId of request.historyRunIds ?? []) {
      assertIdentifier(runId, "Consumed history run id");
    }
    const consumed = await this.#readIndex.control(
      this.#conversationId,
      request.historyRunIds ?? [],
    );
    for (const { commit } of consumed.values()) {
      if (through === undefined && commit) {
        historyThroughCommitRevision = Math.max(
          historyThroughCommitRevision,
          commit.commitRevision,
        );
      }
    }
    let cursor: ConversationControlCursor =
      request.cursor && !reset
        ? { ...request.cursor, ownerEpoch: this.#ownerEpoch }
        : through
          ? {
              conversationId: this.#conversationId,
              ownerEpoch: this.#ownerEpoch,
              clearedThroughLsn: lifecycle.cleared,
              clearId: lifecycle.clearId,
              baseId: base?.id,
              baseItem: base?.count ?? 0,
              historyThroughCommitRevision,
              historyThroughInputLsn: through.lsn,
              current: {},
              upper: head,
              after: through.lsn === 0 ? origin! : through,
              item: 0,
            }
          : {
              conversationId: this.#conversationId,
              ownerEpoch: this.#ownerEpoch,
              clearedThroughLsn: lifecycle.cleared,
              clearId: lifecycle.clearId,
              baseId: base?.id,
              baseItem: baseVisible ? 0 : (base?.count ?? 0),
              historyThroughCommitRevision,
              upper: head,
              after: origin!,
              item: 0,
            };
    if (cursor.after.lsn === cursor.upper.lsn && cursor.item === 0) {
      cursor = { ...cursor, upper: head };
    }
    if (
      cursor.after.logId !== head.logId ||
      cursor.after.lsn > cursor.upper.lsn
    ) {
      throw new TypeError("Recovery cursor boundary is invalid");
    }
    if (
      cursor.after.lsn === 0 &&
      (cursor.after.frameEndOffset !== origin!.frameEndOffset ||
        cursor.after.prefixDigest !== origin!.prefixDigest)
    ) {
      throw new TypeError("Recovery origin checkpoint is invalid");
    }
    const facts: ConversationControlFact[] = [];
    const controlFor = async (records: readonly LogicalRecord<unknown>[]) => {
      const ids = new Set<string>();
      for (const record of records) {
        const body = record.body as ConversationCommitLogRecord | undefined;
        if (!body || typeof body !== "object" || !("t" in body)) continue;
        if (
          (record.stream === runStream(this.#conversationId) &&
            (body.t === "state" ||
              (cursor.historyThroughCommitRevision &&
                (body.t === "admitted" || body.t === "run-input-appended")))) ||
          (record.stream === "final-outbox" &&
            body.t === "final" &&
            body.conversationId === this.#conversationId &&
            body.state === "pending")
        ) {
          ids.add(body.runId);
        }
      }
      return this.#readIndex.control(this.#conversationId, [...ids]);
    };
    const collect = async (
      record: LogicalRecord<unknown>,
      upper: ConversationControlCursor["upper"],
      controls: ReadonlyMap<string, ControlRead>,
      imported = false,
    ) => {
      if (!record.body || typeof record.body !== "object" || !("t" in record.body)) {
        return;
      }
      const body = record.body as ConversationCommitLogRecord;
      if (
        record.stream === runStream(this.#conversationId) &&
        "t" in body &&
        (body.t === "admitted" || body.t === "run-input-appended")
      ) {
        if (
          cursor.historyThroughInputLsn !== undefined &&
          (imported || upper.lsn <= cursor.historyThroughInputLsn)
        ) {
          return;
        }
        if (cursor.historyThroughCommitRevision) {
          const commit = controls.get(body.runId)?.commit;
          if (commit && commit.commitRevision <= cursor.historyThroughCommitRevision) {
            return;
          }
        }
        facts.push({
          kind: "input",
          cursor: {
            conversationId: this.#conversationId,
            runId: body.runId,
            ownerEpoch: this.#ownerEpoch,
            clearedThroughLsn: cursor.clearedThroughLsn,
            clearId: cursor.clearId,
            baseId: base?.id,
            ...(imported ? { imported: true as const } : {}),
            inputKey: body.ingressKey,
            upper,
            position: body.t === "admitted" ? body.queuedPosition : body.position,
            part: 0,
            offset: 0,
            contentOffset: 0,
          },
        });
      } else if (
        record.stream === runStream(this.#conversationId) &&
        "t" in body &&
        body.t === "state"
      ) {
        const status = controls.get(body.runId)!;
        const fact =
          status.entry?.statusRevision === body.statusRevision
            ? this.#statusFact(
                body.runId,
                status,
                cursor.historyThroughInputLsn !== undefined &&
                  (imported || upper.lsn <= cursor.historyThroughInputLsn),
                body.assignmentId,
              )
            : undefined;
        if (fact) facts.push(fact);
      } else if (
        record.stream === "final-outbox" &&
        "t" in body &&
        body.t === "final" &&
        body.conversationId === this.#conversationId &&
        body.state === "pending"
      ) {
        const commit = controls.get(body.runId)?.commit;
        if (!commit || commit.commitRevision !== body.commitRevision) {
          throw Error("Conversation final commit binding is unavailable");
        }
        facts.push({
          kind: "final",
          frame: finalFrame(
            body,
            await this.#readIndex.finalConflicts(commit),
          ),
        });
      }
    };
    const currentOrder: string[] = [];
    while (cursor.current && facts.length < 32) {
      const page = await this.#readIndex.openRunPage(
        this.#conversationId,
        cursor.current.after,
      );
      const visible = page.entries.filter(({ run }) =>
        run.local
          ? run.lsn <= cursor.historyThroughInputLsn! && run.lsn > targetClear
          : baseVisible && run.lsn > base!.clearedThroughLsn,
      );
      const controls = await this.#readIndex.control(
        this.#conversationId,
        visible.map(({ run }) => run.runId),
      );
      let after = cursor.current.after;
      let complete = true;
      for (const { key, run } of page.entries) {
        if (facts.length >= 32) {
          complete = false;
          break;
        }
        const status = visible.some((entry) => entry.key === key)
          ? controls.get(run.runId)
          : undefined;
        const fact =
          status?.entry?.statusRevision === run.statusRevision
            ? this.#statusFact(run.runId, status, true)
            : undefined;
        if (fact) {
          facts.push(fact);
          currentOrder.push(sourceOrder(run.local, run.lsn, run.item));
        }
        after = key;
      }
      if (complete && !page.continuation) {
        const { current: _current, ...rest } = cursor;
        cursor = rest;
      } else {
        const next = complete ? page.continuation : after;
        cursor = {
          ...cursor,
          current: next === undefined ? {} : { after: next },
        };
      }
    }
    const imported = base && !cursor.current ? await base.page(cursor.baseItem) : [];
    const importedControls = await controlFor(
      baseVisible
        ? imported.filter((record) => record.lsn > base!.clearedThroughLsn)
        : [],
    );
    for (const record of imported) {
      if (facts.length >= 32) break;
      if (baseVisible && record.lsn > base!.clearedThroughLsn) {
        await collect(record, cursor.upper, importedControls, true);
      }
      cursor = { ...cursor, baseItem: cursor.baseItem + 1 };
    }
    if (
      facts.length < 32 &&
      !cursor.current &&
      cursor.baseItem >= (base?.count ?? 0) &&
      cursor.after.lsn < cursor.upper.lsn &&
      !lifecycle.deleted
    ) {
      const positions = await this.#readIndex.controlPage(
        this.#conversationId,
        cursor.after.lsn,
      );
      const selected = positions
        .filter((position) => position.lsn <= cursor.upper.lsn)
        .slice(0, cursor.after.lsn ? 63 : 64);
      const incoming = cursor.after.lsn ? [cursor.after] : [];
      const envelopes =
        await this.#log.readEnvelopesAt<ConversationCommitLogRecord>([
          ...incoming,
          ...selected,
        ]);
      const tail = {
        commits: incoming.length ? envelopes.slice(1) : envelopes,
        checkpoints: selected,
      };
      if (!selected.length) {
        if (cursor.item) {
          throw new TypeError("Recovery cursor envelope is unavailable");
        }
        cursor = { ...cursor, after: cursor.upper, item: 0 };
      }
      const firstItem = cursor.item;
      function* pending() {
        for (let frame = 0; frame < tail.commits.length; frame++) {
          const envelope = tail.commits[frame]!;
          const boundary = tail.checkpoints[frame]!;
          if (envelope.lsn > cursor.upper.lsn) break;
          const start = frame === 0 ? firstItem : 0;
          if (start > envelope.entries.length) {
            throw new TypeError("Recovery cursor envelope is unavailable");
          }
          if (start === envelope.entries.length) {
            yield { record: undefined, boundary, after: boundary, item: 0 };
          }
          for (let item = start; item < envelope.entries.length; item++) {
            const complete = item + 1 === envelope.entries.length;
            yield {
              record:
                envelope.lsn > targetClear ? envelope.entries[item] : undefined,
              boundary,
              after: complete ? boundary : undefined,
              item: complete ? 0 : item + 1,
            };
          }
        }
      }
      const iterator = pending();
      while (facts.length < 32) {
        const chunk: Exclude<
          ReturnType<typeof iterator.next>["value"],
          void
        >[] = [];
        while (chunk.length < 63) {
          const next = iterator.next();
          if (next.done) break;
          chunk.push(next.value);
        }
        if (!chunk.length) break;
        const controls = await controlFor(
          chunk.flatMap((item) => (item.record ? [item.record] : [])),
        );
        for (const item of chunk) {
          if (item.record) await collect(item.record, item.boundary, controls);
          cursor = {
            ...cursor,
            ...(item.after ? { after: item.after } : {}),
            item: item.item,
          };
          if (facts.length >= 32) break;
        }
      }
      if (
        cursor.item === 0 &&
        (positions.length < 64 ||
          positions.some((position) => position.lsn > cursor.upper.lsn)) &&
        (!selected.length || cursor.after.lsn === selected.at(-1)!.lsn)
      ) {
        cursor = { ...cursor, after: cursor.upper };
      }
    }
    const current = await lifecycleOf();
    if (
      readGeneration !== this.#coordinator.readBaseGeneration ||
      current.cleared !== cursor.clearedThroughLsn ||
      current.clearId !== cursor.clearId ||
      current.deleted
    ) {
      return { facts: [], cursor, hasMore: false, reset: true };
    }
    return {
      facts,
      ...(currentOrder.length ? { currentOrder } : {}),
      cursor,
      hasMore:
        !!cursor.current ||
        cursor.baseItem < (base?.count ?? 0) ||
        cursor.after.lsn < cursor.upper.lsn,
      reset,
    };
  }

  #statusFact(
    runId: string,
    status: ControlRead,
    historyCovered: boolean,
    assignmentId?: string,
  ): Extract<ConversationControlFact, { kind: "status" }> | undefined {
    const notice = conversationStatusNotice(
      this.#conversationId,
      this.#ownerEpoch,
      runId,
      status.entry!,
      assignmentId,
    );
    if (!notice) return;
    return {
      kind: "status",
      ...(historyCovered ? { historyCovered: true } : {}),
      notice:
        "reason" in notice
          ? { ...notice, reason: notice.reason?.slice(0, 2048) }
          : notice,
      communication: status.communication,
      continuation: status.continuation,
      ...(status.commit ? { commitRevision: status.commit.commitRevision } : {}),
    };
  }

  async #baseActiveAt(
    source: ConversationBaseSource,
    through: DurableLogCheckpoint,
  ): Promise<boolean> {
    const binding = (
      await this.#log.transactDurableProjection<
        never,
        ConversationBaseBinding | undefined
      >(CONVERSATION_RUN_STATE_PROJECTION_ID, async (view) => ({
        kind: "return",
        value: (await view.get(
          conversationBaseKey(this.#conversationId),
        )) as unknown as ConversationBaseBinding | undefined,
      }))
    ).value;
    return (
      !!binding &&
      binding.manifest.digest === source.manifestRef.digest &&
      binding.manifest.bytes === source.manifestRef.bytes &&
      binding.activation.logId === through.logId &&
      binding.activation.lsn <= through.lsn
    );
  }

  async assign(
    unsignedEnvelope: UnsignedConversationEnvelope,
  ): Promise<PendingConversationDispatch> {
    if (unsignedEnvelope.work.conversationId !== this.#conversationId) {
      throw new TypeError(
        "Dispatch belongs to a different conversation journal",
      );
    }
    if (unsignedEnvelope.work.ownerEpoch !== this.#ownerEpoch) {
      throw new TypeError("Dispatch belongs to a different owner epoch");
    }
    const envelope = createSignedConversationEnvelope(
      unsignedEnvelope,
      this.#signer,
      this.#verifier,
    );
    const dispatchDigest = dispatchEnvelopeDigest(envelope);
    const existingState = await this.#coordinator.select(
      (facts) =>
        decideAssignPreflight({
          runId: envelope.work.runId,
          assignmentId: envelope.assignmentId,
          facts,
        }),
      this.#coordinator.exactCommandScope({ unsignedEnvelope }),
    );
    const currentAssignment = existingState.currentAssignment;
    if (currentAssignment) {
      if (
        currentAssignment.record.assignmentId !== envelope.assignmentId ||
        currentAssignment.record.dispatchDigest !== dispatchDigest
      ) {
        throw new Error("Run already has a different durable assignment");
      }
      return this.#materializeDispatch(currentAssignment);
    }
    if (existingState.assignmentIdInUse) {
      throw new Error("Assignment id already belongs to a different run");
    }
    const envelopeReferences = [
      ...(await resolveDispatchArtifactClosure(envelope, this.#artifacts))
        .transfer,
    ];
    const artifact = dispatchEnvelopeArtifact(envelope);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error(
        "Dispatch artifact store returned a different reference",
      );
    }
    const transaction = await this.#coordinator.transact<AssignDecision>(
      async (facts, context) => {
        const pendingCancellation = await hasPendingCancellationForRun(
          context.readProjection(CONTROL_PROJECTION_ID),
          this.#artifacts,
          this.#conversationId,
          envelope.work.runId,
        );
        return decideAssign({
          conversationId: this.#conversationId,
          envelope,
          dispatchDigest,
          dispatchRef: artifact.ref,
          pendingCancellation,
          resources: this.#resources,
          facts,
        });
      },
      [artifact.ref, ...envelopeReferences],
      [CONTROL_PROJECTION_ID],
      this.#coordinator.exactCommandScope({ unsignedEnvelope }),
      {
        resourcePreparation: [
          {
            reservationId: envelope.resourceLease.reservationId,
            workload: envelope.resourceLease.workload as RootResourceWorkload,
          },
        ],
      },
    );
    const assigned = transaction.state.assignedById.get(
      transaction.value.assignmentId,
    );
    if (!assigned) {
      throw new Error("Assigned commit did not rebuild its outbox fact");
    }
    const written =
      transaction.value.appended === true &&
      assigned.record.dispatchRef.digest === artifact.ref.digest &&
      assigned.record.dispatchDigest === dispatchDigest;
    return this.#materializeDispatch(
      snapshot(assigned, "Assigned outbox projection"),
      written ? snapshot(envelope, "Written dispatch envelope") : undefined,
    );
  }

  async pendingDispatches(): Promise<PendingConversationDispatch[]> {
    const assigned: AssignedProjection | ReadonlyAssignedFact | undefined =
      this.#coordinator.readBaseGeneration === 0 &&
      !this.#coordinator.importedBaseSource
        ? await this.#coordinator.readCurrentIndexed((view) =>
            readIndexedPendingDispatch(view, this.#conversationId),
          )
        : await this.#coordinator.select(
            (facts) =>
              facts.assignment.selectActive((candidate, current) =>
                current === "dispatched" &&
                !candidate.acked &&
                facts.assignment.getSuperseded(candidate.record.assignmentId) ===
                  undefined &&
                !facts.assignment.isAssignmentClosed(
                  candidate.record.assignmentId,
                )
                  ? snapshot(candidate, "Pending dispatch")
                  : undefined,
              ),
            conversationDecisionScope({}),
          );
    return assigned ? [await this.#materializeDispatch(assigned)] : [];
  }

  async recentExecutorAffinity(): Promise<string | undefined> {
    return this.#coordinator.select((facts) => {
      const committed = facts.commitPublish.latestCommit;
      if (!committed) return undefined;
      const assigned = facts.assignment.getAssigned(committed.assignmentId);
      if (!assigned) {
        throw corruptRunJournal(
          "Committed conversation run has no durable assignment",
        );
      }
      return assigned.record.executorId;
    }, conversationDecisionScope({}));
  }

  async advancementEvidenceDispatch(
    runId: string,
  ): Promise<Pick<PendingConversationDispatch, "envelope"> | undefined> {
    assertIdentifier(runId, "Run id");
    const assigned = await this.#coordinator.select((facts) => {
      const committed = facts.commitPublish.findCommittedByRunId(runId);
      if (!committed) return undefined;
      const projection = facts.assignment.getAssigned(committed.assignmentId);
      if (!projection) {
        throw corruptRunJournal("Committed run has no durable assignment");
      }
      return snapshot(projection, "Advancement evidence assignment");
    }, conversationDecisionScope({ runId }));
    if (!assigned) return;
    const envelope = await verifyProtocolStep(() =>
      this.#artifacts
        .get(assigned.record.dispatchRef as ArtifactRef)
        .then((bytes) =>
          validateConversationEnvelope(
            JSON.parse(Buffer.from(bytes).toString("utf8")),
            this.#verifier,
          ),
        ),
    );
    if (
      envelope.assignmentId !== assigned.record.assignmentId ||
      envelope.work.conversationId !== this.#conversationId ||
      envelope.work.runId !== runId
    ) {
      throw corruptRunJournal(
        "Historical evidence dispatch does not bind its committed run",
      );
    }
    return { envelope };
  }

  async pendingInputs(): Promise<PendingConversationInput[]> {
    return this.#coordinator.select(
      (facts) =>
        facts.queueInput.listOrderedQueuedEntries().map(({ queuedPosition, runId }) => {
          const admitted = facts.queueInput.getAdmitted(runId);
          const current = facts.assignment.getRunState(runId);
          if (
            !admitted ||
            admitted.input === undefined ||
            current?.state !== "queued" ||
            facts.assignment.getAssignmentIdForRun(runId) !== undefined ||
            admitted.record.queuedPosition !== queuedPosition
          ) {
            throw corruptRunJournal("Queued input projection is inconsistent");
          }
          return {
            runId,
            input: snapshot(
              admitted.input as UserTurnInput,
              "Pending conversation input",
            ),
            attachments: snapshot(
              (admitted.record.attachments ?? []) as ContentAssetRef[],
              "Pending conversation attachments",
            ),
            ingress: snapshot(
              admitted.record.ingress as IngressContext,
              "Pending conversation ingress",
            ),
            invocation: snapshot(
              admitted.record.invocation as ConversationInvocation,
              "Pending conversation invocation",
            ),
            ...(admitted.record.environment
              ? {
                  environment: snapshot(
                    admitted.record.environment as ExplicitEnvironmentSelection,
                    "Pending conversation environment",
                  ),
                }
              : {}),
            queuedPosition,
          };
        }),
      conversationDecisionScope({}, { hydrate: true }),
    );
  }

  async cancellableRunIds(): Promise<string[]> {
    return (await this.cancellableRuns()).map((run) => run.runId);
  }

  async cancellableRuns(): Promise<ConversationRunControlDescriptor[]> {
    return this.#coordinator.select(
      (facts) => facts.assignment.listCancellableRuns(),
      conversationDecisionScope({}),
    );
  }

  async unsettledAdmittedRuns(): Promise<
    readonly { readonly runId: string; readonly queuedPosition: number }[]
  > {
    return this.#coordinator.select((facts) => {
      const candidateRunIds = new Set<string>();
      for (const entry of facts.queueInput.listQueuedEntriesSnapshot()) {
        candidateRunIds.add(entry.runId);
      }
      if (facts.assignment.activeRunId !== undefined) {
        candidateRunIds.add(facts.assignment.activeRunId);
      }
      for (const assignmentId of facts.assignment.listRecoveryAssignmentIds()) {
        const assigned = facts.assignment.getAssigned(assignmentId);
        if (assigned) candidateRunIds.add(assigned.record.runId);
      }
      const runs: Array<{
        readonly runId: string;
        readonly queuedPosition: number;
      }> = [];
      for (const runId of candidateRunIds) {
        const current = facts.assignment.getRunState(runId)?.state;
        if (
          current !== "queued" &&
          current !== "dispatched" &&
          current !== "running" &&
          current !== "cancel-requested" &&
          current !== "uncertain"
        ) {
          continue;
        }
        const admitted = facts.queueInput.getAdmitted(runId);
        if (!admitted) {
          throw corruptRunJournal(
            "Unsettled conversation run has no durable admission",
          );
        }
        runs.push(
          Object.freeze({
            runId,
            queuedPosition: admitted.record.queuedPosition,
          }),
        );
      }
      runs.sort((left, right) => left.queuedPosition - right.queuedPosition);
      return Object.freeze(runs);
    }, conversationDecisionScope({}));
  }

  async assignmentLifecycleProvenance(assignmentId: string): Promise<
    | {
        readonly conversationId: string;
        readonly runId: string;
        readonly queuedPosition: number;
        readonly executorId: string;
        readonly dispatchDigest: string;
        readonly reservationId: string;
        readonly committed: boolean;
      }
    | undefined
  > {
    assertIdentifier(assignmentId, "Assignment id");
    return this.#coordinator.select((facts) => {
      const assigned = facts.assignment.getAssigned(assignmentId);
      if (!assigned) return undefined;
      const admitted = facts.queueInput.getAdmitted(assigned.record.runId);
      if (!admitted) {
        throw corruptRunJournal("Assigned run has no durable admission");
      }
      return Object.freeze({
        conversationId: this.#conversationId,
        runId: assigned.record.runId,
        queuedPosition: admitted.record.queuedPosition,
        executorId: assigned.record.executorId,
        dispatchDigest: assigned.record.dispatchDigest,
        reservationId: assigned.record.reservation.reservationId,
        committed: facts.commitPublish.hasCommitted(assignmentId),
      });
    }, conversationDecisionScope({ assignmentId }));
  }

  async ownsReservation(reservationId: string): Promise<boolean> {
    assertIdentifier(reservationId, "Reservation id");
    const candidateAssignmentId = reservationId.startsWith("reservation:")
      ? reservationId.slice("reservation:".length)
      : undefined;
    return this.#coordinator.select(
      (facts) => facts.assignment.hasReservationId(reservationId),
      conversationDecisionScope(
        candidateAssignmentId && candidateAssignmentId.length > 0
          ? { assignmentId: candidateAssignmentId }
          : {},
      ),
    );
  }

  async runControlDescriptor(
    runId: string,
  ): Promise<ConversationRunControlDescriptor | undefined> {
    assertIdentifier(runId, "Run id");
    return this.#coordinator.select((facts) => {
      const current = facts.assignment.getRunState(runId)?.state;
      const admitted = facts.queueInput.getAdmitted(runId);
      return current && admitted
        ? {
            runId,
            state: current,
            source: admitted.record.invocation.source,
            ingressId: admitted.record.ingress.ingressId,
          }
        : undefined;
    }, conversationDecisionScope({ runId }));
  }

  async interactionOutcome(
    requestId: string,
  ): Promise<
    { t: "answered"; decisionDigest: string } | { t: "closed" } | undefined
  > {
    assertIdentifier(requestId, "Interaction request id");
    if (this.#coordinator.readBaseGeneration === 0) {
      return readConversationExactValue(
        this.#log,
        this.#conversationId,
        "interactionOutcome",
        requestId,
      );
    }
    return this.#coordinator.select(
      (facts) => facts.commitPublish.findAllowOnceInteractionOutcome(requestId),
      conversationDecisionScope({ requestId }),
    );
  }

  async assignmentSecurityFacts(assignmentId: string): Promise<
    | {
        readonly runId: string;
        readonly environment: import("@zhixing-ai/core/contracts").EnvironmentRequirement;
        readonly permissionSnapshotDigest: string;
      }
    | undefined
  > {
    assertIdentifier(assignmentId, "Assignment id");
    return this.#coordinator.select((facts) => {
      const assigned = facts.assignment.getAssigned(assignmentId);
      if (!assigned?.envelope) return undefined;
      return {
        runId: assigned.record.runId,
        environment: structuredClone(
          assigned.envelope.manifest.environment,
        ) as import("@zhixing-ai/core/contracts").EnvironmentRequirement,
        permissionSnapshotDigest:
          assigned.envelope.permissionLease.snapshotDigest,
      };
    }, conversationDecisionScope({ assignmentId }));
  }

  async trustSedimentMirrored(
    assignmentId: string,
    requestId: string,
  ): Promise<boolean> {
    assertIdentifier(assignmentId, "Assignment id");
    assertIdentifier(requestId, "Trust sediment identity");
    if (this.#coordinator.readBaseGeneration === 0) {
      return (
        (await readConversationExactValue(
          this.#log,
          this.#conversationId,
          "mirrorRequests",
          `${assignmentId}\u0000${requestId}`,
        )) === true
      );
    }
    return this.#coordinator.select(
      (facts) =>
        facts.commitPublish
          .getMirrorState(assignmentId)
          ?.requestIds.has(requestId) ?? false,
      conversationDecisionScope({ assignmentId }),
    );
  }

  async runByIngress(
    ingressId: string,
    source: ConversationInvocation["source"],
  ): Promise<
    { readonly runId: string; readonly state: ConversationRunState } | undefined
  > {
    assertIdentifier(ingressId, "Ingress id");
    if (this.#coordinator.readBaseGeneration === 0) {
      return (
        await this.#log.transactDurableProjection<
          never,
          { runId: string; state: ConversationRunState } | undefined
        >(CONVERSATION_RUN_STATE_PROJECTION_ID, async (view) => {
          const ids = (await readConversationStateField(
            view,
            this.#conversationId,
            "extra-runByIngressIdentity",
            canonicalize([ingressId, source]),
          )) as string[] | undefined;
          if (!ids?.length) return { kind: "return", value: undefined };
          if (ids.length > 1) {
            throw corruptRunJournal(
              "Ingress identity is bound to multiple durable runs",
            );
          }
          const current = (await readConversationStateField(
            view,
            this.#conversationId,
            "stateByRun",
            ids[0]!,
          )) as { state: ConversationRunState } | undefined;
          if (!current) {
            throw corruptRunJournal("Ingress-bound run has no durable state");
          }
          return {
            kind: "return",
            value: { runId: ids[0]!, state: current.state },
          };
        })
      ).value;
    }
    return this.#coordinator.select((facts) => {
      let match:
        | { readonly runId: string; readonly state: ConversationRunState }
        | undefined;
      for (const admitted of facts.queueInput.listAdmittedForIngress(
        ingressId,
        source,
      )) {
        const runId = admitted.record.runId;
        const current = facts.assignment.getRunState(runId)?.state;
        if (!current) {
          throw corruptRunJournal("Ingress-bound run has no durable state");
        }
        if (match && match.runId !== runId) {
          throw corruptRunJournal(
            "Ingress identity is bound to multiple durable runs",
          );
        }
        match = { runId, state: current };
      }
      return match;
    }, conversationDecisionScope({ ingressId, source }));
  }

  async nextAssignmentAttempt(runId: string): Promise<number> {
    assertIdentifier(runId, "Run id");
    return this.#coordinator.select(
      (facts) => facts.assignment.nextAssignmentAttempt(runId),
      conversationDecisionScope({ runId }),
    );
  }

  async isReadyForAssignment(runId: string): Promise<boolean> {
    return (await this.assignmentSchedulingState(runId)).ready;
  }

  async assignmentSchedulingState(
    runId: string,
  ): Promise<{ readonly ready: boolean; readonly blockingRunId?: string }> {
    return this.#coordinator.select(
      (facts) => decideAssignmentSchedulingState({ runId, facts }),
      conversationDecisionScope({ runId }),
    );
  }

  async dispatchesAwaitingStarted(): Promise<PendingConversationDispatch[]> {
    const assigned = await this.#coordinator.select(
      (facts) =>
        facts.assignment.selectActive((candidate, current) =>
          current === "dispatched" &&
          facts.assignment.getSuperseded(candidate.record.assignmentId) ===
            undefined &&
          !facts.assignment.isAssignmentClosed(candidate.record.assignmentId)
            ? snapshot(candidate, "Dispatch awaiting started")
            : undefined,
        ),
      conversationDecisionScope({}),
    );
    return assigned ? [await this.#materializeDispatch(assigned)] : [];
  }

  async acknowledgeDispatch(assignmentId: string): Promise<void> {
    await this.#coordinator.transact<void>(
      (facts) =>
        decideAcknowledgeDispatch({
          conversationId: this.#conversationId,
          assignmentId,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ assignmentId }),
    );
  }

  async issueDataPlaneTicket(
    input: DataPlaneTicketIssueRequest,
  ): Promise<DataPlaneTicket> {
    validateTicketIssueRequest(input);
    const transaction = await this.#coordinator.transact<DataPlaneTicket>(
      (facts, authorityPrefix) =>
        decideIssueDataPlaneTicket({
          conversationId: this.#conversationId,
          request: input,
          issuedAt: authorityPrefix.at,
          signer: this.#signer,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ input }),
    );
    return transaction.value;
  }

  async revokeDataPlaneTicket(ticketId: string): Promise<boolean> {
    assertIdentifier(ticketId, "Revoked ticket id");
    const transaction = await this.#coordinator.transact<boolean>(
      (facts) =>
        decideRevokeDataPlaneTicket({
          conversationId: this.#conversationId,
          ticketId,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ ticketId }),
    );
    return transaction.value;
  }

  async dataPlaneTicketFacts(): Promise<DataPlaneTicketFacts> {
    const transaction = await this.#coordinator.transact<DataPlaneTicketFacts>(
      (facts, authorityPrefix) =>
        decideDataPlaneTicketFacts({
          conversationId: this.#conversationId,
          at: authorityPrefix.at,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({}, { allTickets: true, ticketAt: this.#clock() }),
    );
    return transaction.value;
  }

  async requestSupersede(
    assignmentId: string,
    requestId: string,
  ): Promise<PendingConversationFence["fence"]> {
    assertIdentifier(assignmentId, "Superseded assignment id");
    assertIdentifier(requestId, "Supersede request id");
    const transaction = await this.#coordinator.transact<
      PendingConversationFence["fence"]
    >(
      (facts, authorityPrefix) =>
        decideRequestSupersede({
          conversationId: this.#conversationId,
          assignmentId,
          requestId,
          nextLsn: authorityPrefix.nextLsn,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ assignmentId, requestId }),
    );
    return transaction.value;
  }

  async pendingSupersedes(): Promise<PendingConversationFence[]> {
    const pending = await this.#coordinator.select(
      (facts) =>
        facts.assignment.selectActive((assigned, current) => {
          const request = facts.assignment.getSupersedeRequest(
            assigned.record.assignmentId,
          );
          return request &&
            (current === "dispatched" ||
              current === "cancel-requested" ||
              current === "uncertain") &&
            facts.assignment.getSuperseded(request.assignmentId) ===
              undefined &&
            !facts.assignment.isAssignmentClosed(request.assignmentId) &&
            facts.assignment.getSupersedeStartedObservation(
              request.assignmentId,
            ) === undefined &&
            !facts.assignment.hasRejectedNotStarted(
              request.assignmentId,
              "supersede",
            )
            ? {
                assignmentId: request.assignmentId,
                fence: {
                  fenceSeq: request.fenceSeq,
                  requestId: request.requestId,
                },
              }
            : undefined;
        }),
      conversationDecisionScope({}),
    );
    return pending ? [pending] : [];
  }

  async pendingCancellations(): Promise<PendingConversationFence[]> {
    const pending = await this.#coordinator.select(
      (facts) =>
        facts.assignment.selectActive((assigned, current) => {
          const fence = facts.assignment.getCancelFence(
            assigned.record.assignmentId,
          );
          if (
            !fence ||
            facts.assignment.getSuperseded(fence.assignmentId) !== undefined ||
            facts.assignment.hasRejectedNotStarted(fence.assignmentId, "cancel")
          ) {
            return undefined;
          }
          const open = facts.assignment.getResolution(assigned.record.runId);
          return (current === "cancel-requested" || current === "uncertain") &&
            !(open && facts.assignment.hasContainedFact(open.openFactDigest))
            ? {
                assignmentId: fence.assignmentId,
                fence: { fenceSeq: fence.fenceSeq, requestId: fence.requestId },
              }
            : undefined;
        }),
      conversationDecisionScope({}),
    );
    return pending ? [pending] : [];
  }

  async cancelRun(
    input: ConversationCancelRequest,
  ): Promise<ConversationCancelResult> {
    assertIdentifier(input.runId, "Cancelled run id");
    assertIdentifier(input.requestId, "Cancellation request id");
    const transaction =
      await this.#coordinator.transact<ConversationCancelResult>(
        (facts, authorityPrefix) => {
          const queuedTerminalRecords =
            facts.assignment.getRunState(input.runId)?.state === "queued"
              ? facts.assignment.prepareQueuedTerminalRecords(
                  this.#resources,
                  input.runId,
                  "cancelled",
                )
              : [];
          return decideConversationCancel({
            conversationId: this.#conversationId,
            request: input,
            nextLsn: authorityPrefix.nextLsn,
            queuedTerminalRecords,
            facts,
          });
        },
        [],
        [],
        conversationDecisionScope({ input }),
      );
    return transaction.value;
  }

  async applyControl(input: {
    readonly admission: ControlAdmissionJournal;
    readonly envelope: ConversationControlEnvelope;
    readonly source: TrustedControlSource;
  }): Promise<ControlAdmissionOutcome> {
    const cancelRunId =
      input.envelope.body.t === "cancel"
        ? input.envelope.body.runId
        : undefined;
    const pendingWorkspaceControl =
      cancelRunId === undefined
        ? undefined
        : await this.#coordinator.select(
            (facts) =>
              facts.session.getWorksceneControl(cancelRunId)?.record as
                | TranscriptRunRecord
                | undefined,
            conversationDecisionScope({ runId: cancelRunId }, { workscene: true }),
          );
    await input.admission.prepareRecovery();
    const applyAuthority = (
      basis: { state: RunProjection; cursor: ProjectionCursor } | undefined,
      onProjected: (state: RunProjection, cursor: ProjectionCursor) => void,
    ) =>
      input.admission.applyAuthority<RunProjection, ConversationControlEnvelope>({
        envelope: input.envelope,
        source: input.source,
        stream: runStream(this.#conversationId),
        initial: emptyConversationRunProjection(this.#conversationId),
        ...(basis ? { targetBase: basis } : {}),
        readProjectionIds: this.#coordinator.deliveryProjectionIds(),
        onProjected,
        reducer: (state, record, commit) =>
          this.#coordinator.reduceRunProjection(
            state,
            record as LogicalRecord<ConversationCommitLogRecord>,
            commit as CommitEnvelope<ConversationCommitLogRecord>,
          ),
        companionStreams: this.#delivery
          ? ["delivery", "governor"]
          : ["governor"],
        prepareCompanions: async (state, context, plan) => {
          const statuses = conversationStatusDeliveryInputs(
            this.#conversationId,
            state,
            plan.authorityEntries ?? [],
            context.authorityPrefix.at,
          );
          const prepared =
            (await this.#delivery?.prepareConversationStatuses(
              statuses,
              context.authorityPrefix,
              plan.authorityEntries ?? [],
            )) ?? {
              accepted: true as const,
              records: [],
              stagedRevisions: new Map(),
              stagedConflicts: new Map(),
            };
          if (!prepared.accepted) {
            throw corruptRunJournal(prepared.error.message);
          }
          const controlResponses = conversationControlResponseDeliveryInputs(
            this.#conversationId,
            context.envelope,
            plan,
            context.canonicalRequestId,
            context.authorityPrefix.at,
          );
          const resourceRecords =
            this.#coordinator.prepareResourceTerminalRecords(
              state,
              plan.authorityEntries ?? [],
            );
          if (controlResponses.length === 0) {
            return [...resourceRecords, ...prepared.records];
          }
          const preparedResponses =
            (await this.#delivery?.prepareConversationControlResponses(
              controlResponses,
              context.authorityPrefix,
              [...(plan.authorityEntries ?? []), ...prepared.records],
            )) ?? {
              accepted: true as const,
              records: [],
              stagedRevisions: new Map(),
              stagedConflicts: new Map(),
            };
          if (!preparedResponses.accepted) {
            throw corruptRunJournal(preparedResponses.error.message);
          }
          return [
            ...resourceRecords,
            ...prepared.records,
            ...preparedResponses.records,
          ];
        },
        onCommitted: (state, commit) => {
          this.#publishStatusNotices(
            conversationStatusNoticesForCommit(
              readConversationDecisionFacts(state).assignment,
              commit,
              this.#conversationId,
              this.#ownerEpoch,
            ),
          );
        },
        decide: (state, context) =>
          decideControlEnvelope({
            conversationId: this.#conversationId,
            ownerEpoch: this.#ownerEpoch,
            envelope: context.envelope,
            canonicalRequestId: context.canonicalRequestId,
            authorityAt: context.authorityPrefix.at,
            nextLsn: context.authorityPrefix.nextLsn,
            pendingWorkspaceControl,
            resources: this.#resources,
            facts: readConversationDecisionFacts(state),
          }),
      });
    return this.#coordinator.withRunProjection(
      (basis, publish) => {
        const application = () => applyAuthority(basis, publish);
        const apply = () =>
          this.#delivery
            ? this.#delivery.coordinate(application)
            : application();
        return this.#resources
          ? this.#resources.coordinate(apply, {
              caller: "conversation-journal.control",
            })
          : apply();
      },
      conversationDecisionScope({ input }),
    );
  }

  async closeQueuedRun(
    runId: string,
    outcome: "failed" | "expired",
  ): Promise<void> {
    assertIdentifier(runId, "Queued run id");
    if (outcome !== "failed" && outcome !== "expired") {
      throw new TypeError("Queued run outcome is invalid");
    }
    await this.#coordinator.transact<void>(
      (facts) =>
        decideCloseQueuedRun({
          conversationId: this.#conversationId,
          runId,
          outcome,
          resources: this.#resources,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ runId, outcome }),
    );
  }

  async failAssignedRun(
    runId: string,
    assignmentId: string,
    reason?: string,
    usageFinal?: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): Promise<void> {
    assertIdentifier(runId, "Failed run id");
    assertIdentifier(assignmentId, "Failed assignment id");
    const boundedReason =
      reason === undefined ? undefined : truncateUtf8(reason, 512);
    await this.#coordinator.transact<void>(
      (facts) =>
        decideFailAssignedRun({
          conversationId: this.#conversationId,
          runId,
          assignmentId,
          boundedReason,
          usageFinal,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ runId, assignmentId, reason, usageFinal }),
    );
  }

  async assignmentsAwaitingRecovery(): Promise<
    Array<{
      readonly assignmentId: string;
      readonly state:
        | "dispatched"
        | "running"
        | "cancel-requested"
        | "uncertain"
        | "committed";
      readonly dispatch: PendingConversationDispatch;
    }>
  > {
    type RecoveryCandidate = {
      readonly assignmentId: string;
      readonly state:
        | "dispatched"
        | "running"
        | "cancel-requested"
        | "uncertain"
        | "committed";
      readonly assigned: AssignedProjection | ReadonlyAssignedFact;
    };
    const candidates: RecoveryCandidate[] =
      this.#coordinator.readBaseGeneration === 0 &&
      !this.#coordinator.importedBaseSource
        ? await this.#coordinator.readCurrentIndexed((view) =>
            readIndexedRecoveryAssignments(view, this.#conversationId),
          )
        : await this.#coordinator.select(
            (facts): RecoveryCandidate[] => {
              const outbox = new Set(
                facts.commitPublish.listBundleAcknowledgementOutbox(),
              );
              return [
                ...new Set([
                  ...facts.assignment.listRecoveryAssignmentIds(),
                  ...outbox,
                ]),
              ].flatMap<RecoveryCandidate>((assignmentId) => {
                const assigned = facts.assignment.getAssigned(assignmentId);
                if (!assigned) {
                  throw corruptRunJournal(
                    "Recovery outbox names an unknown assignment",
                  );
                }
                const current = facts.assignment.getRunState(
                  assigned.record.runId,
                )?.state;
                const committed =
                  facts.commitPublish.getCommitted(assignmentId);
                if (outbox.has(assignmentId)) {
                  if (
                    current !== "committed" ||
                    committed?.runId !== assigned.record.runId ||
                    facts.commitPublish.hasBundleAcknowledgement(assignmentId)
                  ) {
                    throw corruptRunJournal(
                      "Bundle acknowledgement outbox does not bind one pending committed assignment",
                    );
                  }
                  return [
                    {
                      assignmentId,
                      state: current,
                      assigned: snapshot(
                        assigned,
                        "Recoverable committed assignment",
                      ),
                    },
                  ];
                }
                const isCurrent =
                  facts.assignment.getAssignmentIdForRun(
                    assigned.record.runId,
                  ) === assignmentId;
                if (
                  !isCurrent ||
                  facts.assignment.getSuperseded(assignmentId) !== undefined ||
                  facts.assignment.isAssignmentClosed(assignmentId) ||
                  facts.assignment.hasRejectedNotStarted(
                    assignmentId,
                    "cancel",
                  ) ||
                  facts.assignment.hasRejectedNotStarted(
                    assignmentId,
                    "dispatch-rejection",
                  ) ||
                  (current !== "dispatched" &&
                    current !== "running" &&
                    current !== "cancel-requested" &&
                    current !== "uncertain")
                ) {
                  return [];
                }
                const open = facts.assignment.getResolution(
                  assigned.record.runId,
                );
                if (
                  open &&
                  facts.assignment.hasContainedFact(open.openFactDigest)
                ) {
                  return [];
                }
                return [
                  {
                    assignmentId,
                    state: current,
                    assigned: snapshot(assigned, "Recoverable assignment"),
                  },
                ];
              });
            },
            conversationDecisionScope({}),
          );
    return Promise.all(
      candidates.map(async ({ assigned, ...candidate }) => ({
        ...candidate,
        dispatch: await this.#materializeDispatch(assigned),
      })),
    );
  }

  async observeBundleAcknowledgement(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const ledger = await verifyProtocolStep(() =>
      validateLedgerSnapshot(rawSnapshot, this.#verifier),
    );
    if (
      ledger.assignmentId !== assignmentId ||
      ledger.phase !== "acked" ||
      ledger.sealedBundleRef === undefined ||
      ledger.acknowledgedCommitRevision === undefined
    ) {
      throw new TypeError(
        "Ledger snapshot does not prove acknowledgement of the committed conversation bundle",
      );
    }
    const preflight = await this.#coordinator.select(
      (facts) =>
        decideObserveBundleAcknowledgementPreflight({
          assignmentId,
          facts,
        }),
      conversationDecisionScope({ assignmentId, rawSnapshot }),
    );
    assertLedgerAcknowledgesCommittedConversationBundle(
      ledger,
      preflight.expected,
    );
    if (preflight.existing) {
      if (
        canonicalize(preflight.existing) !== canonicalize(preflight.expected)
      ) {
        throw corruptRunJournal(
          "Bundle acknowledgement observation is inconsistent",
        );
      }
      return;
    }
    await this.#coordinator.transact<void>(
      (facts) =>
        decideObserveBundleAcknowledgementAtState({
          conversationId: this.#conversationId,
          assignmentId,
          ledger,
          preflightExpected: preflight.expected,
          facts,
        }),
      [preflight.expected.bundleRef],
      [],
      conversationDecisionScope({ assignmentId, rawSnapshot }),
    );
  }

  async markAssignmentUncertain(
    assignmentId: string,
    cause: "ledger-unknown" | "cancel-unproven",
  ): Promise<UncertainResolutionFact> {
    assertIdentifier(assignmentId, "Uncertain assignment id");
    const openedAt = this.#clock();
    const transaction =
      await this.#coordinator.transact<UncertainResolutionFact>(
        (facts) =>
          decideMarkAssignmentUncertain({
            conversationId: this.#conversationId,
            assignmentId,
            cause,
            openedAt,
            facts,
          }),
        [],
        [],
        conversationDecisionScope({ assignmentId, cause }),
      );
    return transaction.value;
  }

  async validateExecutorDispatchResult(input: unknown): Promise<DispatchResult> {
    return verifyProtocolStep(() =>
      validateDispatchResult(input, this.#verifier),
    );
  }

  async validateExecutorLedgerSnapshot(input: unknown): Promise<LedgerSnapshot> {
    return verifyProtocolStep(() =>
      validateLedgerSnapshot(input, this.#verifier),
    );
  }

  async reconcileCancellationEvidence(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
    pages: AsyncIterable<LedgerEvidencePage>,
  ): Promise<boolean> {
    assertIdentifier(assignmentId, "Recovered assignment id");
    const snapshotValue = await verifyProtocolStep(() =>
      validateLedgerSnapshot(rawSnapshot, this.#verifier),
    );
    if (
      snapshotValue.assignmentId !== assignmentId ||
      snapshotValue.lastSeq <= 0 ||
      snapshotValue.cancelProof !== undefined ||
      snapshotValue.sealedBundleRef !== undefined ||
      snapshotValue.phase === "halted" ||
      snapshotValue.phase === "failed" ||
      snapshotValue.phase === "sealed" ||
      snapshotValue.phase === "acked"
    ) {
      throw new TypeError(
        "Ledger snapshot is not an unresolved cancellation prefix",
      );
    }

    const current = await this.#coordinator.select((facts) => {
      const assigned = facts.assignment.getAssigned(assignmentId);
      return assigned
        ? {
            assigned: snapshot(assigned, "Ledger evidence assignment"),
            runState: facts.assignment.getRunState(assigned.record.runId)
              ?.state,
            isCurrent:
              facts.assignment.getAssignmentIdForRun(assigned.record.runId) ===
              assignmentId,
          }
        : undefined;
    }, conversationDecisionScope({ assignmentId, rawSnapshot, pages }, { hydrate: true }));
    if (!current) {
      throw new Error("Ledger evidence names an unknown assignment");
    }
    const { assigned, runState, isCurrent } = current;
    if (!isCurrent) {
      throw new Error("Ledger evidence belongs to a historical assignment");
    }
    if (runState === "uncertain") return false;
    if (
      runState !== "dispatched" &&
      runState !== "running" &&
      runState !== "cancel-requested"
    ) {
      throw new Error("Ledger evidence is late for the current run state");
    }

    let expectedSeq = 1;
    const validation = createAssignmentLedgerValidationState(assignmentId);
    for await (const rawPage of pages) {
      const page = await verifyProtocolStep(() =>
        validateLedgerEvidencePage(rawPage, this.#verifier),
      );
      if (
        page.assignmentId !== assignmentId ||
        page.executorId !== assigned.record.executorId ||
        page.fromSeq !== expectedSeq ||
        page.toSeq > snapshotValue.lastSeq
      ) {
        throw new TypeError(
          "Ledger evidence page does not bind the frozen assignment prefix",
        );
      }
      for (const rawEntry of page.entries) {
        let body: AssignmentRecord;
        if ("ref" in rawEntry.body) {
          const bytes = await this.#artifacts.get(rawEntry.body.ref);
          const text = Buffer.from(bytes).toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            throw new TypeError("Ledger evidence artifact is not valid JSON", {
              cause: error,
            });
          }
          if (canonicalize(parsed) !== text) {
            throw new TypeError("Ledger evidence artifact is not canonical");
          }
          body = (
            await verifyProtocolStep(() =>
              validateAssignmentEntry(
                { recordSeq: rawEntry.recordSeq, body: parsed },
                this.#verifier,
              ),
            )
          ).body;
        } else {
          body = (
            await verifyProtocolStep(() =>
              validateAssignmentEntry(rawEntry, this.#verifier),
            )
          ).body;
        }
        const entry: AssignmentEntry = { recordSeq: rawEntry.recordSeq, body };
        if (
          body.t === "control-lease-renewed" &&
          !controlLeaseBindsDispatchEnvelope(
            body.lease,
            requireAssignedEnvelope(assigned),
          )
        ) {
          throw new TypeError(
            "Control lease evidence does not bind the durable assignment",
          );
        }
        if (body.t === "received") {
          const activation = await verifyProtocolStep(() =>
            validateConversationActivation({
              envelope: requireAssignedEnvelope(assigned),
              activation: body.activation as AssignmentActivationProof<"conversation">,
              dispatchRef: assigned.record.dispatchRef as ArtifactRef,
              verifier: this.#verifier,
            }),
          );
          const expectedActivation = buildConversationActivationPayload({
            envelope: requireAssignedEnvelope(assigned),
            dispatchRef: assigned.record.dispatchRef as ArtifactRef,
            commit: {
              lsn: requireLocalAssignedCommit(assigned).lsn,
              envelopeDigest:
                requireLocalAssignedCommit(assigned).envelopeDigest,
            },
            issuedAt: requireLocalAssignedCommit(assigned).at,
          });
          if (
            canonicalize(body.envelope.ref) !==
              canonicalize(assigned.record.dispatchRef) ||
            canonicalize(activation) !== canonicalize(expectedActivation)
          ) {
            throw new TypeError(
              "Received ledger evidence does not bind the durable assignment",
            );
          }
        }
        applyValidatedAssignmentEntry(validation, entry);
        expectedSeq += 1;
      }
      if (page.chainDigest !== validation.chainDigest) {
        throw new TypeError("Ledger evidence page chain digest is invalid");
      }
    }
    if (
      expectedSeq !== snapshotValue.lastSeq + 1 ||
      validation.lastSeq !== snapshotValue.lastSeq ||
      validation.phase !== snapshotValue.phase
    ) {
      throw new TypeError(
        "Ledger evidence does not close the frozen snapshot prefix",
      );
    }
    if (validation.aborts.size === 0) return false;
    await this.markAssignmentUncertain(assignmentId, "cancel-unproven");
    return true;
  }

  async recordDispatchConflict(
    sent: PendingConversationDispatch,
    result: Extract<
      DispatchResult,
      { accepted: false; outcome: "conflicting-redelivery" }
    >,
  ): Promise<"acked-original" | "opened-uncertain"> {
    const validatedResult = await verifyProtocolStep(() =>
      validateDispatchResult(result, this.#verifier),
    );
    if (
      validatedResult.accepted ||
      validatedResult.outcome !== "conflicting-redelivery"
    ) {
      throw new TypeError("Expected a conflicting dispatch result");
    }
    const proof = await verifyProtocolStep(() =>
      validateDispatchConflictProof(validatedResult.proof, this.#verifier),
    );
    const sentDispatchRef = dispatchEnvelopeArtifact(sent.envelope).ref;
    const sentActivationDigest = assignmentActivationDigest(
      withoutSignature(sent.activation),
    );
    if (
      proof.assignmentId !== sent.assignmentId ||
      canonicalize(proof.conflictingDispatchRef) !==
        canonicalize(sentDispatchRef) ||
      proof.conflictingActivationDigest !== sentActivationDigest
    ) {
      throw new TypeError(
        "Dispatch conflict proof does not bind the attempted dispatch",
      );
    }
    const expectedAssigned = await this.#coordinator.select((facts) => {
      const assigned = facts.assignment.getAssigned(sent.assignmentId);
      return assigned
        ? snapshot(assigned, "Expected assigned dispatch")
        : undefined;
    }, conversationDecisionScope({ sent, result }, { hydrate: true }));
    if (!expectedAssigned) {
      throw new Error("Dispatch conflict names an unknown assignment");
    }
    const expected = await this.#materializeDispatch(expectedAssigned);
    const expectedDispatchRef = dispatchEnvelopeArtifact(expected.envelope).ref;
    const expectedActivationDigest = assignmentActivationDigest(
      withoutSignature(expected.activation),
    );
    const acceptedMatches =
      canonicalize(proof.acceptedDispatchRef) ===
        canonicalize(expectedDispatchRef) &&
      proof.acceptedActivationDigest === expectedActivationDigest;
    const openedAt = this.#clock();
    const transaction = await this.#coordinator.transact<
      "acked-original" | "opened-uncertain"
    >(
      (facts, authorityPrefix) =>
        decideRecordDispatchConflict({
          conversationId: this.#conversationId,
          assignmentId: sent.assignmentId,
          proof,
          acceptedMatches,
          openedAt,
          nextLsn: authorityPrefix.nextLsn,
          facts,
        }),
      [proof.acceptedDispatchRef, proof.conflictingDispatchRef],
      [],
      conversationDecisionScope({ sent, result }, { hydrate: true }),
    );
    return transaction.value;
  }

  async acceptDispatchRejection(
    response: Extract<
      DispatchResult,
      { accepted: false; outcome: "rejected-before-received" }
    >,
  ): Promise<void> {
    const validatedResult = await verifyProtocolStep(() =>
      validateDispatchResult(response, this.#verifier),
    );
    if (
      validatedResult.accepted ||
      validatedResult.outcome !== "rejected-before-received"
    ) {
      throw new TypeError(
        "Expected a rejected-before-received dispatch result",
      );
    }
    const proof = await verifyProtocolStep(() =>
      validateDispatchRejectionProof(validatedResult.proof, this.#verifier),
    );
    await this.#acceptNotStartedTermination(proof);
  }

  async acceptSupersedeProof(rawProof: SupersedeProof): Promise<void> {
    const proof = await verifyProtocolStep(() =>
      validateSupersedeProof(rawProof, this.#verifier),
    );
    if (proof.decision === "not-started-fenced") {
      await this.#acceptNotStartedTermination(proof);
      return;
    }
    await this.#coordinator.transact<void>(
      (facts) =>
        decideAcceptSupersedeAlreadyStarted({
          conversationId: this.#conversationId,
          proof,
          legacyAbortTickets: this.#legacyAbortTickets,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ rawProof }),
    );
  }

  async preflightSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<AssignmentSubmissionPreflightResult> {
    this.#authenticateSubmission(context, identity);
    const guard = await this.#loadSubmissionGuardFacts(context, identity);
    if (identity.method !== "submission.submitBundle") {
      return { kind: "continue" };
    }
    const assigned = guard.assignment.getAssigned(identity.assignmentId);
    if (!assigned) {
      throw new Error(
        "Bundle capability is not activated by a durable assignment",
      );
    }
    if (!guard.queueInput.getAdmitted(assigned.record.runId)?.ingress) {
      throw new Error("Bundle assignment has no durable ingress");
    }
    if (guard.commitPublish.getCommitted(identity.assignmentId)) {
      return { kind: "continue" };
    }
    const rejectionMessage = decideGuardBundleRejection({
      hasCurrentEpoch: this.#hasCurrentSubmissionAuthorityEpoch(context),
      assignmentId: identity.assignmentId,
      runId: assigned.record.runId,
      guard,
    });
    if (!rejectionMessage) return { kind: "continue" };
    await verifyProtocolStep(() =>
      this.#authorizeGuardSubmission(guard, context, {
        mode: "durable-rejection",
        method: "submission.submitBundle",
        assignmentId: identity.assignmentId,
      }),
    );
    return {
      kind: "return",
      result: rejected("fence-rejected", rejectionMessage, false),
    };
  }

  async reportStarted(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<void> {
    this.#authenticateSubmission(ctx, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#loadSubmissionGuardFacts(ctx, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#coordinator.transact<void>(
      (facts) => {
        this.#assertActivatedSubmissionCapability(facts, ctx, {
          method: "submission.reportStarted",
          assignmentId,
        });
        return decideReportStarted({
          conversationId: this.#conversationId,
          assignmentId,
          authorizeReplay: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "durable-replay",
              method: "submission.reportStarted",
              assignmentId,
            }),
          authorizeActive: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "active",
              method: "submission.reportStarted",
              assignmentId,
            }),
          facts,
        });
      },
      [],
      [],
      this.#coordinator.exactCommandScope({ assignmentId, ctx }),
    );
  }

  async reconcileStarted(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const snapshotValue = await verifyProtocolStep(() =>
      validateLedgerSnapshot(rawSnapshot, this.#verifier),
    );
    if (
      snapshotValue.assignmentId !== assignmentId ||
      (snapshotValue.phase !== "started" &&
        snapshotValue.phase !== "sealed" &&
        snapshotValue.phase !== "acked")
    ) {
      throw new TypeError(
        "Ledger snapshot does not prove that the assignment started",
      );
    }
    await this.#coordinator.transact<void>(
      (facts) =>
        decideReconcileStarted({
          conversationId: this.#conversationId,
          assignmentId,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ assignmentId, rawSnapshot }),
    );
  }

  async mirrorInteractions(
    assignmentId: string,
    rawBatch: ConversationInteractionMirrorBatch,
    ctx: AuthorityCallContext,
  ): Promise<{
    readonly mirroredUpTo: number;
    readonly ordinal: number;
    readonly mirrorDigest: string;
  }> {
    this.#authenticateSubmission(ctx, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    await this.#loadSubmissionGuardFacts(ctx, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    if (
      Buffer.byteLength(
        canonicalize({ t: "interaction-mirror", assignmentId, batch: rawBatch }),
        "utf8",
      ) > MAX_INLINE_LOGICAL_RECORD_BYTES
    ) {
      throw new TypeError(
        "Interaction mirror batch exceeds the durable record limit",
      );
    }
    const batch = await verifyProtocolStep(() =>
      validateConversationInteractionMirrorBatch(rawBatch, this.#verifier),
    );
    if (batch.assignmentId !== assignmentId) {
      throw new TypeError(
        "Interaction mirror batch names a different assignment",
      );
    }
    const batchDigest = interactionMirrorBatchDigest(batch);
    return this.#mirrorQueue.run(assignmentId, () =>
      this.#commitInteractionMirror(
        assignmentId,
        rawBatch,
        batch,
        batchDigest,
        ctx,
      ),
    );
  }

  async #commitInteractionMirror(
    assignmentId: string,
    rawBatch: ConversationInteractionMirrorBatch,
    batch: ConversationInteractionMirrorBatch,
    batchDigest: string,
    ctx: AuthorityCallContext,
  ): Promise<{
    readonly mirroredUpTo: number;
    readonly ordinal: number;
    readonly mirrorDigest: string;
  }> {
    const sediments = this.#trustSediments
      ? batch.entries.filter(
          (entry): entry is TrustSedimentMirrorEntry =>
            entry.kind === "trust-sediment",
        )
      : [];
    const hits = this.#trustRuleHits
      ? batch.entries.filter(
          (entry): entry is TrustRuleHitMirrorEntry =>
            entry.kind === "trust-rule-hit",
        )
      : [];
    if (sediments.length > 0) {
      await prepareTrustSedimentsForMirrorBatch({
        conversationId: this.#conversationId,
        assignmentId,
        batch,
        batchDigest,
        sediments,
        trustSediments: this.#trustSediments,
        selectAssigned: () =>
          this.#coordinator.select((facts) => {
            const current = facts.assignment.getAssigned(assignmentId);
            if (
              !current?.envelope ||
              facts.commitPublish.hasMirrorBatch(batchDigest)
            ) {
              return undefined;
            }
            return {
              executorId: current.record.executorId,
              environment: structuredClone(
                current.envelope.manifest.environment,
              ) as import("@zhixing-ai/core/contracts").EnvironmentRequirement,
            };
          }, conversationDecisionScope({ assignmentId, batch })),
        interactionOutcome: (requestId) => this.interactionOutcome(requestId),
      });
    }
    const hitSession = await prepareTrustRuleHitMirrorSession({
      conversationId: this.#conversationId,
      assignmentId,
      batch,
      batchDigest,
      hits,
      trustRuleHits: this.#trustRuleHits,
      selectPrecheck: () =>
        this.#coordinator.select(
          (facts) =>
            decideTrustRuleHitPrecheck({
              assignmentId,
              batch,
              batchDigest,
              facts,
            }),
          conversationDecisionScope({ assignmentId, batch }),
        ),
      selectBatchCommitted: () =>
        this.#coordinator.select(
          (facts) => facts.commitPublish.hasMirrorBatch(batchDigest),
          conversationDecisionScope(
            { assignmentId },
            { mirrorDigests: [batchDigest] },
          ),
        ),
    });
    const transaction = await this.#coordinator
      .transact<{
        mirroredUpTo: number;
        ordinal: number;
        mirrorDigest: string;
      }>(
        (facts) => {
          this.#assertActivatedSubmissionCapability(facts, ctx, {
            method: "submission.mirrorInteractions",
            assignmentId,
          });
          return decideInteractionMirror({
            conversationId: this.#conversationId,
            assignmentId,
            batch,
            batchDigest,
            authorizeReplay: () =>
              this.#authorizeSubmission(facts, ctx, {
                mode: "durable-replay",
                method: "submission.mirrorInteractions",
                assignmentId,
              }),
            authorizeCommit: (mode) =>
              this.#authorizeSubmission(facts, ctx, {
                mode,
                method: "submission.mirrorInteractions",
                assignmentId,
              }),
            facts,
          });
        },
        [],
        [],
        conversationDecisionScope({ assignmentId, rawBatch, ctx }),
      )
      .catch(async (error: unknown) => {
        await hitSession.settleAfterError();
        throw error;
      });
    for (const entry of sediments) {
      await this.#trustSediments!
        .accept({
          conversationId: this.#conversationId,
          assignmentId,
          entry,
        })
        .catch(() => undefined);
    }
    if (hitSession.target) await hitSession.acceptCommitted();
    return transaction.value;
  }

  async trustRuleHitBatchState(
    assignmentId: string,
    batchDigest: string,
  ): Promise<TrustRuleHitBatchState> {
    assertIdentifier(assignmentId, "Assignment id");
    if (
      typeof batchDigest !== "string" ||
      batchDigest.length === 0 ||
      batchDigest.length > 256
    ) {
      throw new TypeError("Interaction mirror batch digest is invalid");
    }
    return this.#coordinator.select(
      (facts) =>
        decideTrustRuleHitBatchState({
          assignmentId,
          batchDigest,
          facts,
        }),
      conversationDecisionScope({ assignmentId }, { mirrorDigests: [batchDigest] }),
    );
  }

  async submitCancelProof(
    assignmentId: string,
    rawProof: CancelProofBody,
    ctx: AuthorityCallContext,
  ): Promise<void> {
    assertIdentifier(assignmentId, "Cancelled assignment id");
    this.#authenticateSubmission(ctx, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    await this.#loadSubmissionGuardFacts(ctx, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    const proof = await verifyProtocolStep(() =>
      validateCancelProof(rawProof, this.#verifier),
    );
    if (proof.assignmentId !== assignmentId) {
      throw new TypeError("Cancel proof names a different assignment");
    }
    const at = this.#clock();
    await this.#coordinator.transact<void>(
      (facts) => {
        this.#assertActivatedSubmissionCapability(facts, ctx, {
          method: "submission.submitCancelProof",
          assignmentId,
        });
        return decideSubmitCancelProof({
          conversationId: this.#conversationId,
          assignmentId,
          proof,
          at,
          legacyAbortTickets: this.#legacyAbortTickets,
          authorizeReplay: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "durable-replay",
              method: "submission.submitCancelProof",
              assignmentId,
            }),
          authorizeSettlement: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "settlement",
              method: "submission.submitCancelProof",
              assignmentId,
            }),
          assertResourceUsageFinal: (assigned, usage) =>
            this.#coordinator.assertResourceUsageFinal(assigned, usage),
          facts,
        });
      },
      [],
      [],
      conversationDecisionScope({ assignmentId, rawProof, ctx }),
    );
  }

  async submitBundle(
    rawBundle: SealedBundle,
    ctx: AuthorityCallContext,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | {
        readonly committed: false;
        readonly error: AuthorityError;
      }
  > {
    if (ctx.principal.kind !== "assignment") {
      throw new Error("Bundle submission requires an assignment capability");
    }
    const assignmentId = ctx.principal.capability.assignmentId;
    this.#authenticateSubmission(ctx, {
      method: "submission.submitBundle",
      assignmentId,
    });
    const guard = await this.#loadSubmissionGuardFacts(ctx, {
      method: "submission.submitBundle",
      assignmentId,
    });
    const guardAssigned = guard.assignment.getAssigned(assignmentId);
    if (!guardAssigned) {
      throw new Error(
        "Bundle capability is not activated by a durable assignment",
      );
    }
    const guardIngress = guard.queueInput.getAdmitted(
      guardAssigned.record.runId,
    )?.ingress;
    if (!guardIngress) {
      throw new Error("Bundle assignment has no durable ingress");
    }
    const guardCommitted = guard.commitPublish.getCommitted(assignmentId);
    if (!guardCommitted) {
      const guardState = guard.assignment.getRunState(
        guardAssigned.record.runId,
      )?.state;
      const rejectionMessage = decideGuardBundleRejection({
        hasCurrentEpoch: this.#hasCurrentSubmissionAuthorityEpoch(contextFor(ctx)),
        assignmentId,
        runId: guardAssigned.record.runId,
        guard,
      });
      if (rejectionMessage) {
        await verifyProtocolStep(() =>
          this.#authorizeGuardSubmission(guard, ctx, {
            mode: "durable-rejection",
            method: "submission.submitBundle",
            assignmentId,
          }),
        );
        return rejected("fence-rejected", rejectionMessage, false);
      }
      await verifyProtocolStep(() =>
        this.#authorizeGuardSubmission(guard, ctx, {
          mode: guardState === "uncertain" ? "settlement" : "active",
          method: "submission.submitBundle",
          assignmentId,
        }),
      );
    }

    let bundle: ReturnType<typeof validateConversationSealedBundle>;
    try {
      bundle = validateConversationSealedBundle(rawBundle);
    } catch (error) {
      return rejected(
        "invalid",
        error instanceof Error ? error.message : "Invalid bundle",
        false,
      );
    }
    if (bundle.assignmentId !== assignmentId) {
      return rejected(
        "fence-rejected",
        "Bundle does not bind the authenticated assignment",
        false,
      );
    }
    const artifact = sealedBundleArtifact(bundle);
    if (guardCommitted) {
      const fastPath = decideSubmitBundleGuardCommittedFastPath({
        conversationId: this.#conversationId,
        assignmentId,
        bundle,
        artifactRef: artifact.ref,
        capability: ctx.principal.capability,
        guard,
      });
      if (fastPath.kind === "mismatch-bundle") {
        await verifyProtocolStep(() =>
          this.#authorizeGuardSubmission(guard, ctx, {
            mode: "active",
            method: "submission.submitBundle",
            assignmentId,
          }),
        );
        return fastPath.result;
      }
      await verifyProtocolStep(() =>
        this.#authorizeGuardSubmission(guard, ctx, {
          mode: "durable-replay",
          method: "submission.submitBundle",
          assignmentId,
        }),
      );
      await this.#coordinator.withPreparedState(() =>
        this.#coordinator.assertResourceUsageFinal(
          fastPath.assigned,
          bundle.usageFinal,
        ),
      );
      return { committed: true, commitRevision: fastPath.commitRevision };
    }

    const preflight = await this.#coordinator.select(
      (facts) => {
        this.#assertActivatedSubmissionCapability(facts, ctx, {
          method: "submission.submitBundle",
          assignmentId,
        });
        return decideSubmitBundleSelectPreflight({
          assignmentId,
          artifactRef: artifact.ref,
          authorizeActive: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "active",
              method: "submission.submitBundle",
              assignmentId,
            }),
          authorizeReplay: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "durable-replay",
              method: "submission.submitBundle",
              assignmentId,
            }),
          authorizeRejection: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "durable-rejection",
              method: "submission.submitBundle",
              assignmentId,
            }),
          authorizeSettlement: () =>
            this.#authorizeSubmission(facts, ctx, {
              mode: "settlement",
              method: "submission.submitBundle",
              assignmentId,
            }),
          facts,
        });
      },
      conversationDecisionScope({ rawBundle, ctx }, { hydrate: true }),
    );
    if (preflight.kind === "return") return preflight.value;

    const preparedStage = await prepareConversationBundleSubmission({
      conversationId: this.#conversationId,
      ownerEpoch: this.#ownerEpoch,
      bundle,
      artifactRef: artifact.ref,
      preflightAssigned: preflight.assigned,
      guardIngress: guardIngress as IngressContext,
      artifacts: this.#artifacts,
      publisher: this.#publisher,
    });
    if (preparedStage.kind === "rejected") return preparedStage.result;
    const prepared = preparedStage.prepared;

    let appendedGlobalRecords: readonly PreparedConversationGlobalRecord[] = [];
    const transaction = await this.#coordinator
      .transact<
        | { readonly committed: true; readonly commitRevision: number }
        | {
            readonly committed: false;
            readonly error: AuthorityError;
          }
      >(
        async (facts, authorityPrefix) => {
          appendedGlobalRecords = [];
          this.#assertActivatedSubmissionCapability(facts, ctx, {
            method: "submission.submitBundle",
            assignmentId,
          });
          const preflightAtState = decideSubmitBundlePreflightAtState({
            conversationId: this.#conversationId,
            ownerEpoch: this.#ownerEpoch,
            bundle,
            artifactRef: artifact.ref,
            committedRunRecord: prepared.committedRunRecord,
            authorizeActive: () =>
              this.#authorizeSubmission(facts, ctx, {
                mode: "active",
                method: "submission.submitBundle",
                assignmentId: bundle.assignmentId,
              }),
            authorizeReplay: () =>
              this.#authorizeSubmission(facts, ctx, {
                mode: "durable-replay",
                method: "submission.submitBundle",
                assignmentId: bundle.assignmentId,
              }),
            authorizeRejection: () =>
              this.#authorizeSubmission(facts, ctx, {
                mode: "durable-rejection",
                method: "submission.submitBundle",
                assignmentId: bundle.assignmentId,
              }),
            authorizeSettlement: () =>
              this.#authorizeSubmission(facts, ctx, {
                mode: "settlement",
                method: "submission.submitBundle",
                assignmentId: bundle.assignmentId,
              }),
            assertResourceUsageFinal: (assigned, usage) =>
              this.#coordinator.assertResourceUsageFinal(
                assigned as Extract<
                  ConversationRunJournalRecord,
                  { t: "assigned" }
                >,
                usage,
              ),
            facts,
          });
          if (preflightAtState.kind === "return") {
            return { kind: "return", value: preflightAtState.value };
          }
          return prepareBundleCompanionRecordsAtPrefix({
            conversationId: this.#conversationId,
            assigned: preflightAtState.assigned,
            currentRunState: preflightAtState.currentRunState,
            prepared,
            authorityPrefix,
            authority: this.#authority,
            delivery: this.#delivery,
            publisher: this.#publisher,
            currentAuthority: this.#currentAuthority,
            clockAt: () => this.#clock(),
            onAppendedGlobalRecords: (records) => {
              appendedGlobalRecords = records;
            },
            facts,
          });
        },
        prepared.candidateReferences,
        this.#publisher?.readProjectionIds ?? [],
        conversationDecisionScope(
          { rawBundle, ctx, mutationBatch: prepared.batch },
          { hydrate: true },
        ),
      )
      .catch((error: unknown) => {
        if (error instanceof TransactionArtifactReferenceError) {
          return {
            value: rejected(
              "missing-base",
              "Staged artifact dependencies changed; resubmit the bundle",
              true,
            ),
          };
        }
        if (
          error instanceof AuthorityStorageError &&
          error.code === "artifact-missing"
        ) {
          return undefined;
        }
        throw error;
      });
    if (!transaction) {
      return rejected(
        "missing-base",
        "Bundle artifact disappeared before the commit point",
        true,
      );
    }
    if (transaction.value.committed && appendedGlobalRecords.length) {
      try {
        await this.#publisher?.afterGlobalCommit?.({
          conversationId: this.#conversationId,
          assignmentId: bundle.assignmentId,
          records: appendedGlobalRecords,
        });
      } catch {
        // 观察失败由 publisher 自行上报诊断；这里只保证不改变已提交的结论
      }
    }
    return transaction.value;
  }

  /** Rebuild every missing post-commit projection from durable committed facts. */
  async resumeCommittedProjections(): Promise<number> {
    const pending =
      this.#coordinator.readBaseGeneration === 0 &&
      !this.#coordinator.importedBaseSource
        ? await this.#coordinator.readCurrentIndexed((view) =>
            readIndexedPendingProjections(view, this.#conversationId),
          )
        : await this.#coordinator.select(
            (facts) =>
              facts.commitPublish
                .listPendingCommitProjections()
                .map((committed) =>
                  snapshot(committed, "Pending commit projection"),
                ),
            conversationDecisionScope({}),
          );
    let projected = 0;
    for (const committed of pending) {
      const bytes = await this.#artifacts.get(
        committed.bundle.ref as ArtifactRef,
      );
      const bundle = validateConversationSealedBundle(
        JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
      );
      const closure = await validateConversationBundleClosure(
        bundle,
        this.#artifacts,
      );
      await this.#projection.project({
        assignmentId: committed.assignmentId,
        conversationId: this.#conversationId,
        commitRevision: committed.commitRevision,
        digest: bundle.digest,
        runRecord: closure.runRecord,
        ...(bundle.body.windowCompact
          ? { windowCompact: bundle.body.windowCompact }
          : {}),
        contentAssets: bundle.body.contentAssets,
        sessionMutations: (closure.batch?.records ?? [])
          .filter((record) => record.domain === "session")
          .map((record) => ({
            seq: record.seq,
            mutation: record.mutation as SessionStagedMutation,
            requestId: record.requestId,
          })),
      });
      const progress: ConversationProjectionRecord = {
        kind: "conversation-commit-projection",
        assignmentId: committed.assignmentId,
        runId: committed.runId,
        commitRevision: committed.commitRevision,
        digest: bundle.digest,
      };
      const transaction = await this.#coordinator.transact<boolean>(
        (facts) =>
          decideCommitProjectionProgress({
            conversationId: this.#conversationId,
            assignmentId: committed.assignmentId,
            progress,
            facts,
          }),
        [],
        [],
        conversationDecisionScope({}),
      );
      if (transaction.value) projected += 1;
    }
    return projected;
  }

  async resumePublishing(assignmentId: string): Promise<number> {
    assertIdentifier(assignmentId, "Assignment id");
    const [projection, committed] = await Promise.all([
      this.#coordinator.selectPublish((publishFacts) => {
        const decision = publishFacts.getDecision(assignmentId);
        if (!decision) return undefined;
        const batch = publishFacts.getBatch(assignmentId);
        if (!batch) {
          throw corruptRunJournal(
            "Publish decision has no validated mutation batch",
          );
        }
        return {
          decision,
          batch,
          domains: (["session", "global"] as const).map((domain) => {
            const progress = publishFacts.getProgress(assignmentId, domain);
            return {
              domain,
              plan: publishFacts.getDomainPlan(assignmentId, domain),
              progress: progress
                ? { state: progress.state, upToSeq: progress.upToSeq }
                : undefined,
            };
          }),
        };
      }, [assignmentId]),
      this.#coordinator.select(
        (facts) => facts.commitPublish.hasCommitted(assignmentId),
        conversationDecisionScope({ assignmentId }),
      ),
    ]);
    if (!projection) return 0;
    const { decision, batch } = projection;
    if (!committed) {
      throw corruptRunJournal("Publish decision has no committed assignment");
    }
    if (!this.#publisher) {
      throw new Error("Staged mutation publisher is not configured");
    }
    let applied = 0;
    for (const { domain, plan, progress: storedProgress } of projection.domains) {
      let progress = storedProgress;
      const domainCount =
        domain === "session" ? decision.sessionCount : decision.globalCount;
      if (
        domainCount === 0 ||
        !domainPublishDecisionRequired(
          batch.records as import("@zhixing-ai/core/contracts").MutationBatch["records"],
          decision.outcomes as Extract<
            import("@zhixing-ai/core/contracts").PublishRecord,
            { t: "publish-decision" }
          >["outcomes"],
          domain,
        )
      ) {
        continue;
      }
      if (!plan) {
        throw corruptRunJournal(
          "Publish decision has no durable domain recovery plan",
        );
      }
      if (!progress) {
        await this.#coordinator.appendPublishProgress({
          t: "publish-progress",
          assignmentId,
          domain,
          upToSeq: 0,
          state: "pending",
        });
        progress = { state: "pending", upToSeq: 0 };
      }
      if (progress.state === "settled") continue;
      const currentIndex =
        progress.upToSeq === 0
          ? undefined
          : plan.grantedIndexBySeq.get(progress.upToSeq);
      if (progress.upToSeq !== 0 && currentIndex === undefined) {
        throw corruptRunJournal(
          "Publish progress is outside its domain recovery plan",
        );
      }
      const startIndex = currentIndex === undefined ? 0 : currentIndex + 1;
      for (let index = startIndex; index < plan.grantedSeqs.length; index += 1) {
        const seq = plan.grantedSeqs[index]!;
        const record = batch.records[seq - 1];
        const decided = decision.outcomes[seq - 1];
        if (
          !record ||
          record.seq !== seq ||
          record.domain !== domain ||
          !decided ||
          decided.seq !== seq ||
          decided.outcome.t !== "granted"
        ) {
          throw corruptRunJournal(
            "Publish domain recovery plan is inconsistent",
          );
        }
        await this.#publisher.apply({
          assignmentId,
          seq,
          domain,
          mutation: record.mutation as
            | SessionStagedMutation
            | import("@zhixing-ai/core/contracts").GlobalStagedMutation,
          requestId: record.requestId,
          targetRevision: decided.outcome.targetRevision,
          ...(decided.outcome.appliedResult
            ? { appliedResult: decided.outcome.appliedResult }
            : {}),
        });
        const settled = index === plan.grantedSeqs.length - 1;
        await this.#coordinator.appendPublishProgress({
          t: "publish-progress",
          assignmentId,
          domain,
          upToSeq: seq,
          state: settled ? "settled" : "pending",
        });
        applied += 1;
      }
      if (plan.grantedSeqs.length === 0) {
        await this.#coordinator.appendPublishProgress({
          t: "publish-progress",
          assignmentId,
          domain,
          upToSeq: plan.terminalSeq,
          state: "settled",
        });
      }
    }
    return applied;
  }

  async resumePendingPublishing(): Promise<number> {
    const assignments = await this.#coordinator.selectPublish((publishFacts) =>
      publishFacts.getPendingAssignmentsForConversation(this.#conversationId),
    );
    let applied = 0;
    for (const assignmentId of assignments) {
      applied += await this.resumePublishing(assignmentId);
    }
    return applied;
  }

  async pendingFinalFrames(): Promise<FinalFrame[]> {
    const pending = await this.#coordinator.selectFinal((finalFacts) =>
      finalFacts
        .listPendingForConversation(this.#conversationId)
        .map((entry) => snapshot(entry, "Pending final frame"))
        .sort(
          (left, right) =>
            left.record.commitRevision - right.record.commitRevision,
        ),
    );
    if (!pending.length) return [];
    const assignmentByRevision = await this.#coordinator.select(
      (facts) =>
        new Map(
          pending.flatMap(({ record }) => {
            const assignmentId =
              facts.commitPublish.getAssignmentByCommitRevision(
                record.commitRevision,
              );
            return assignmentId
              ? [[record.commitRevision, assignmentId] as const]
              : [];
          }),
        ),
      conversationDecisionScope({ pending }),
    );
    const conflictCount = await this.#coordinator.selectPublish(
      (publishFacts) =>
        new Map(
          [...assignmentByRevision.values()].map((assignmentId) => [
            assignmentId,
            publishFacts.getConflicts(assignmentId)?.length ?? 0,
          ]),
        ),
      [...assignmentByRevision.values()],
    );
    return pending.map(({ record }) => {
      const assignmentId = assignmentByRevision.get(record.commitRevision);
      return finalFrame(
        record as import("@zhixing-ai/core/contracts").FinalOutboxRecord,
        assignmentId ? (conflictCount.get(assignmentId) ?? 0) : 0,
      );
    });
  }

  async publishPendingFinals(
    publish: (
      frame: FinalFrame,
      publishResults: readonly PublishResultNotice[],
    ) => Promise<void>,
  ): Promise<number> {
    let published = 0;
    for (const frame of await this.pendingFinalFrames()) {
      const assignmentId = await this.#coordinator.select(
        (facts) =>
          facts.commitPublish.getAssignmentByCommitRevision(
            frame.commitRevision,
          ),
        conversationDecisionScope({ frame }),
      );
      const publishResults = assignmentId
        ? await this.publishResults(assignmentId)
        : [];
      await publish(frame, publishResults);
      if (
        await this.#coordinator.transitionFinal(frame, "pending", "published")
      ) {
        published += 1;
      }
    }
    return published;
  }

  async expirePublishedFinals(now: IsoTime): Promise<number> {
    const cutoff =
      canonicalTime(now, "Final outbox sweep time") - FINAL_OUTBOX_RETENTION_MS;
    const projection = await this.#coordinator.selectFinal(
      (finalFacts) =>
        finalFacts
          .listPublishedForConversation(this.#conversationId)
          .map((entry) => snapshot(entry, "Published final frame")),
      cutoff,
    );
    let expired = 0;
    for (const { record, at } of projection.sort(
      (left, right) => left.record.commitRevision - right.record.commitRevision,
    )) {
      if (
        record.state !== "published" ||
        canonicalTime(at, "Final outbox record time") > cutoff
      ) {
        continue;
      }
      if (
        await this.#coordinator.transitionFinal(
          finalFrame(
            record as import("@zhixing-ai/core/contracts").FinalOutboxRecord,
          ),
          "published",
          "expired",
          cutoff,
        )
      ) {
        expired += 1;
      }
    }
    return expired;
  }

  async statusHistory(
    runId: string,
    afterStatusRevision: number,
  ): Promise<ConversationStatusNotice[]> {
    return (
      await this.statusHistoryBatch([{ runId, afterStatusRevision }])
    )[0]!.notices;
  }

  async statusHistoryBatch(
    requests: readonly {
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ): Promise<
    Array<{
      readonly notices: ConversationStatusNotice[];
      readonly nextAfterStatusRevision?: number;
    }>
  > {
    if (requests.length > 64) {
      throw new RangeError(
        "A status history batch may contain at most 64 cursors",
      );
    }
    for (const request of requests) {
      assertIdentifier(request.runId, "Run id");
      assertNonNegativeSafeInteger(
        request.afterStatusRevision,
        "Last-seen status revision",
      );
    }
    return Promise.all(
      requests.map(async ({ runId, afterStatusRevision }) => {
        const page = await this.#readIndex.statusHistory(
          this.#conversationId,
          runId,
          afterStatusRevision,
        );
        const selected = page.slice(0, 64);
        const notices = selected
          .map((record) =>
            conversationStatusNotice(
              this.#conversationId,
              this.#ownerEpoch,
              runId,
              record,
            ),
          )
          .filter(
            (notice): notice is ConversationStatusNotice =>
              notice !== undefined,
          );
        return {
          notices,
          ...(selected.length > 0
            ? { nextAfterStatusRevision: selected.at(-1)!.statusRevision }
            : {}),
        };
      }),
    );
  }

  async runState(runId: string): Promise<ConversationRunState | undefined> {
    assertIdentifier(runId, "Run id");
    return this.currentState(runId);
  }

  worksceneContinuationFrontiers(root: {
    conversationId: string;
    runId: string;
  }) {
    return this.#readIndex.continuationFrontiers(root);
  }

  async worksceneContinuationSources(
    query?: WorksceneContinuationQuery,
  ): Promise<readonly WorksceneContinuationSource[]> {
    const member =
      query && "rootMember" in query
        ? await this.#readIndex.continuationMember(
            this.#conversationId,
            query.rootMember,
          )
        : undefined;
    const pending =
      query && "rootMember" in query
        ? member
          ? [member]
          : []
        : query && "runId" in query
          ? [query.runId]
          : query && "parent" in query
            ? await this.#readIndex.continuationChildren(
                this.#conversationId,
                query.parent,
              )
            : await this.#readIndex.pendingObligationRuns(this.#conversationId);
    if (!pending.length) return [];
    const selected = new Set(pending);
    const obligations = await this.#readIndex.continuationPending(
      this.#conversationId,
      pending,
    );
    const sources = await this.#coordinator.select(
      (facts) =>
        facts.queueInput
          .listAdmittedForRuns(selected)
          .flatMap(({ record: admitted, lsn, domainRevision }) => {
            const control = facts.session.getWorksceneControl(admitted.runId);
            const record = control?.record;
            const runState = record
              ? "committed"
              : facts.assignment.getRunState(admitted.runId)?.state;
            if (!record && !admitted.ingress.turnOrigin?.worksceneContinuation) {
              return [];
            }
            const advancement =
              record?.advancement ??
              (admitted.invocation.kind === "agent"
                ? admitted.invocation.advancement
                : undefined);
            const advancementSessionId =
              control?.advancementSessionId ?? advancement?.sessionId;
            const active = advancementSessionId
              ? facts.session.getAdvancementStatus(advancementSessionId) ===
                "active"
              : true;
            const result = record
              ? record.messages
                  .filter((message) => message.role === "assistant")
                  .at(-1)
                  ?.content.filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n") ||
                "本次运行没有最终文本结果，请核对任务记录。"
              : `受托运行状态为 ${runState}，任务未完成。可能已经产生部分动作；先核对原运行记录，不重复执行已发生或不确定的副作用。`;
            return [
              {
                admissionLsn: lsn,
                pending: obligations.has(admitted.runId),
                conversationId: this.#conversationId,
                runId: admitted.runId,
                ingressId: admitted.ingress.ingressId,
                state: runState as WorksceneContinuationSource["state"],
                current:
                  !facts.session.deleted &&
                  active &&
                  (domainRevision === undefined
                    ? lsn > facts.session.clearedThroughLsn
                    : domainRevision >=
                      (facts.session.clearedThroughRevision ?? 0)),
                ...(record?.postTurnControl
                  ? {
                      control: structuredClone(
                        record.postTurnControl,
                      ) as NonNullable<WorksceneContinuationSource["control"]>,
                    }
                  : {}),
                result,
                ...(admitted.ingress.turnOrigin
                  ? {
                      origin: structuredClone(
                        admitted.ingress.turnOrigin,
                      ) as NonNullable<WorksceneContinuationSource["origin"]>,
                    }
                  : {}),
                surfacePrincipal: admitted.ingress.surfacePrincipal,
                ...(admitted.environment
                  ? {
                      environment: structuredClone(
                        admitted.environment,
                      ) as ExplicitEnvironmentSelection,
                    }
                  : {}),
                ...(advancement
                  ? {
                      advancement: structuredClone(
                        advancement,
                      ) as NonNullable<
                        WorksceneContinuationSource["advancement"]
                      >,
                    }
                  : {}),
                ...(advancementSessionId ? { advancementSessionId } : {}),
              },
            ];
          }),
      conversationDecisionScope({}, { workscene: true, runs: pending }),
    );
    if (sources.length === 0) return [];
    sources.sort((left, right) => left.admissionLsn - right.admissionLsn);
    const stopped = await this.#readIndex.stoppedRuns(
      this.#conversationId,
      sources.map((source) => source.runId),
    );
    return sources.map(({ admissionLsn: _position, ...source }) => ({
      ...source,
      current: source.current && !stopped.has(source.runId),
    }));
  }

  async advancementSession(sessionId: string): Promise<AdvancementSession | null> {
    assertIdentifier(sessionId, "Advancement session id");
    if (this.#coordinator.readBaseGeneration === 0) {
      const value = await readConversationExactValue<
        NonNullable<ReturnType<RunProjection["advancementSessions"]["get"]>>
      >(this.#log, this.#conversationId, "advancementSessions", sessionId);
      return value
        ? freezeAdvancementSessions(new Map([[sessionId, value]]))[0]!
        : null;
    }
    if (!(await this.#readIndex.hasAdvancement(this.#conversationId))) {
      return null;
    }
    return this.#sessionRead.read((state) => {
      const value = state.advancementSessions.get(sessionId);
      return value
        ? freezeAdvancementSessions(new Map([[sessionId, value]]))[0]!
        : null;
    });
  }

  async pendingAdvancementOriginalTasks(after?: string): Promise<{
    readonly sessionIds: readonly string[];
    readonly next?: string;
  }> {
    if (this.#coordinator.readBaseGeneration === 0) {
      return this.#readAdvancementRecovery(async (current) => {
        const view = await conversationViewAt(
          this.#log,
          current,
          this.#conversationId,
        );
        if ((await advancementRecoveryRoot(view, this.#conversationId)).deleted) {
          return { sessionIds: [] };
        }
        const prefix = `${advancementRecoveryPrefix(this.#conversationId)}original/`;
        const page = await view.scan(
          {
            ...(after ? { gt: prefix + after } : { gte: prefix }),
            lt: `${prefix}\uffff`,
          },
          16,
        );
        const ids = page.entries.map((row) => row.value as string);
        return {
          sessionIds: ids,
          ...(page.continuation ? { next: ids.at(-1)! } : {}),
        };
      });
    }
    if (!(await this.#readIndex.hasAdvancement(this.#conversationId))) {
      return { sessionIds: [] };
    }
    return this.#sessionRead.read((state) => {
      const ids = [...state.advancementSessions.values()]
        .filter(
          (session) =>
            session.originalTaskAdmission?.status === "pending" &&
            (session.status === "active" ||
              (session.status === "cancelled" &&
                session.originalTaskAdmission.mode === "direct")),
        )
        .map((session) => session.id)
        .filter((id) => after === undefined || id > after)
        .sort();
      const page = ids.slice(0, 50);
      return {
        sessionIds: page,
        ...(ids.length > page.length ? { next: page[page.length - 1]! } : {}),
      };
    });
  }

  async pendingAdvancementProposals(): Promise<
    readonly {
      readonly runId: string;
      readonly originalTurnId: string;
      readonly originalUserTask: UserTurnInput;
    }[]
  > {
    const runIds = await this.#readAdvancementRecovery(async (current) =>
      advancementPendingProposals(
        await conversationViewAt(this.#log, current, this.#conversationId),
        this.#conversationId,
      ),
    );
    const pending: {
      readonly runId: string;
      readonly originalTurnId: string;
      readonly originalUserTask: UserTurnInput;
    }[] = [];
    for (const runId of runIds) {
      const originalTurnId = await this.#coordinator.select((facts) => {
        const ingress = facts.queueInput.getAdmitted(runId)?.record.ingress;
        return ingress && "ingressId" in ingress ? ingress.ingressId : undefined;
      }, conversationDecisionScope({ runId }));
      const committed = originalTurnId
        ? await this.committedRun(runId)
        : undefined;
      if (originalTurnId && committed) {
        pending.push({
          runId,
          originalTurnId,
          originalUserTask: userTurnInputFromMessages(
            committed.runRecord.messages,
          ),
        });
      }
    }
    return pending;
  }

  async advancementSessions(): Promise<AdvancementSession[]> {
    if (!(await this.#readIndex.hasAdvancement(this.#conversationId))) return [];
    return this.#sessionRead.read((state) =>
      freezeAdvancementSessions(state.advancementSessions),
    );
  }

  async advancementHead(): Promise<AdvancementSession | null> {
    const id = await this.#readAdvancementRecovery(async (current) =>
      advancementRecoveryHead(
        await conversationViewAt(this.#log, current, this.#conversationId),
        this.#conversationId,
      ),
    );
    return id ? this.advancementSession(id) : null;
  }

  async pendingAdvancementRun(sessionId: string, before?: number) {
    const work = await this.#readAdvancementRecovery(async (current) =>
      advancementPendingRun(
        await conversationViewAt(this.#log, current, this.#conversationId),
        this.#conversationId,
        sessionId,
        before,
      ),
    );
    if (!work) return work;
    const accepted = await this.committedRun(work.runId);
    if (!accepted || accepted.runRecord.runIndex !== work.runIndex) {
      throw new Error("Advancement pending run has no matching accepted fact");
    }
    return {
      record: accepted.runRecord,
      runRecordRef: { shardId: "owner-log", runIndex: work.runIndex },
    };
  }

  async pendingAdvancementCleanup(after?: string) {
    return this.#readAdvancementRecovery(async (current) => {
      const view = await conversationViewAt(
        this.#log,
        current,
        this.#conversationId,
      );
      const root = await advancementRecoveryRoot(view, this.#conversationId);
      const prefix = `${advancementRecoveryPrefix(this.#conversationId)}cleanup/`;
      if (after && !after.startsWith(prefix)) {
        throw new TypeError(
          "Advancement cleanup cursor belongs to another conversation",
        );
      }
      const page = await view.scan(
        {
          ...(after ? { gt: after } : { gte: prefix }),
          lt: `${prefix}\uffff`,
        },
        16,
      );
      return {
        items: page.entries.map((row) => ({
          ...(row.value as unknown as AdvancementCleanupWork),
          deleted: !!root.deleted,
        })),
        ...(page.continuation ? { next: page.entries.at(-1)!.key } : {}),
      };
    });
  }

  #readAdvancementRecovery<T>(
    read: (view: DurableProjectionReadContext) => Promise<T>,
  ): Promise<T> {
    registerAdvancementRecoveryProjection(this.#log, this.#artifacts);
    return readAdvancementRecovery(this.#log, read);
  }

  async applyAdvancementEvents(input: {
    readonly requestId: string;
    readonly events: readonly AdvancementControlEvent[];
  }): Promise<{ readonly domainRevision: number }> {
    registerAdvancementRecoveryProjection(this.#log, this.#artifacts);
    assertIdentifier(input.requestId, "Advancement write request id");
    if (input.events.length === 0) {
      throw new TypeError("Advancement write requires at least one event");
    }
    const sessionIds = new Set(
      input.events
        .filter((event) => event.type !== "submission_settled")
        .map((event) => event.sessionId),
    );
    if (sessionIds.size > 1) {
      throw new TypeError(
        "Advancement write events must bind exactly one advancement session",
      );
    }
    for (const event of input.events) {
      if (
        !(await verifyProtocolStep(() =>
          isAdvancementControlEvent(event, this.#verifier),
        ))
      ) {
        throw new TypeError("Advancement event contract failed");
      }
      if (
        (event.type === "session_created" ||
          event.type === "submission_settled") &&
        event.conversationId !== this.#conversationId
      ) {
        throw new TypeError("Advancement event conversation mismatch");
      }
      if (
        event.type === "submission_settled" &&
        input.requestId !==
          advancementSubmissionRequestId(
            this.#conversationId,
            event.receipt.identity.surfacePrincipal,
            event.receipt.identity.submissionId,
          )
      ) {
        throw new TypeError("Advancement submission key mismatch");
      }
    }
    const eventsDigest = byteDigest(
      Buffer.from(canonicalize(input.events), "utf8"),
    );
    const prepared: PreparedStored<AdvancementControlEvent>[] = [];
    for (const event of input.events) {
      prepared.push(await prepareStored(event, this.#artifacts));
    }
    const transaction = await this.#coordinator.transact<{
      domainRevision: number;
    }>(
      (facts) =>
        decideAdvancementEvents({
          conversationId: this.#conversationId,
          requestId: input.requestId,
          events: input.events,
          eventsDigest,
          preparedEvents: prepared.map((candidate) => candidate.stored),
          facts,
        }),
      collectArtifactRefs(
        prepared.flatMap((candidate) => candidate.references),
      ),
      [],
      conversationDecisionScope({ input }, { advancement: true }),
    );
    return transaction.value;
  }

  async publishConflicts(
    assignmentId: string,
  ): Promise<PublishConflictNotice | undefined> {
    assertIdentifier(assignmentId, "Assignment id");
    const [committed, conflicts] = await Promise.all([
      this.#coordinator.select((facts) => {
        const record = facts.commitPublish.getCommitted(assignmentId);
        return record ? snapshot(record, "Committed assignment") : undefined;
      }, conversationDecisionScope({ assignmentId })),
      this.#coordinator.selectPublish((publishFacts) => {
        const records = publishFacts.getConflicts(assignmentId);
        return records ? snapshot(records, "Publish conflicts") : undefined;
      }, [assignmentId]),
    ]);
    if (!committed || !conflicts) return undefined;
    return projectPublishConflicts({
      conversationId: this.#conversationId,
      runId: committed.runId,
      commitRevision: committed.commitRevision,
      conflicts: conflicts as PublishConflictNotice["conflicts"],
    });
  }

  async publishResults(assignmentId: string): Promise<PublishResultNotice[]> {
    assertIdentifier(assignmentId, "Assignment id");
    const [committed, source] = await Promise.all([
      this.#coordinator.select((facts) => {
        const record = facts.commitPublish.getCommitted(assignmentId);
        return record ? snapshot(record, "Committed assignment") : undefined;
      }, conversationDecisionScope({ assignmentId })),
      this.#coordinator.selectPublish((publishFacts) => {
        const decision = publishFacts.getDecision(assignmentId);
        const batch = publishFacts.getBatch(assignmentId);
        return decision && batch
          ? {
              decision: snapshot(
                decision as Extract<
                  import("@zhixing-ai/core/contracts").PublishRecord,
                  { t: "publish-decision" }
                >,
                "Publish decision",
              ),
              batch: snapshot(
                batch as import("@zhixing-ai/core/contracts").MutationBatch,
                "Publish mutation batch",
              ),
            }
          : undefined;
      }, [assignmentId]),
    ]);
    if (!committed || !source) return [];
    return projectPublishResults({
      conversationId: this.#conversationId,
      runId: committed.runId,
      commitRevision: committed.commitRevision,
      assignmentId,
      ...source,
    });
  }

  async finalHistory(
    afterCommitRevision: number,
  ): Promise<CommittedConversationResult[]> {
    assertNonNegativeSafeInteger(
      afterCommitRevision,
      "Last-seen commit revision",
    );
    const commits = await this.#coordinator.select(
      (facts) =>
        facts.commitPublish
          .commitsAfter(afterCommitRevision)
          .map((committed) => snapshot(committed, "Final history commit")),
      conversationDecisionScope(
        { afterCommitRevision },
        { historyAfter: afterCommitRevision },
      ),
    );
    const publishSources = await this.#coordinator.selectPublish(
      (publishFacts) =>
        new Map(
          commits.flatMap((committed) => {
            const decision = publishFacts.getDecision(committed.assignmentId);
            const batch = publishFacts.getBatch(committed.assignmentId);
            return decision && batch
              ? [
                  [
                    committed.assignmentId,
                    {
                      decision: snapshot(
                        decision as Extract<
                          import("@zhixing-ai/core/contracts").PublishRecord,
                          { t: "publish-decision" }
                        >,
                        "Final history publish decision",
                      ),
                      batch: snapshot(
                        batch as import("@zhixing-ai/core/contracts").MutationBatch,
                        "Final history mutation batch",
                      ),
                    },
                  ] as const,
                ]
              : [];
          }),
        ),
      commits.map((committed) => committed.assignmentId),
    );
    const output: CommittedConversationResult[] = [];
    for (const committed of commits) {
      const bytes = await this.#artifacts.get(
        committed.bundle.ref as ArtifactRef,
      );
      const bundle = validateConversationSealedBundle(
        JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
      );
      const source = publishSources.get(committed.assignmentId);
      const publishResults = source
        ? projectPublishResults({
            conversationId: this.#conversationId,
            runId: committed.runId,
            commitRevision: committed.commitRevision,
            assignmentId: committed.assignmentId,
            ...source,
          })
        : [];
      const conflictCount = publishResults.filter(
        (notice) => notice.decision.t === "conflicted",
      ).length;
      output.push({
        frame: {
          v: 1,
          conversationId: this.#conversationId,
          runId: committed.runId,
          commitRevision: committed.commitRevision,
          digest: bundle.digest,
          ...(conflictCount > 0 ? { publishConflicts: conflictCount } : {}),
        },
        bundle,
        publishResults,
      });
    }
    return output;
  }

  async committedRun(
    runId: string,
  ): Promise<ConversationCommitProjectionInput | undefined> {
    assertIdentifier(runId, "Run id");
    const committed = await this.#coordinator.select((facts) => {
      const record = facts.commitPublish.findCommittedByRunId(runId);
      return record ? snapshot(record, "Committed run replay") : undefined;
    }, conversationDecisionScope({ runId }));
    if (!committed) return undefined;
    const bytes = await this.#artifacts.get(
      committed.bundle.ref as ArtifactRef,
    );
    const bundle = validateConversationSealedBundle(
      JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
    );
    const closure = await validateConversationBundleClosure(
      bundle,
      this.#artifacts,
    );
    return {
      assignmentId: committed.assignmentId,
      conversationId: this.#conversationId,
      commitRevision: committed.commitRevision,
      digest: bundle.digest,
      runRecord: closure.runRecord,
      ...(bundle.body.windowCompact
        ? { windowCompact: bundle.body.windowCompact }
        : {}),
      contentAssets: bundle.body.contentAssets,
      sessionMutations: (closure.batch?.records ?? [])
        .filter((record) => record.domain === "session")
        .map((record) => ({
          seq: record.seq,
          mutation: record.mutation as SessionStagedMutation,
          requestId: record.requestId,
        })),
    };
  }

  async currentState(runId: string): Promise<ConversationRunState | undefined> {
    if (
      this.#coordinator.readBaseGeneration !== 0 ||
      this.#coordinator.importedBaseSource
    ) {
      return this.#coordinator.select(
        (facts) => facts.assignment.getRunState(runId)?.state,
        conversationDecisionScope({ runId }),
      );
    }
    return this.#coordinator.readCurrentIndexed(async (view) => {
      const status = (await readConversationStateField(
        view,
        this.#conversationId,
        "stateByRun",
        runId,
      )) as ReturnType<RunProjection["stateByRun"]["get"]>;
      return status?.state;
    });
  }

  async currentResolution(
    runId: string,
  ): Promise<ConversationUncertainResolutionFact | undefined> {
    return this.#coordinator.select((facts) => {
      const resolution = facts.assignment.getResolution(runId);
      return resolution
        ? (snapshot(
            resolution,
            "Current resolution",
          ) as ConversationUncertainResolutionFact)
        : undefined;
    }, conversationDecisionScope({ runId }));
  }

  async #acceptNotStartedTermination(
    proof:
      | import("@zhixing-ai/core/contracts").DispatchRejectionProof
      | Extract<SupersedeProof, { decision: "not-started-fenced" }>,
  ): Promise<void> {
    const at = this.#clock();
    await this.#coordinator.transact<void>(
      (facts) =>
        decideAcceptNotStartedTermination({
          conversationId: this.#conversationId,
          proof,
          at,
          legacyAbortTickets: this.#legacyAbortTickets,
          facts,
        }),
      [],
      [],
      conversationDecisionScope({ proof }),
    );
  }

  async #materializeDispatch(
    assigned: AssignedProjection | ReadonlyAssignedFact,
    written?: PendingConversationDispatch["envelope"],
  ): Promise<PendingConversationDispatch> {
    const dispatchRef = assigned.record.dispatchRef as ArtifactRef;
    const envelope =
      written ??
      (await verifyProtocolStep(async () =>
        validateConversationEnvelope(
          JSON.parse(
            Buffer.from(await this.#artifacts.get(dispatchRef)).toString("utf8"),
          ) as PendingConversationDispatch["envelope"],
          this.#verifier,
        ),
      ));
    const payload = buildConversationActivationPayload({
      envelope,
      dispatchRef,
      commit: {
        lsn: requireLocalAssignedCommit(assigned).lsn,
        envelopeDigest: requireLocalAssignedCommit(assigned).envelopeDigest,
      },
      issuedAt: requireLocalAssignedCommit(assigned).at,
    });
    return {
      assignmentId: assigned.record.assignmentId,
      envelope,
      activation: signConversationActivation(payload, this.#signer),
    };
  }

  readonly #reduceSessionRead = async (
    state: RunProjection,
    record: LogicalRecord<unknown>,
    rawEnvelope: CommitEnvelope<unknown>,
    throughRevision = Infinity,
  ): Promise<RunProjection> =>
    this.#reduceSessionFacts(
      state,
      record,
      rawEnvelope,
      rawEnvelope.lsn,
      throughRevision,
    );

  readonly #reduceSessionFacts = async (
    state: RunProjection,
    record: LogicalRecord<unknown>,
    facts: ConversationFactGroup<unknown>,
    sourceLsn: number,
    throughRevision = Infinity,
  ): Promise<RunProjection> => {
    const body = record.body as ConversationRunJournalRecord;
    if (
      !body ||
      typeof body !== "object" ||
      !("t" in body) ||
      ![
        "session-meta",
        "session-control",
        "session-lifecycle",
        "advancement-event",
        "committed",
      ].includes(body.t)
    ) {
      return state;
    }
    if (!("t" in body) || body.t !== "committed") {
      if (
        "domainRevision" in body &&
        typeof body.domainRevision === "number" &&
        body.domainRevision > throughRevision
      ) {
        return state;
      }
      await verifyProtocolStep(() =>
        assertConversationRunRecord(body, this.#verifier),
      );
      return reduceConversationSessionFact(
        {
          conversationId: this.#conversationId,
          artifacts: this.#artifacts,
          verifier: this.#verifier,
        },
        state,
        body as Extract<
          ConversationRunJournalRecord,
          {
            t:
              | "session-meta"
              | "session-control"
              | "session-lifecycle"
              | "advancement-event";
          }
        >,
        facts as ConversationFactGroup,
        sourceLsn,
      );
    }
    await verifyProtocolStep(() =>
      assertConversationRunRecord(body, this.#verifier),
    );
    const envelope = facts as ConversationFactGroup;
    const sidecars = submissionCommitSidecars(
      envelope,
      this.#conversationId,
      body,
    );
    if (!sidecars.publish?.sessionCount) return state;
    const bytes = await this.#artifacts.get(sidecars.publish.batch.ref);
    const text = Buffer.from(bytes).toString("utf8");
    const batch = validateMutationBatch(JSON.parse(text));
    if (canonicalize(batch) !== text || batch.assignmentId !== body.assignmentId) {
      throw corruptRunJournal(
        "Advancement read mutation batch binding is invalid",
      );
    }
    const decision = envelope.entries.find(
      (entry) =>
        entry.stream === "publish" &&
        (entry.body as { t?: string; assignmentId?: string }).t ===
          "publish-decision" &&
        (entry.body as { assignmentId?: string }).assignmentId ===
          body.assignmentId,
    )!;
    validatePublishDecisionForBatch(decision.body, batch);
    applyCommittedSessionMutations(state, batch.records, throughRevision);
    return state;
  };

  async #loadSubmissionGuardFacts(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<ConversationGuardDecisionFacts> {
    assertSubmissionContextIdentity(context, identity, "conversation");
    const snapshotValue = await readConversationSubmissionState(
      this.#log,
      this.#artifacts,
      this.#verifier,
      this.#conversationId,
      { assignments: [identity.assignmentId] },
      this.#legacyAbortTickets,
    );
    const guard = readConversationGuardDecisionFacts(snapshotValue.value.state);
    if (context.principal.kind !== "assignment") return guard;
    const assigned = guard.assignment.getAssigned(identity.assignmentId);
    await verifyProtocolStep(() =>
      assertSubmissionGuardActivatedCapability({
        target: {
          domain: "conversation",
          conversationId: this.#conversationId,
          currentOwnerEpoch: this.#ownerEpoch,
        },
        context,
        identity,
        assigned: assigned
          ? {
              assignmentId: assigned.record.assignmentId,
              executorId: assigned.record.executorId,
              capIds: assigned.record.capIds,
              epoch: assigned.record.ownerEpoch,
            }
          : undefined,
        verifier: this.#verifier,
        now: this.#clock(),
      }),
    );
    return guard;
  }

  #hasCurrentSubmissionAuthorityEpoch(context: AuthorityCallContext): boolean {
    return hasCurrentSubmissionAuthority(context, {
      domain: "conversation",
      conversationId: this.#conversationId,
      currentOwnerEpoch: this.#ownerEpoch,
    });
  }

  #authenticateSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    authenticateAssignmentSubmission(
      this.#submission,
      context,
      identity,
      "conversation",
    );
  }

  #assertActivatedSubmissionCapability(
    facts: Pick<ConversationDecisionFacts, "assignment">,
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    const assigned = facts.assignment.getAssigned(identity.assignmentId);
    assertSubmissionGuardActivatedCapability({
      target: {
        domain: "conversation",
        conversationId: this.#conversationId,
        currentOwnerEpoch: this.#ownerEpoch,
      },
      context,
      identity,
      assigned: assigned
        ? {
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            capIds: assigned.record.capIds,
            epoch: assigned.record.ownerEpoch,
            ...(assigned.envelope
              ? {
                  envelope: requireAssignedEnvelope(assigned),
                }
              : {}),
          }
        : undefined,
      verifier: this.#verifier,
      now: this.#clock(),
      checkEnvelopeMatch: true,
    });
  }

  #authorizeSubmission(
    facts: Pick<ConversationDecisionFacts, "assignment">,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    const assigned = facts.assignment.getAssigned(authorization.assignmentId);
    authorizeAssignmentSubmissionCapability({
      submission: this.#submission,
      target: {
        domain: "conversation",
        conversationId: this.#conversationId,
        currentOwnerEpoch: this.#ownerEpoch,
      },
      context,
      authorization,
      assigned: assigned
        ? {
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            capIds: assigned.record.capIds,
            epoch: assigned.record.ownerEpoch,
            ...(assigned.envelope
              ? {
                  envelope: assigned.envelope,
                }
              : {}),
          }
        : undefined,
      isCapabilityRevoked: (capId) =>
        facts.assignment.isCapabilityRevoked(authorization.assignmentId, capId),
      verifier: this.#verifier,
      now: this.#clock(),
      checkEnvelopeMatch: true,
    });
  }

  #authorizeGuardSubmission(
    guard: Pick<ConversationGuardDecisionFacts, "assignment">,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    const assigned = guard.assignment.getAssigned(authorization.assignmentId);
    authorizeAssignmentSubmissionCapability({
      submission: this.#submission,
      target: {
        domain: "conversation",
        conversationId: this.#conversationId,
        currentOwnerEpoch: this.#ownerEpoch,
      },
      context,
      authorization,
      assigned: assigned
        ? {
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            capIds: assigned.record.capIds,
            epoch: assigned.record.ownerEpoch,
          }
        : undefined,
      isCapabilityRevoked: (capId) =>
        guard.assignment.isCapabilityRevoked(authorization.assignmentId, capId),
      verifier: this.#verifier,
      now: this.#clock(),
      checkEnvelopeMatch: false,
    });
  }

  #publishStatusNotices(notices: readonly ConversationStatusNotice[]): void {
    for (const notice of notices) {
      for (const listener of this.#statusListeners) {
        void Promise.resolve()
          .then(() => listener(notice))
          .catch(() => undefined);
      }
    }
  }
}

function contextFor(ctx: AuthorityCallContext): AuthorityCallContext {
  return ctx;
}
