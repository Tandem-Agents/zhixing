import { maintenanceRetryDelayMs, currentMaintenanceAbortSignal, StorageMaintenanceCancelledError } from "@zhixing/core/resources";
import { retryControlAdmission } from "./conversation-admission-retry.js";
import { retryDurableObligation } from "./durable-obligation-retry.js";
import { shouldRetryRemoteObligation } from "./remote-obligation-failure.js";
import { AuthorityStorageError } from "@zhixing/core/authority";
import { AssignmentStartCancelledError, DataPlaneAssignmentInactiveError } from "@zhixing/executor";
import { randomUUID } from "node:crypto";
import { WorksceneContinuationApplication, isWorksceneContinuationCurrent, worksceneTaskContext, readWorksceneTaskContext } from "@zhixing/core/workscene/application";
import { normalizeUserTurnInput, userMessageFromTurnInput } from "@zhixing/core";
import { parseConversationId, parseLocalConversationId } from "@zhixing/core/conversation";
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import type {
  AuthorityCapability,
  AuthorityCallContext,
  AuthorityError,
  AssignmentActivationProof,
  ControlLease,
  ConversationStatusNotice,
  FinalFrame,
  IngressContext,
  InteractionMirrorBatch,
  OwnerControlGrant,
  PublishResultNotice,
  ConversationInvocation,
  AssignmentResourceLease,
  RunExecutorPort,
  RunSubmissionPort,
  ReservationOrigin,
  StreamFrame,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  assertPrincipalAllowsAuthorityMethod,
  MAX_CONTROL_LEASE_TTL_MS,
  canonicalize,
  dispatchEnvelopeDigest,
  ownerControlRequestDigest,
  protocolDigest,
  validateAuthorityCapability,
  validateStreamFrame,
  type ConversationInteractionMirrorBatch,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type StreamDataFramePayload,
} from "@zhixing/core/protocol";
import {
  ConversationRunJournal,
  pendingAdvancementConversations,
  prioritizeConversationDecisionMigration,
  conversationRecoveryPage,
  conversationRecoveryPending,
  ConversationAssignmentCancelledError,
  ConversationPendingCancellationError,
  InProcessConversationDispatcher,
  type AssignmentSubmissionAuthorizer,
  type AssignmentSubmissionIdentity,
  type AssignmentSubmissionPreflightPort,
  type ConversationCommitAuthority,
  type CommittedConversationResult,
  type ConversationMutationPublisher,
  type PendingConversationInput,
  type InProcessDispatchContextFactory,
} from "@zhixing/owner-kernel/conversation-assignment";
import {
  ConversationAssignmentAuthority,
} from "@zhixing/owner-kernel/conversation-assignment-authority";
import { assignmentReservationId, ResourceCandidateStaleError } from "@zhixing/owner-kernel/resource-governor";
import type {
  DeferredIntentConversationAuthority,
  DeferredIntentConversationTransaction,
} from "@zhixing/owner-kernel/deferred-global-intents";
import {
  loadCommittedConversationBase, readCommittedConversationTransferHeader, isConversationSourceEvidenceError,
  resolveCurrentConversationAuthority, resolveConversationPublicationOwner,
  type ConversationTransferPublication,
} from "@zhixing/owner-kernel/conversation-transfer";
import { ConversationSessionStateAdapter } from "@zhixing/owner-kernel/session-state-adapter";
import {
  channelSurfacePrincipal,
  createConversationControlEnvelope,
  createInitialControlEnvelope,
} from "@zhixing/owner-kernel/control-admission";
import {
  type ConversationManager,
  type ManagedSession,
  type TurnCommittedInfo,
} from "@zhixing/owner-kernel/conversation-manager";
import { type SessionRuntime } from "@zhixing/owner-kernel/types";
import {
  DurableConversationAdmissionRejectedError,
  runTurnWithCommit,
  type DurableConversationAdmissionInput,
  type DurableConversationAdmissionResult,
  type DurableConversationCancelInput,
  type DurableConversationCancellationDisposition,
  type DurableConversationCancellationResult,
  type DurableConversationResolutionResult,
  type DurableConversationResolveInput,
  type DurableConversationSessionProjectionInput,
  type DurableConversationSessionWriteInput,
  type DurableConversationSessionWriteResult,
  type DurableConversationTurnExecutor,
  type DurableConversationTurnInput,
} from "@zhixing/owner-kernel/run-turn";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import type {
  AuthorityRuntimeStack,
} from "../setup-delivery.js";
import {
  anchorConversationOwnerRuntime,
  type ConversationOwnerRuntimeStack,
} from "./conversation-owner-runtime.js";
import type { SessionStatePort } from "@zhixing/core/contracts";
import {
  DurableConversationInteractionObserver,
} from "./durable-conversation-interactions.js";
import {
  assignmentGlobalCapability,
  createAssignmentGlobalQueryPort,
} from "./assignment-global-state-ports.js";
import type {
  ConversationChannelSessionInput,
  FirstPartySurfaceSession,
  FirstPartySurfaceSessionInput,
  LosslessDataPlaneSession,
} from "./lossless-data-plane-runtime.js";
import type {
  FirstPartyFinalitySession,
  FirstPartyFinalitySessionOptions,
} from "./first-party-finality-session.js";
import type {
  ConversationAssignmentArtifactAuthorityIndex,
  ConversationAssignmentStagingPort,
  ConversationExecutorDispatchApplication,
  ConversationExecutorExecutionEffect,
} from "./conversation-executor-dispatch.js";

export { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";

const CONTEXT_TTL_MS = MAX_CONTROL_LEASE_TTL_MS;
const CONTROL_RENEWAL_INTERVAL_MS = Math.floor(CONTEXT_TTL_MS / 3);

export interface ConversationProtocolRuntimeOptions {
  readonly authority?: AuthorityRuntimeStack;
  readonly owner?: ConversationOwnerRuntimeStack;
  readonly losslessDataPlane: ConversationLosslessDataPlaneTopology;
  readonly manager: () => ConversationManager;
  /** Existing directory identities can precede their first owner-journal fact. */
  readonly storedIdentityExists?: (conversationId: string) => Promise<boolean>;
  readonly clock?: () => string;
  readonly interactions: DurableConversationInteractionObserver;
  readonly executorDispatch: ConversationExecutorDispatchApplication;
  readonly assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly assignmentStaging?: ConversationAssignmentStagingPort;
  readonly executeRecoveredPerspective?: (input: {
    readonly manager: ConversationManager;
    readonly managed: ManagedSession;
    readonly originalInput: PendingConversationInput["input"];
    readonly question: string;
    readonly source: "interactive" | "channel";
    readonly abortSignal?: AbortSignal;
    readonly turnContext: NonNullable<
      import("@zhixing/owner-kernel/types").RunTurnOptions["turnContext"]
    >;
    readonly authorizeToolExecution?: NonNullable<
      import("@zhixing/owner-kernel/types").RunTurnOptions["authorizeToolExecution"]
    >;
    readonly modelCallMetering?: import("@zhixing/owner-kernel/types").SessionRuntimeModelCallMetering;
  }) => Promise<RunResult>;
  readonly onFailure?: (error: unknown, context: { readonly phase: "run" | "recovery"; readonly conversationId: string; readonly runId?: string }) => void;
  readonly onStatus?: (notice: ConversationStatusNotice) => void | Promise<void>;
  readonly onFinal?: (frame: FinalFrame) => void | Promise<void>;
  readonly onPublishResult?: (
    notice: PublishResultNotice,
  ) => void | Promise<void>;
  readonly onFirstPartyFrame?: (frame: StreamFrame, readDisplay?: () => Promise<StreamDataFramePayload>) => void | Promise<void>;
  readonly onFirstPartyAssignment?: (source: { conversationId: string; runId: string; assignmentId: string }) => void;
  readonly onFirstPartyStreamEnd?: (source: { readonly conversationId: string; readonly runId: string; readonly assignmentId: string; readonly finalSeq: number }) => void;
  readonly createFirstPartyFinality?: (
    input: Omit<FirstPartyFinalitySessionOptions, "sources">,
  ) => FirstPartyFinalitySession;
  /** Idempotently materializes a durable clear/delete fact into legacy storage/runtime views. */
  readonly projectLifecycle?: (
    input: DurableConversationSessionProjectionInput,
  ) => Promise<void>;
  /** Reconciles durable conversation facts with independently persisted auxiliary views. */
  readonly recoverAuxiliary: (conversationId: string) => Promise<void>;
}

interface AppliedConversationAdmission {
  readonly runId: string;
  readonly ingress: IngressContext;
  readonly attachments: PendingConversationInput["attachments"];
  readonly environment?: import("@zhixing/core/contracts").ExplicitEnvironmentSelection;
  readonly replayed: boolean;
}

interface PreparedConversationAdmission {
  readonly conversationId: string;
  readonly surfacePrincipal: string;
  readonly admission: AppliedConversationAdmission;
  readonly input: PendingConversationInput["input"];
  readonly attachments: PendingConversationInput["attachments"];
  readonly invocation: ConversationInvocation;
  readonly environment?: import("@zhixing/core/contracts").ExplicitEnvironmentSelection;
}

export interface ConversationLosslessDataPlanePort {
  openConversationChannel(
    input: ConversationChannelSessionInput,
  ): Promise<LosslessDataPlaneSession>;
  openFirstPartySurfaceSession(
    input: FirstPartySurfaceSessionInput,
  ): Promise<FirstPartySurfaceSession>;
  recoverConversationChannels(journal: ConversationRunJournal): Promise<number>;
}

export type ConversationLosslessDataPlaneTopology =
  | Readonly<{
      readonly kind: "available";
      readonly port: ConversationLosslessDataPlanePort;
    }>
  | Readonly<{
      readonly kind: "absent";
      readonly reason: "executor-only";
    }>;

/** Private one-shot seam for the protocol/manager construction cycle. */
export function createConversationManagerAssemblyHandle(): Readonly<{
  readonly resolve: () => ConversationManager;
  complete(manager: ConversationManager): void;
}> {
  let manager: ConversationManager | undefined;
  let completed = false;
  const resolve = (): ConversationManager => {
    if (!completed || !manager) {
      throw new Error("Conversation protocol manager is not assembled");
    }
    return manager;
  };
  return Object.freeze({
    resolve,
    complete(candidate: ConversationManager) {
      if (completed) {
        throw new Error("Conversation protocol manager is already assembled");
      }
      manager = candidate;
      completed = true;
    },
  });
}

/** Private one-shot seam for the protocol/auxiliary-recovery construction cycle. */
export function createConversationAuxiliaryRecoveryAssemblyHandle(): Readonly<{
  readonly resolve: (conversationId: string) => Promise<void>;
  complete(recover: (conversationId: string) => Promise<void>): void;
}> {
  let recovery: ((conversationId: string) => Promise<void>) | undefined;
  let completed = false;
  const resolve = (conversationId: string): Promise<void> => {
    if (!completed || !recovery) {
      throw new Error("Conversation auxiliary recovery is not assembled");
    }
    return recovery(conversationId);
  };
  return Object.freeze({
    resolve,
    complete(candidate: (conversationId: string) => Promise<void>) {
      if (completed) {
        throw new Error("Conversation auxiliary recovery is already assembled");
      }
      recovery = candidate;
      completed = true;
    },
  });
}

/** Private one-shot seam for the committed-turn consumer construction cycle. */
export function createConversationCommittedTurnListenerAssemblyHandle(): Readonly<{
  readonly notify: (info: TurnCommittedInfo) => void;
  complete(listener: (info: TurnCommittedInfo) => void): void;
}> {
  let listener: ((info: TurnCommittedInfo) => void) | undefined;
  let completed = false;
  const notify = (info: TurnCommittedInfo): void => {
    if (!completed || !listener) {
      throw new Error("Conversation committed-turn listener is not assembled");
    }
    listener(info);
  };
  return Object.freeze({
    notify,
    complete(candidate: (info: TurnCommittedInfo) => void) {
      if (completed) {
        throw new Error("Conversation committed-turn listener is already assembled");
      }
      listener = candidate;
      completed = true;
    },
  });
}

class RetryableRunEndPreparation extends Error {
  constructor(error: unknown) { super("Run end preparation remains pending", { cause: error }); }
}

/** 本 Anchor 已提交收编的迁移：按会话精确定位，在首次触及该会话时装入，启动不遍历全部收编。 */
export interface CommittedConversationTransferPort {
  /** 该会话已提交（含已转出）的迁移编号，按编号排序。 */
  readonly committedFor: (conversationId: string) => Promise<readonly string[]>;
  /** 全部已提交收编的会话，供目录类列举。 */
  readonly conversations: () => Promise<readonly string[]>;
  readonly load: (transferId: string) => Promise<ConversationTransferPublication>;
}

/** Single-process production composition for the durable conversation protocol. */
export class ConversationProtocolRuntime implements DurableConversationTurnExecutor {
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #manager: () => ConversationManager;
  readonly #storedIdentityExists: ConversationProtocolRuntimeOptions["storedIdentityExists"];
  readonly #clock: () => string;
  #sessionState: SessionStatePort | undefined;
  readonly #executorDispatch: ConversationExecutorDispatchApplication;
  readonly #assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly #assignmentStaging: ConversationAssignmentStagingPort | undefined;
  readonly #issuer: ConversationAssignmentAuthority;
  readonly #journals = new Map<string, ConversationRunJournal>();
  readonly #unavailableTransfers = new Map<string, { transferId: string; error: Error }>();
  #committedTransfers: CommittedConversationTransferPort | undefined;
  readonly #adopting = new Map<string, Promise<void>>();
  readonly #adoptedConversations = new Map<string, {
    readonly transferId: string;
    readonly ownerEpoch: number;
    readonly source?: ConversationTransferPublication["source"];
    readonly clearId?: string;
    readonly clearedThroughLsn: number;
  }>();
  readonly #assignmentConversations = new Map<string, string>();
  readonly #assignmentIngress = new Map<string, IngressContext>();
  readonly #schedulingRuns = new Set<string>();
  readonly #scheduledRuns = new Set<string>();
  readonly #firstPartyPublishedFinals = new Set<string>();
  readonly #ownerPublishedFirstPartyFinals = new Set<string>();
  readonly #pendingFirstPartyFinals = new Set<string>();
  readonly #preparedAdmissions = new Map<string, PreparedConversationAdmission>();
  readonly #terminalOperations = new SerialTaskQueue();
  readonly #contexts: InProcessDispatchContextFactory;
  readonly #interactions: DurableConversationInteractionObserver;
  readonly #executeRecoveredPerspective:
    | ConversationProtocolRuntimeOptions["executeRecoveredPerspective"]
    | undefined;
  readonly #statusListeners = new Set<
    NonNullable<ConversationProtocolRuntimeOptions["onStatus"]>
  >();
  readonly #onFailure: ConversationProtocolRuntimeOptions["onFailure"];
  readonly #onStatus: ((notice: ConversationStatusNotice) => void | Promise<void>) | undefined;
  readonly #onFinal: ((frame: FinalFrame) => void | Promise<void>) | undefined;
  readonly #onFirstPartyStreamEnd: ConversationProtocolRuntimeOptions['onFirstPartyStreamEnd'];
  readonly #onPublishResult:
    | ((notice: PublishResultNotice) => void | Promise<void>)
    | undefined;
  readonly #onFirstPartyFrame: ConversationProtocolRuntimeOptions['onFirstPartyFrame'];
  readonly #onFirstPartyAssignment: ConversationProtocolRuntimeOptions['onFirstPartyAssignment'];
  #createFirstPartyFinality:
    | ConversationProtocolRuntimeOptions["createFirstPartyFinality"]
    | undefined;
  readonly #projectLifecycle:
    | ((input: DurableConversationSessionProjectionInput) => Promise<void>)
    | undefined;
  readonly #recoverAuxiliary: (conversationId: string) => Promise<void>;
  readonly #lifecycleProjectionClaims = new Map<string, Promise<number>>();
  readonly #activeRecoveryClaims = new Map<string, number>();
  /** 本进程仍在执行的 assignment → run；覆盖完整运行生命期，也用于取消后的本机止损。 */
  readonly #activeAssignmentClaims = new Map<string, string>();
  readonly #pendingConversationRetirements = new Set<string>();
  #deliveryDrain: (() => Promise<void>) | undefined;
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  // 控制准入基线（检查点恢复或整份归约）只做一次：首发与恢复后的后台预备共享进行中的任务。
  #controlBasis: Promise<void> | undefined;
  #pendingCancellationAfter: string | undefined;
  #recoveryRunning: Promise<number> | undefined;
  #readinessRecovery: Promise<number> | undefined;
  #recoveryStopped = false;
  /** 收束核对等稳定检查进行中：计时器到点不开新的一轮，只记下欠一轮。 */
  #recoveryPauses = 0;
  #recoveryDeferred = false;
  /** 当前循环的一次调度（startRecoveryLoop 设置）：暂停结束时据此补上欠下的一轮。 */
  #recoveryRun: (() => void) | undefined;
  #recoveryDiscovered = false;
  #recoveryDiscoveryAfter: string | undefined;
  #shutdownDraining = false;
  #recoveryGeneration = 0;
  readonly #recoveryConversations = new Map<string, number>();
  readonly #sessionIdentities = new Map<string, Promise<void>>();
  readonly #losslessDataPlane: ConversationLosslessDataPlaneTopology;
  #mutationPublisher: ConversationMutationPublisher | undefined;
  readonly #mutationPublisherProxy: ConversationMutationPublisher;
  readonly deferredIntentAuthority: DeferredIntentConversationAuthority;

  constructor(options: ConversationProtocolRuntimeOptions) {
    if ((options.authority === undefined) === (options.owner === undefined)) {
      throw new Error("Conversation protocol requires exactly one owner runtime");
    }
    const authority = options.owner ?? anchorConversationOwnerRuntime(options.authority!);
    const runtime = this;
    this.#mutationPublisherProxy = {
      get readProjectionIds() {
        return runtime.#mutationPublisher?.readProjectionIds ?? [];
      },
      collectStagedReferences: async (records) =>
        await this.#requiredMutationPublisher().collectStagedReferences?.(records) ?? [],
      decideGlobalBatchAtPrefix: (input) =>
        this.#requiredMutationPublisher().decideGlobalBatchAtPrefix(input),
      prepareGlobalBatchAtPrefix: async (input) => {
        const publisher = this.#requiredMutationPublisher();
        return await (publisher.prepareGlobalBatchAtPrefix?.(input) ??
          Promise.resolve(publisher.decideGlobalBatchAtPrefix(input))
            .then((outcomes) => ({ outcomes, records: [] })));
      },
      apply: (input) => this.#requiredMutationPublisher().apply(input),
    };
    this.#authority = authority;
    this.#manager = options.manager;
    this.#storedIdentityExists = options.storedIdentityExists;
    const protocol = this;
    this.deferredIntentAuthority = Object.freeze({
      async transact<Value>(input: DeferredIntentConversationTransaction<Value>) {
        await protocol.#adopt(input.conversationId);
        return protocol.#journal(input.conversationId).transactDeferredIntent(input);
      },
    });
    this.#clock = options.clock ?? (() => new Date().toISOString());
    if (!options.executorDispatch) {
      throw new Error("Conversation protocol requires the executor dispatch application");
    }
    if (!options.assignmentArtifactAuthority) {
      throw new Error("Conversation protocol requires assignment artifact authority");
    }
    this.#executorDispatch = options.executorDispatch;
    this.#assignmentArtifactAuthority = options.assignmentArtifactAuthority;
    this.#assignmentStaging = options.assignmentStaging;
    if (options.losslessDataPlane.kind === "available") {
      if (!options.losslessDataPlane.port) {
        throw new Error("Conversation protocol requires the lossless data plane");
      }
      this.#losslessDataPlane = Object.freeze({
        kind: "available",
        port: options.losslessDataPlane.port,
      });
    } else if (options.losslessDataPlane.reason === "executor-only") {
      this.#losslessDataPlane = Object.freeze({
        kind: "absent",
        reason: "executor-only",
      });
    } else {
      throw new Error("Conversation protocol received an invalid data-plane topology");
    }
    this.#interactions = options.interactions;
    this.#executeRecoveredPerspective = options.executeRecoveredPerspective;
    this.#onFailure = options.onFailure;
    this.#onStatus = options.onStatus;
    this.#onFinal = options.onFinal;
    this.#onPublishResult = options.onPublishResult;
    this.#onFirstPartyFrame = options.onFirstPartyFrame;
    this.#onFirstPartyAssignment = options.onFirstPartyAssignment;
    this.#onFirstPartyStreamEnd = options.onFirstPartyStreamEnd;
    this.#createFirstPartyFinality = options.createFirstPartyFinality;
    this.#projectLifecycle = options.projectLifecycle;
    if (!options.recoverAuxiliary) {
      throw new Error("Conversation protocol requires auxiliary recovery");
    }
    this.#recoverAuxiliary = options.recoverAuxiliary;
    this.#issuer = new ConversationAssignmentAuthority({
      signer: authority.signer,
      verifier: authority.verifier,
      snapshotFor: (executorId) =>
        authority.executorCapabilities.snapshotFor(executorId),
      clock: this.#clock,
    });
    this.#contexts = createDispatchContexts({
      signer: authority.signer,
      deviceId: authority.deviceId,
      ownerEpochFor: (assignmentId) =>
        this.#ownerEpochFor(this.#conversationForAssignment(assignmentId)),
      anchorEpochFor: () => this.#authority.domain.kind === 'anchor' ? this.#authority.domain.anchorEpoch : undefined,
      assertSigningAuthority: (_id, tenure) => this.#assertControlSigningTenure(tenure),
      clock: this.#clock,
      conversationIdFor: (assignmentId) =>
        this.#conversationForAssignment(assignmentId),
    });
  }

  bindMutationPublisher(publisher: ConversationMutationPublisher): () => void {
    if (!this.#authority.globalPublishing) {
      throw new Error("Local conversation owners cannot bind global mutation publishing");
    }
    if (this.#mutationPublisher && this.#mutationPublisher !== publisher) {
      throw new Error("Conversation mutation publisher is already bound");
    }
    this.#mutationPublisher = publisher;
    return () => {
      if (this.#mutationPublisher === publisher) {
        this.#mutationPublisher = undefined;
      }
    };
  }

  /** 绑定本 Anchor 的已提交收编来源；之后收编会话在首次触及时按键装入。返回解绑函数。 */
  bindCommittedConversationTransfers(port: CommittedConversationTransferPort): () => void {
    if (this.#committedTransfers && this.#committedTransfers !== port) {
      throw new Error("Committed conversation transfers are already bound");
    }
    this.#committedTransfers = port;
    return () => {
      if (this.#committedTransfers === port) this.#committedTransfers = undefined;
    };
  }

  #needsAdoption(conversationId: string): boolean {
    return this.#committedTransfers !== undefined &&
      !this.#authority.acceptsConversationId(conversationId) &&
      !this.#adoptedConversations.has(conversationId) &&
      !this.#unavailableTransfers.has(conversationId) &&
      !!parseLocalConversationId(conversationId);
  }

  /**
   * 收编会话按键就地装入：读这个会话已提交的迁移并安装基线，与原先启动时逐个安装的顺序与校验相同；
   * 来源证据缺失按已提交缺证隔离保留。同一会话的并发触及共享一次装入；不是收编会话则什么也不做。
   */
  #adopt(conversationId: string): Promise<void> {
    if (!this.#needsAdoption(conversationId)) return Promise.resolve();
    let adopting = this.#adopting.get(conversationId);
    if (!adopting) {
      adopting = this.#installAdoption(conversationId).finally(() => this.#adopting.delete(conversationId));
      this.#adopting.set(conversationId, adopting);
    }
    return adopting;
  }

  async #installAdoption(conversationId: string): Promise<void> {
    const port = this.#committedTransfers!;
    for (const transferId of await port.committedFor(conversationId)) {
      // 现场提交已装入同一代际时不再替换它的日志视图
      if (this.#adoptedConversations.get(conversationId)?.transferId === transferId && !this.#unavailableTransfers.has(conversationId)) continue;
      let publication: ConversationTransferPublication;
      try {
        publication = await port.load(transferId);
      } catch (error) {
        if (!isConversationSourceEvidenceError(error)) throw error;
        await this.retainUnavailableCommittedConversationTransfer(transferId, error as Error);
        continue;
      }
      const prepared = await this.prepareCommittedConversationTransfer({ manifest: publication.manifest, source: publication.source });
      if (this.#adoptedConversations.get(conversationId)?.transferId === transferId && !this.#unavailableTransfers.has(conversationId)) continue;
      prepared.publish();
    }
  }

  /** Installs a committed immutable source prefix before exposing the adopted session. */
  async retainUnavailableCommittedConversationTransfer(transferId: string, error: Error): Promise<void> {
    const { state } = await readCommittedConversationTransferHeader(this.#authority.authorityLog, this.#authority.verifier, transferId);
    const id = state.identity.conversationId;
    const owner = await resolveCurrentConversationAuthority(this.#authority.authorityLog, this.#authority.verifier, id,
      { deviceId: this.#authority.deviceId, ownerEpoch: this.#authority.ownerEpoch });
    if (owner.state !== 'current' || owner.deviceId !== this.#authority.deviceId) throw new TypeError('Unavailable transfer belongs to another current owner');
    this.#adoptedConversations.set(id, { transferId, ownerEpoch: owner.ownerEpoch, clearedThroughLsn: 0 });
    this.#unavailableTransfers.set(id, { transferId, error });
    this.#journals.delete(id); this.#markRecovery(id);
    this.#observeFailure(error, { phase: 'recovery', conversationId: id });
  }

  async installCommittedConversationTransfer(input:
    { readonly manifest: ConversationTransferPublication["manifest"]; readonly source: ConversationTransferPublication["source"] }): Promise<void> {
    const prepared = await this.prepareCommittedConversationTransfer(input);
    prepared.publish();
  }

  /**
   * Performs every fallible read/reduction before the owner switch. Publishing
   * the returned token only swaps already-built in-memory views and cannot do I/O.
   */
  async prepareCommittedConversationTransfer(input:
    { readonly manifest: ConversationTransferPublication["manifest"]; readonly source: ConversationTransferPublication["source"] }): Promise<{ readonly publish: () => void }> {
    const owner = await resolveConversationPublicationOwner(this.#authority.authorityLog, this.#authority.verifier,
      input.manifest, input.source.manifestRef, this.#authority.deviceId);
    const conversationId = input.manifest.conversationId;
    const existing = this.#adoptedConversations.get(conversationId);
    if (
      existing &&
      (existing.transferId !== input.manifest.transferId ||
        existing.ownerEpoch > owner.ownerEpoch)
    ) {
      throw new Error("Conversation already has another committed transfer generation");
    }
    const journal = this.#createJournal(conversationId, owner.ownerEpoch);
    {
      const meta = await input.source.read(view => view.get('directory/' + JSON.stringify(conversationId) + ':meta')) as
        | { readonly clearId?: string; readonly clearedLsn?: number }
        | undefined;
      const adopted = {
        transferId: input.manifest.transferId,
        ownerEpoch: owner.ownerEpoch,
        source: input.source,
        clearId: meta?.clearId,
        clearedThroughLsn: meta?.clearedLsn ?? 0,
      };
      await journal.installImportedBase(input.source);
      return Object.freeze({
        publish: () => {
          this.#unavailableTransfers.delete(conversationId);
          this.#adoptedConversations.set(conversationId, adopted);
          this.#journals.set(conversationId, journal);
          this.#sessionIdentities.set(conversationId, Promise.resolve());
          this.#markRecovery(conversationId);
        },
      });
    }
  }

  assignmentIngress(assignmentId: string): IngressContext {
    const ingress = this.#assignmentIngress.get(assignmentId);
    if (!ingress) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return structuredClone(ingress);
  }

  conversationIdForAssignment(assignmentId: string): string {
    return this.#conversationForAssignment(assignmentId);
  }

  assignmentCapability(assignmentId: string): AuthorityCapability {
    return this.#assignmentArtifactAuthority.read(assignmentId).capability;
  }

  async assignmentArtifactAuthority(assignmentId: string): Promise<{
    readonly capability: AuthorityCapability<"conversation">;
    readonly activation: AssignmentActivationProof<"conversation">;
  }> {
    return this.#assignmentArtifactAuthority.read(assignmentId);
  }

  submissionMeshRole(): {
    readonly submission: RunSubmissionPort;
    readonly submissionGuard: AssignmentSubmissionPreflightPort;
  } {
    const journalFor = async (context: AuthorityCallContext) => {
      const conversationId = conversationIdFromSubmissionContext(context);
      await this.#adopt(conversationId);
      return this.#journal(conversationId);
    };
    return {
      submission: {
        reportStarted: async (assignmentId, context) =>
          (await journalFor(context)).reportStarted(assignmentId, context),
        submitBundle: async (bundle, context) =>
          (await journalFor(context)).submitBundle(bundle, context),
        submitCancelProof: async (assignmentId, proof, context) =>
          (await journalFor(context)).submitCancelProof(assignmentId, proof, context),
        mirrorInteractions: async (assignmentId, batch, context) =>
          (await journalFor(context)).mirrorInteractions(
            assignmentId,
            asConversationMirrorBatch(batch),
            context,
          ),
      },
      submissionGuard: {
        preflightSubmission: async (
          context: AuthorityCallContext,
          identity: AssignmentSubmissionIdentity,
        ) => (await journalFor(context)).preflightSubmission(context, identity),
      },
    };
  }

  /** Joined once after the status sources exist, before public consumers open. */
  bindFirstPartyFinality(
    factory: NonNullable<ConversationProtocolRuntimeOptions["createFirstPartyFinality"]>,
  ): void {
    if (this.#createFirstPartyFinality) {
      throw new Error("First-party finality is already bound");
    }
    this.#createFirstPartyFinality = factory;
  }

  onStatus(
    listener: NonNullable<ConversationProtocolRuntimeOptions["onStatus"]>,
  ): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  bindDeliveryDrain(drain: () => Promise<void>): void {
    this.#deliveryDrain = drain;
  }

  /** Fences recovery from scheduling new provider work while durable shutdown drains. */
  beginShutdownDrain(): void {
    this.#shutdownDraining = true;
  }

  /** Reopens recovery scheduling after the exact durable lifecycle owner released its gate. */
  resumeAfterShutdownDrain(): void {
    this.#shutdownDraining = false;
  }

  startRecoveryLoop(intervalMs = 5_000): void {
    if (this.#recoveryTimer || this.#recoveryRunning) return;
    this.#recoveryStopped = false;
    const run = () => {
      if (this.#recoveryStopped) return;
      if (this.#recoveryPauses > 0) {
        this.#recoveryDeferred = true;
        return;
      }
      const active = this.recover();
      this.#recoveryRunning = active;
      void active.catch(() => 0).finally(() => {
        if (this.#recoveryRunning === active) this.#recoveryRunning = undefined;
        if (!this.#recoveryStopped) {
          this.#recoveryTimer = setTimeout(() => {
            this.#recoveryTimer = undefined;
            run();
          }, intervalMs);
          this.#recoveryTimer.unref?.();
        }
      });
    };
    this.#recoveryRun = run;
    run();
  }

  /**
   * 稳定检查边界：期间不发起新的一轮恢复，先等正在跑的一轮结束，再执行 operation。
   * 结束时若欠下一轮、循环没有被停止、也没有计时器或在跑的一轮，就补上这一轮；循环已停（停止、
   * 关闭、生命周期接管）则不重启。不持任何日志或领域锁等待，只在排他段外调用。
   */
  async whileRecoveryPaused<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.#recoveryPauses += 1;
    try {
      await this.#recoveryRunning?.catch(() => 0);
      return await operation();
    } finally {
      this.#recoveryPauses -= 1;
      if (this.#recoveryPauses === 0 && this.#recoveryDeferred) {
        this.#recoveryDeferred = false;
        if (!this.#recoveryStopped && !this.#recoveryTimer && !this.#recoveryRunning) this.#recoveryRun?.();
      }
    }
  }

  async stopRecoveryLoop(): Promise<void> {
    this.#recoveryStopped = true;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    await this.#recoveryRunning?.catch(() => 0);
    await this.#controlBasis?.catch(() => undefined);
  }

  async recoverReadinessProjections(): Promise<number> {
    if (this.#readinessRecovery) return this.#readinessRecovery;
    const active = this.#recoverReadinessProjections();
    this.#readinessRecovery = active;
    try {
      return await active;
    } catch (error) {
      if (this.#readinessRecovery === active) this.#readinessRecovery = undefined;
      throw error;
    }
  }

  /** Rebuilds every recovery-derived view after a planned authority-base install. */
  async recoverInstalledAuthority(): Promise<number> {
    await this.stopRecoveryLoop();
    await this.#readinessRecovery?.catch(() => 0);
    await Promise.all(
      [...this.#lifecycleProjectionClaims.values()].map((claim) => claim.catch(() => 0)),
    );
    if (this.#activeRecoveryClaims.size > 0) {
      throw new Error("Installed authority recovery still has active prior-generation claims");
    }

    this.#recoveryGeneration += 1;
    this.#readinessRecovery = undefined;
    this.#recoveryDiscovered = false;
    this.#recoveryDiscoveryAfter = undefined;
    this.#recoveryConversations.clear();
    this.#journals.clear();
    this.#adoptedConversations.clear();
    this.#unavailableTransfers.clear();
    this.#sessionIdentities.clear();
    for (const assignmentId of [...this.#assignmentConversations.keys()]) {
      this.#forgetAssignment(assignmentId);
    }
    this.#schedulingRuns.clear();
    this.#scheduledRuns.clear();
    this.#firstPartyPublishedFinals.clear();
    this.#ownerPublishedFirstPartyFinals.clear();
    this.#pendingFirstPartyFinals.clear();
    this.#preparedAdmissions.clear();
    this.#pendingConversationRetirements.clear();
    this.#shutdownDraining = false;
    this.#recoveryStopped = false;

    const discovered = await this.recoverReadinessProjections();
    const recovered = await this.recover();
    this.startRecoveryLoop();
    return discovered + recovered;
  }

  controlPrincipal(input: {
    readonly surfacePrincipal: string;
    readonly connectionId: string;
  }) {
    return {
      ...input,
      deviceId: this.#authority.deviceId,
    };
  }

  releaseConversation(conversationId: string): void {
    // Grace/idle eviction only drops a rebuildable journal projection. Durable
    // recovery generations, capabilities and scheduler claims have independent
    // owners and must survive ordinary cache eviction.
    this.#journals.delete(conversationId);
    this.#sessionIdentities.delete(conversationId);
  }

  /** 远端执行方仍通过当前 Owner 消费输入；设备身份须匹配已分配的执行者。 */
  async remoteRunInput(address: { conversationId: string; runId: string; assignmentId: string }, executorId: string) {
    await this.#adopt(address.conversationId);
    const journal = this.#journal(address.conversationId);
    await journal.assertInputExecutor(address.runId, address.assignmentId, executorId);
    return {
      open: () => journal.openRunInput(address.runId, address.assignmentId).then(() => undefined),
      receive: (boundary: { boundary: number; closing: boolean }) => journal.receiveRunInput(address.runId, address.assignmentId, boundary),
      close: () => journal.closeRunInput(address.runId, address.assignmentId),
    };
  }

  /** 对话应用的只读消息投影；查询不会创建会话或启动运行。 */
  async inspectMessage(conversationId: string, messageId: string) {
    if (!(await this.sessionExists(conversationId))) return undefined;
    return this.#journal(conversationId).messageStatus(messageId);
  }

  async messageInputsOutsideHistory(conversationId: string) {
    if (!(await this.sessionExists(conversationId))) return { inputs: [], truncated: false };
    return this.#journal(conversationId).messageInputsOutsideHistory();
  }

  async recoveryPage(request: import('@zhixing/core/contracts').ConversationRecoveryRequest) {
    const id = request.conversationId;
    await this.#adopt(id);
    if (!this.#acceptsConversationId(id)) throw Error('Conversation recovery owner is unavailable');
    // Empty legacy conversations already have a stored identity before their
    // first authority write. Reading them must neither create facts nor replay
    // every historical body. A durable deletion always wins over stored files.
    const exists = this.#adoptedConversations.has(id) ||
      await this.#authority.controlAdmission.hasCreatedConversation(id) ||
      (await this.#storedIdentityExists?.(id)) === true;
    if (!exists || await this.#journal(id).recoveryDeleted()) throw Error('Conversation recovery owner is unavailable');
    return this.#journal(request.conversationId).recoveryPage(request);
  }

  /**
   * Establishes the owner-routed conversation identity before any dependent fact.
   * The deterministic request is the sole creation identity, so response loss and
   * concurrent activation replay the original authority decision.
   */
  ensureSession(conversationId: string): Promise<void> {
    if (this.#needsAdoption(conversationId)) {
      return this.#adopt(conversationId).then(() => this.#ensureAcceptedSession(conversationId));
    }
    return this.#ensureAcceptedSession(conversationId);
  }

  #ensureAcceptedSession(conversationId: string): Promise<void> {
    if (!this.#acceptsConversationId(conversationId)) {
      return Promise.reject(
        new Error("Conversation identity does not belong to this owner domain"),
      );
    }
    const existing = this.#sessionIdentities.get(conversationId);
    if (existing) return existing;
    const establishing = this.#establishSession(conversationId);
    this.#sessionIdentities.set(conversationId, establishing);
    void establishing.catch(() => {
      if (this.#sessionIdentities.get(conversationId) === establishing) {
        this.#sessionIdentities.delete(conversationId);
      }
    });
    return establishing;
  }

  async admit(
    input: DurableConversationAdmissionInput,
  ): Promise<DurableConversationAdmissionResult> {
    const key = admissionKey(input);
    if (!key) {
      throw new Error("Durable conversation admission requires a stable turn id");
    }
    const admission = await this.#applyInputAdmission(input);
    // New user input also invalidates unconsumed continuations from older runs.
    this.#markRecovery(input.conversationId);
    let state: Awaited<ReturnType<ConversationRunJournal["runState"]>> = "queued";
    if (admission.replayed || input.options?.turnContext?.turnOrigin?.messageIdentity) {
      try {
        state = await this.#journal(input.conversationId).runState(admission.runId);
      } catch {
        this.#markRecovery(input.conversationId);
        return { runId: admission.runId, shouldSchedule: false };
      }
    }
    const shouldSchedule =
      state === "queued" &&
      !this.#schedulingRuns.has(admission.runId) &&
      !this.#scheduledRuns.has(admission.runId) &&
      await this.#mayScheduleInput(input.conversationId, admission.runId);
    if (shouldSchedule) {
      this.#schedulingRuns.add(admission.runId);
      this.#preparedAdmissions.set(key, {
        conversationId: input.conversationId,
        surfacePrincipal: admission.ingress.surfacePrincipal,
        admission,
        input: normalizeUserTurnInput(input.input),
        attachments: [...(input.attachments ?? [])],
        invocation: input.invocation,
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
      });
      this.#markRecovery(input.conversationId);
    }
    return { runId: admission.runId, shouldSchedule };
  }

  confirmScheduled(conversationId: string, runId: string): void {
    const prepared = [...this.#preparedAdmissions.values()].find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.admission.runId === runId,
    );
    if (!prepared && !this.#scheduledRuns.has(runId)) return;
    this.#schedulingRuns.delete(runId);
    this.#scheduledRuns.add(runId);
  }

  deferScheduling(conversationId: string, runId: string): void {
    this.#clearRunClaims(runId);
    this.#markRecovery(conversationId);
  }

  async cancelAdmitted(conversationId: string, runId: string): Promise<void> {
    const request = {
      runId,
      requestId: `cancel:pending:${runId}`,
    };
    await this.#adopt(conversationId);
    const journal = this.#journal(conversationId);
    try {
      await this.#terminalOperations.run(() =>
        this.#driveCancellation(journal, request)
      );
      this.#clearRunClaims(runId);
      this.#markRecovery(conversationId);
      this.#kickDelivery();
    } catch (firstError) {
      this.#markRecovery(conversationId);
      try {
        await this.#terminalOperations.run(() =>
          this.#driveCancellation(journal, request)
        );
        this.#clearRunClaims(runId);
        this.#markRecovery(conversationId);
        this.#kickDelivery();
      } catch (replayError) {
        throw new AggregateError(
          [firstError, replayError],
          "Conversation scheduler cancellation could not determine its durable disposition",
        );
      }
    }
  }

  async findRunByIngress(
    conversationId: string,
    ingressId: string,
    source: ConversationInvocation["source"],
  ) {
    await this.#adopt(conversationId);
    return this.#journal(conversationId).runByIngress(ingressId, source);
  }

  async findInteractionOutcome(conversationId: string, requestId: string) {
    await this.#adopt(conversationId);
    return this.#journal(conversationId).interactionOutcome(requestId);
  }

  async touchWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string }> {
    await this.ensureSession(input.conversationId);
    const { conversationId, ...activity } = input;
    return this.#journal(conversationId).touchWorksceneSession(activity);
  }

  deleteWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<
    { readonly revision: number; readonly at: string } | undefined
  > {
    const { conversationId, ...activity } = input;
    return this.#adopt(conversationId).then(() => this.#journal(conversationId).deleteWorksceneSession(activity));
  }

  async cancel(
    input: DurableConversationCancelInput,
  ): Promise<DurableConversationCancellationResult> {
    // Freeze the complete control identity across transient capacity retries.
    // Re-enter only after the serial owner and recovery claim have unwound;
    // replay reads the original durable batch, never a new candidate set.
    input = structuredClone(input);
    await this.#adopt(input.conversationId);
    const source = { principal: { ...input.principal } };
    const localResults = new Map<string, ReturnType<ConversationManager["applyDurableCancellation"]>>();
    const applyLocal = (runId: string) => {
      let result = localResults.get(runId);
      if (!result) {
        result = this.#stopAppliedCancellation(input.conversationId, runId, input.reason);
        localResults.set(runId, result);
      }
      return result;
    };
    const control = {
      admission: this.#authority.controlAdmission,
      source,
      envelope: createConversationControlEnvelope({
        requestId: input.requestId,
        source,
        at: this.#clock(),
        body: input.runId ? {
          t: "cancel", conversationId: input.conversationId, runId: input.runId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
        } : {
          t: "cancel-batch", conversationId: input.conversationId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
          ...(input.response ? { response: { replyTarget: { ...input.response.replyTarget } } } : {}),
        },
      }),
    };
    try { return await retryControlAdmission(
      () => this.#terminalOperations.run(() => {
        // The request can expire while queued behind a different owner operation.
        if (currentMaintenanceAbortSignal().aborted) throw new StorageMaintenanceCancelledError();
        return this.#withRecoveryClaim(input.conversationId, () => this.#cancelInternal(input, control, applyLocal));
      }),
      async () => {},
    ); } catch (error) {
      if (maintenanceRetryDelayMs(error) === undefined) throw error;
      // This does not extend the foreground retry window or claim a stop.
      // Only an exact durable receipt may return "received"; the existing
      // recovery owner discovers and applies that obligation after restart.
      const receipt = await this.#authority.controlAdmission.lookup({ source, envelope: control.envelope });
      if (receipt.kind !== "received-pending") throw error;
      this.#markRecovery(input.conversationId);
      return { dispositions: [], receivedPending: true };
    }
  }

  #stopAppliedCancellation(conversationId: string, runId: string, reason?: DurableConversationCancelInput["reason"]) {
    const result = this.#requiredManager().applyDurableCancellation(conversationId, runId, reason);
    for (const [assignmentId, activeRunId] of this.#activeAssignmentClaims) {
      if (activeRunId === runId) this.#executorDispatch.stopLocalExecution(assignmentId);
    }
    return result;
  }

  async #recoverReceivedCancellations(): Promise<number> {
    const page = await this.#authority.controlAdmission.pendingCancellations(this.#pendingCancellationAfter);
    this.#pendingCancellationAfter = page.after;
    return this.#applyReceivedCancellations(page.envelopes);
  }

  async #settleTargetCancellations(conversationId: string, runId: string): Promise<boolean> {
    const target = { conversationId, runId };
    const page = await this.#authority.controlAdmission.pendingCancellations(undefined, target);
    if (page.envelopes.length === 0) return true;
    await this.#applyReceivedCancellations(page.envelopes);
    // One bounded page per turn. Remaining or failed requests keep only this
    // target deferred; a later pass continues without scanning other targets.
    const remaining = await this.#authority.controlAdmission.pendingCancellations(undefined, target);
    if (remaining.envelopes.length === 0) return true;
    this.#markRecovery(conversationId);
    return false;
  }

  async #applyReceivedCancellations(envelopes: readonly import("@zhixing/owner-kernel/control-admission").ConversationControlEnvelope[]): Promise<number> {
    let count = 0;
    for (const envelope of envelopes) {
      const body = envelope.body;
      if (body.t !== "cancel" && body.t !== "cancel-batch") continue;
      await this.#adopt(body.conversationId);
      if (!this.#acceptsConversationId(body.conversationId)) continue;
      if (this.#recoveryStopped) break;
      try { await this.#terminalOperations.run(() => this.#withRecoveryClaim(body.conversationId, async () => {
        const journal = this.#journal(body.conversationId);
        const outcome = await this.#applyAuthorityControl(body.conversationId, journal, {
          admission: this.#authority.controlAdmission, envelope, source: { principal: envelope.principal },
        }, true);
        if (outcome.kind === "rejected" || outcome.result.status !== "ok") return;
        const applied = outcome.result.body;
        const runs = applied.t === "cancel" && body.t === "cancel"
          ? [{ runId: body.runId, runState: applied.runState }]
          : applied.t === "cancel-batch" ? applied.runs : [];
        for (const run of runs) {
          this.#stopAppliedCancellation(body.conversationId, run.runId, { kind: "external", origin: "durable-control-recovery" });
          this.#clearRunClaims(run.runId);
        }
        this.#markRecovery(body.conversationId); this.#kickDelivery();
        if (runs.some(run => run.runState === "cancel-requested")) await this.#continueAppliedCancellations(journal);
        count++;
      })); } catch (error) {
        // Preserve the exact durable obligation and report the actual failure;
        // one unavailable conversation must not suppress the rest of this page.
        this.#markRecovery(body.conversationId);
        this.#observeFailure(error, { phase: "recovery", conversationId: body.conversationId });
      }
    }
    return count;
  }

  async #cancelInternal(
    input: DurableConversationCancelInput,
    control: Parameters<ConversationRunJournal["applyControl"]>[0],
    applyLocal: (runId: string) => ReturnType<ConversationManager["applyDurableCancellation"]>,
  ): Promise<DurableConversationCancellationResult> {
    const journal = this.#journal(input.conversationId);
    if (!input.runId) return this.#cancelBatch(input, journal, control, applyLocal);
    const candidate = await journal.runControlDescriptor(input.runId);
    if (!candidate) return { dispositions: [] };
    const runId = candidate.runId;
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, control, true);
    if (outcome.kind === "rejected") {
      throw new Error(
        `Conversation cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.status === "rejected") {
      throw new Error(
        `Conversation cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.body.t !== "cancel") {
      throw new Error("Conversation cancellation returned another control result");
    }
    const local = applyLocal(runId);
    this.#clearRunClaims(runId);
    this.#markRecovery(input.conversationId);
    this.#kickDelivery();
    if (outcome.result.body.runState === "cancel-requested") {
      await this.#continueAppliedCancellations(journal);
    }
    return {
      dispositions: [
        {
          runId,
          runState: outcome.result.body.runState,
          source: candidate.source,
          ingressId: candidate.ingressId,
          ...local,
        },
      ],
    };
  }

  /**
   * 批量取消是一个以外层 requestId 线性化的权威决定:候选集在 apply 时刻
   * 由 owner 以单源谓词冻结,重放消费 applied 原批次、零重新枚举;本地
   * 止损按耐久结果逐 run 幂等执行。空批次的用户回执由同一决定的
   * delivery companion 承担,runtime 只负责唤醒投递。
   */
  async #cancelBatch(
    input: DurableConversationCancelInput,
    journal: ConversationRunJournal,
    control: Parameters<ConversationRunJournal["applyControl"]>[0],
    applyLocal: (runId: string) => ReturnType<ConversationManager["applyDurableCancellation"]>,
  ): Promise<DurableConversationCancellationResult> {
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, control, true);
    if (outcome.kind === "rejected") {
      throw new Error(
        `Conversation batch cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.status === "rejected") {
      throw new Error(
        `Conversation batch cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.body.t !== "cancel-batch") {
      throw new Error(
        "Conversation batch cancellation returned another control result",
      );
    }
    const dispositions: DurableConversationCancellationDisposition[] = [];
    for (const run of outcome.result.body.runs) {
      const local = applyLocal(run.runId);
      this.#clearRunClaims(run.runId);
      dispositions.push({
        runId: run.runId,
        runState: run.runState,
        source: run.source,
        ingressId: run.ingressId,
        ...local,
      });
    }
    this.#markRecovery(input.conversationId);
    this.#kickDelivery();
    if (outcome.result.body.runs.some((run) => run.runState === "cancel-requested")) {
      await this.#continueAppliedCancellations(journal);
    }
    return { dispositions };
  }

  async resolveUncertain(
    input: DurableConversationResolveInput,
  ): Promise<DurableConversationResolutionResult> {
    const source = { principal: { ...input.principal } };
    await this.#adopt(input.conversationId);
    const journal = this.#journal(input.conversationId);
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, {
      admission: this.#authority.controlAdmission,
      envelope: createConversationControlEnvelope({
        requestId: input.requestId,
        source,
        at: this.#clock(),
        body: {
          t: "uncertain-resolve",
          ref: {
            execution: "conversation",
            conversationId: input.conversationId,
            runId: input.runId,
            ownerEpoch: input.ownerEpoch,
          },
          openFactDigest: input.openFactDigest,
          decision: input.decision,
        },
      }),
      source,
    });
    if (outcome.kind === "rejected") {
      throw new Error(`Conversation resolution was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.status === "rejected") {
      throw new Error(`Conversation resolution was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.body.t !== "uncertain-resolve") {
      throw new Error("Conversation resolution returned another control result");
    }
    const result = {
      state: outcome.result.body.state,
      factDigest: outcome.result.body.factDigest,
    };
    this.#markRecovery(input.conversationId);
    this.#kickDelivery();
    if (result.state === "queued") {
      try {
        if ((await journal.runState(input.runId)) === "queued") {
          await this.#scheduleResolvedRetry(input.conversationId, input.runId, journal);
        }
      } catch {
        // The resolution is authoritative. Its recovery generation owns any
        // scheduler admission or projection that did not finish in this call.
        this.#markRecovery(input.conversationId);
      }
    }
    return result;
  }

  async writeSession(
    input: DurableConversationSessionWriteInput,
  ): Promise<DurableConversationSessionWriteResult> {
    await this.#adopt(input.conversationId);
    const journal = this.#journal(input.conversationId);
    const lifecycleMutation =
      input.mutation.kind === "conversation-delete" ||
      (input.mutation.kind === "window-op" && input.mutation.op === "clear");
    const existingLifecycle = lifecycleMutation
      ? await journal.lifecycleRequest(input.requestId)
      : undefined;
    const existingMutation = lifecycleMutation
      ? undefined
      : await journal.sessionMutationRequest(input.requestId);
    const existing = existingLifecycle ?? existingMutation;
    const authority = existing ? undefined : await journal.authorityState();
    if (
      !existing &&
      !authority!.hasDurableIdentity &&
      !(await input.conversationExists())
    ) {
      return { status: "not-found" };
    }
    const domainRevision = existing
      ? existing.domainRevision - 1
      : authority!.domainRevision;
    const source = { principal: { ...input.principal } };
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, {
      admission: this.#authority.controlAdmission,
      envelope: createConversationControlEnvelope({
        requestId: input.requestId,
        source,
        at: this.#clock(),
        body: {
          t: "session-write",
          conversationId: input.conversationId,
          mutation: input.mutation,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
          domainRevision,
        },
      }),
      source,
    });
    if (outcome.kind === "rejected") {
      throw new Error(`Session write was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.status === "rejected") {
      if (
        outcome.result.error.code === "busy" ||
        outcome.result.error.code === "revision-conflict"
      ) {
        return { status: "busy" };
      }
      if (outcome.result.error.code === "not-found") {
        return { status: "not-found" };
      }
      throw new Error(`Session write was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.body.t !== "session-write") {
      throw new Error("Session write returned another control result");
    }
    if (lifecycleMutation) this.#markRecovery(input.conversationId);
    return {
      status: "accepted",
      domainRevision: outcome.result.body.revision,
    };
  }

  async projectSession(
    input: DurableConversationSessionProjectionInput,
  ): Promise<void> {
    await this.#adopt(input.conversationId);
    const journal = this.#journal(input.conversationId);
    const fact = await journal.lifecycleRequest(input.requestId);
    if (
      !fact ||
      fact.conversationId !== input.conversationId ||
      fact.mutation !== input.mutation ||
      fact.domainRevision !== input.domainRevision
    ) {
      throw new Error("Lifecycle projection does not bind its durable authority fact");
    }
    await this.#resumeLifecycleProjections(input.conversationId, journal);
  }

  async *run(input: DurableConversationTurnInput): AsyncGenerator<AgentYield, RunResult> {
    const preparedKey = admissionKey(input);
    const prepared = preparedKey
      ? this.#preparedAdmissions.get(preparedKey)
      : undefined;
    if (
      prepared &&
      (canonicalize(prepared.input) !==
        canonicalize(normalizeUserTurnInput(input.input)) ||
        canonicalize(prepared.attachments) !==
          canonicalize(input.attachments ?? []) ||
        canonicalize(prepared.invocation) !== canonicalize(input.invocation) ||
        canonicalize(prepared.environment ?? null) !==
          canonicalize(input.environment ?? null))
    ) {
      throw new Error("Prepared conversation admission does not bind this invocation");
    }
    const appliedAdmission =
      prepared?.admission ?? await this.#applyInputAdmission(input, true);
    const requestId = inputControlRequestId(appliedAdmission.ingress);
    const journal = this.#journal(input.conversationId);
    const runId = appliedAdmission.runId;
    if (this.#schedulingRuns.has(runId)) {
      this.confirmScheduled(input.conversationId, runId);
    } else {
      this.#scheduledRuns.add(runId);
    }
    if (preparedKey) this.#preparedAdmissions.delete(preparedKey);
    let executionIngress = appliedAdmission.ingress;
    if (appliedAdmission.replayed) {
      const committed = await journal.committedRun(runId);
      if (committed) {
        this.#clearRunClaims(runId);
        return replayCommittedRun(committed.runRecord, committed.windowCompact);
      }
      const replayedState = await journal.runState(runId);
      if (replayedState !== "queued") {
        throw new Error(
          `Conversation input ${requestId} already resolved to run ${runId} in state ${replayedState ?? "unknown"}`,
        );
      }
      const pending = (await journal.pendingInputs()).find(
        (candidate) => candidate.runId === runId,
      );
      if (!pending) {
        throw new Error(`Queued conversation run ${runId} has no durable input`);
      }
      executionIngress = pending.ingress;
    }
    const executionMessages = input.messages.map((message, index) =>
      index === input.messages.length - 1 && message.role === "user" && executionIngress.turnOrigin?.messageIdentity
        ? { ...message, inputIdentity: structuredClone(executionIngress.turnOrigin.messageIdentity) }
        : message);
    const attempt = await journal.nextAssignmentAttempt(runId);
    const assignmentId = conversationAssignmentId(runId, attempt);
    this.#activeAssignmentClaims.set(assignmentId, runId);
    let channelSession: LosslessDataPlaneSession | undefined;
    let firstPartySurfaceSession: FirstPartySurfaceSession | undefined;
    let firstPartyFinalitySession: FirstPartyFinalitySession | undefined;
    let firstPartyStreamFinalSeq: number | undefined;
    const drainFirstPartyProjection = (finalSeq: number, finalIdentity?: string) => {
      const surface = firstPartySurfaceSession, finality = firstPartyFinalitySession;
      if (!surface) return;
      firstPartySurfaceSession = undefined; firstPartyFinalitySession = undefined;
      // Keep the authenticated consumer alive for its verified terminal frame.
      // Do not hold the execution/terminal owner while waiting: cancellation
      // proof and stream reclamation must still be able to finish independently.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error("Conversation stream tail drain timed out")), 5_000);
      timer.unref?.();
      const close = async () => {
        clearTimeout(timer);
        if (finalIdentity) {
          this.#pendingFirstPartyFinals.delete(finalIdentity);
          this.#ownerPublishedFirstPartyFinals.delete(finalIdentity);
        }
        finality?.close();
        await surface.close();
      };
      void surface.waitForSeq(finalSeq, deadline.signal).then(close, async error => {
        this.#observeFailure(error, { phase: "run", conversationId: input.conversationId, runId });
        await close();
      }).catch(error => this.#observeFailure(error, { phase: "run", conversationId: input.conversationId, runId }));
    };
    let executorPlan: Awaited<
      ReturnType<ConversationExecutorDispatchApplication["plan"]>
    > | undefined;
    let runFailed = false;
    let runError: unknown;
    try {
      if (!await this.#settleTargetCancellations(input.conversationId, runId)) {
        throw new ConversationPendingCancellationError(runId);
      }
      if (["cancel-requested", "cancelled"].includes(await journal.runState(runId) ?? "")) {
        throw new ConversationAssignmentCancelledError(runId, assignmentId);
      }
      const authority = await journal.authorityState();
      if (authority.deleted) {
        throw new Error("Conversation has been durably deleted");
      }
      const executionProfile = input.runtime.executionProfile?.();
      const permissionRules = input.runtime.executionPermissionRules?.();
      if (executionProfile === undefined || permissionRules === undefined) {
        throw new Error(
          "Durable conversation runtime must expose execution and permission snapshots",
        );
      }
      const recentExecutorId = await journal.recentExecutorAffinity();
      executorPlan = await this.#executorDispatch.plan({
        conversationId: input.conversationId,
        requirement: conversationExecutorRequirement(
          input.invocation,
          executionIngress,
        ),
        executionProfile,
        permissionRules,
        ...(recentExecutorId ? { recentExecutorId } : {}),
        ...(appliedAdmission.environment
          ? { environment: appliedAdmission.environment }
          : {}),
      });
      const preparedAuthority = executorPlan.assignment;
      const targetExecutorId = preparedAuthority.executorId;
      const origin = reservationOriginForSource(input.options?.source);
      const resourceContext = resourceHostContext(
        "reservation.prepareAssignmentRoot",
        assignmentId,
        this.#clock(),
      );
      await this.#executorDispatch.reconcileLocalReceipts();
      await this.#authority.resources.enqueueRoot(
        assignmentReservationId(assignmentId),
        { kind: "run", id: runId, attempt },
        origin,
        resourceContext,
      );
      // Resolve unrelated context before starting the short-lived fair slot.
      const controlContext = worksceneTaskContext(await WorksceneContinuationApplication.tasks(
        (id, query) => this.worksceneContinuationSources(id, query), input.conversationId));
      const prepareResourceLease = () => this.#authority.resources.prepareAssignmentRoot<"conversation">({
        assignmentId,
        executorId: targetExecutorId,
        workload: { kind: "run", id: runId, attempt },
        scopeBinding: {
          kind: "conversation",
          conversationId: input.conversationId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
        },
        budget: preparedAuthority.policy.budget,
        }, origin, resourceContext);
      const issueEnvelope = (resourceLease: AssignmentResourceLease<"conversation">) => this.#issuer.issue({
        runId,
        assignmentId,
        executorId: targetExecutorId,
        conversationId: input.conversationId,
        ownerEpoch: this.#ownerEpochFor(input.conversationId),
        ...(this.#authority.domain.kind === 'anchor' ? { anchorEpoch: this.#authority.domain.anchorEpoch } : {}),
        baseRevision: authority.commitRevision,
        attempt,
        resourceLease,
        ingress: executionIngress,
        controlContext,
        contentAssets: [...appliedAdmission.attachments],
        windowInput: {
          t: "full",
          windowEpoch: authority.commitRevision + 1,
          messages: [...executionMessages],
        },
        policy: preparedAuthority.policy,
        environment: preparedAuthority.environment,
      });
      let unsigned = issueEnvelope(await prepareResourceLease());
      await executorPlan.prepare({
        assignmentId,
        manifest: unsigned.manifest,
        ...(input.adaptLocalRuntime
          ? { adaptRuntime: input.adaptLocalRuntime }
          : {}),
      });
      let dispatch: Awaited<ReturnType<typeof journal.assign>>;
      for (;;) {
        try { dispatch = await journal.assign(unsigned); break; }
        catch (error) {
          if (!(error instanceof ResourceCandidateStaleError)) throw error;
          if (["cancel-requested", "cancelled"].includes(await journal.runState(runId) ?? "")) {
            throw new ConversationAssignmentCancelledError(runId, assignmentId);
          }
          // Runtime/environment preparation may outlive the candidate. Keep
          // that prepared manifest, but re-enter the same fair queue and the
          // original admission deadline before issuing another activation.
          const next = issueEnvelope(await prepareResourceLease());
          if (canonicalize(next.manifest) !== canonicalize(unsigned.manifest)) {
            throw new TypeError("Renewed resource candidate changed the prepared execution manifest");
          }
          unsigned = next;
        }
      }
      executorPlan.markPromoted();
      if (executionIngress.kind === "first-party") {
        this.#onFirstPartyAssignment?.({ conversationId: input.conversationId, runId, assignmentId });
      }
      this.#rememberAssignment(dispatch.envelope, dispatch.activation);
      executorPlan.bindRuntime(preparedAuthority.binding);
      const submissionContext = assignmentContext(dispatch.envelope);
      const resourceSubmissionContext = assignmentResourceContext(dispatch.envelope);
      const flushResourceUsage = () =>
        this.#authority.finalizeUsage(
          assignmentId,
          (report) => usageReporterContext(report.reporterId, report.digest, this.#clock()),
        );
      await executorPlan.dispatch({
        journal,
        envelope: dispatch.envelope,
        activation: dispatch.activation,
        contexts: this.#capturedAssignmentRouting().contexts,
        submissionContext,
      });
      const streamRef = {
        execution: "conversation",
        conversationId: input.conversationId,
        runId,
        ownerEpoch: this.#ownerEpochFor(input.conversationId),
      } as const;
      if (
        executionIngress.kind === "channel" &&
        this.#losslessDataPlane.kind === "available"
      ) {
        const losslessDataPlane = this.#losslessDataPlane.port;
        const ticketId = `ticket:${protocolDigest(
          "ConversationChannelTicketIdentity",
          1,
          {
            assignmentId,
            surfacePrincipal: executionIngress.surfacePrincipal,
          },
        )}`;
        const ticket = await journal.issueDataPlaneTicket({
          ticketId,
          assignmentId,
          surfacePrincipal: executionIngress.surfacePrincipal,
          kind: "run-interact",
          ttlMs: 24 * 60 * 60 * 1_000,
        });
        channelSession =
          await losslessDataPlane.openConversationChannel({
            executorId: targetExecutorId,
            assignmentId,
            ref: {
              execution: "conversation",
              conversationId: input.conversationId,
              runId,
              ownerEpoch: this.#ownerEpochFor(input.conversationId),
            },
            ticket,
            journal,
          });
      } else if (
        executionIngress.kind === "first-party" &&
        this.#losslessDataPlane.kind === "available"
      ) {
        const losslessDataPlane = this.#losslessDataPlane.port;
        const ticketId = `ticket:${protocolDigest(
          "ConversationFirstPartyTicketIdentity",
          1,
          {
            assignmentId,
            surfacePrincipal: executionIngress.surfacePrincipal,
          },
        )}`;
        const ticket = await journal.issueDataPlaneTicket({
          ticketId,
          assignmentId,
          surfacePrincipal: executionIngress.surfacePrincipal,
          kind: "run-interact",
          ttlMs: 24 * 60 * 60 * 1_000,
        });
        firstPartyFinalitySession = this.#createFirstPartyFinality?.({
          lastSeen: [
            {
              subject: streamRef,
              afterStatusRevision: 0,
            },
          ],
          onStatus: () => undefined,
          ...(this.#onFinal
            ? {
                onConversationFinal: async (frame) => {
                  const identity = canonicalize(frame);
                  if (this.#ownerPublishedFirstPartyFinals.delete(identity)) {
                    this.#pendingFirstPartyFinals.delete(identity);
                    return;
                  }
                  await this.#onFinal?.(frame);
                  this.#pendingFirstPartyFinals.delete(identity);
                  this.#firstPartyPublishedFinals.add(identity);
                },
              }
            : {}),
        });
        await firstPartyFinalitySession?.start();
        const projectionFinality = firstPartyFinalitySession;
        firstPartySurfaceSession =
          await losslessDataPlane.openFirstPartySurfaceSession({
            executorId: targetExecutorId,
            assignmentId,
            ref: streamRef,
            ticket,
            surfacePrincipal: executionIngress.surfacePrincipal,
            adoptFrame: async (frame, _checkpoint, _signal, readDisplay) => {
              if (frame.payload.kind === "provisional-final") {
                await projectionFinality?.acceptProvisionalFinal(frame);
              }
              await this.#onFirstPartyFrame?.(frame, readDisplay);
            },
          });
      }
      firstPartySurfaceSession?.start();
      const executeLocal = (async function* (
        this: ConversationProtocolRuntime,
        effect: ConversationExecutorExecutionEffect,
      ): AsyncGenerator<AgentYield, RunResult> {
      const executionRuntime = effect.runtime;
      await effect.startAndReport(submissionContext);

      const stream = await effect.createStream({ assignmentId, ref: streamRef });
      const appendObservedFrame = async (...args: Parameters<typeof stream.append>) => {
        const frame = await stream.append(...args);
        // 本机 Owner 没有远端流读者，直接转发已耐久写入的同一帧。
        if (executionIngress.kind === "first-party" && this.#losslessDataPlane.kind === "absent" && this.#onFirstPartyFrame) {
          await this.#onFirstPartyFrame(validateStreamFrame(frame));
        }
      };
      const streamMeta = executionIngress.turnOrigin
        ? { turnOrigin: executionIngress.turnOrigin }
        : {};
      let observedFinal: Awaited<ReturnType<typeof stream.final>> | undefined;
      let streamEndPublished = false;
      const finishObservedStream = async () => {
        const final = observedFinal ??= await stream.final(streamMeta);
        firstPartyStreamFinalSeq = final.finalSeq;
        if (!streamEndPublished && executionIngress.kind === 'first-party' && this.#losslessDataPlane.kind === 'absent') {
          this.#onFirstPartyStreamEnd?.({ conversationId: input.conversationId, runId, assignmentId, finalSeq: final.finalSeq });
          streamEndPublished = true;
        }
        return final;
      };
      const yieldToDurableCancellation = async (): Promise<boolean> => {
        const state = await journal.runState(runId);
        if (state !== "cancel-requested" && state !== "cancelled") return false;
        if (state === "cancel-requested") {
          await this.#drivePendingCancellations(journal);
        }
        // Cancellation has already recorded interaction endings. Drain that
        // existing projection without repeating started-only run-end cleanup.
        if (!observedFinal) await interactionScope.drain();
        // markTerminal may create a final frame internally, but the no-data-plane
        // producer also needs the same explicit end boundary for its observer.
        await finishObservedStream();
        await stream.markTerminal?.();
        this.#markRecovery(input.conversationId);
        this.#kickDelivery(input.hooks?.onFinalPublishFailure);
        return true;
      };
      // 本机终结步骤沿同一assignment幂等推进；临时资源压力在释放终态队列后有界重试。
      // 协议错误或永久失败保持原始判断，不能把它们当作可重试背压。
      const settleTerminal = async <T>(operation: (cancelled: boolean) => Promise<T>): Promise<T> => {
        return retryDurableObligation(async () => {
          const outcome = await retryControlAdmission(() => this.#terminalOperations.run(async () => {
            if (currentMaintenanceAbortSignal().aborted) throw new StorageMaintenanceCancelledError();
            const cancelled = await yieldToDurableCancellation();
            try { return { ok: true as const, value: await operation(cancelled) }; }
            catch (error) {
              if (maintenanceRetryDelayMs(error) !== undefined) throw error;
              return { ok: false as const, error };
            }
          }), async () => {});
          if (!outcome.ok) throw outcome.error;
          return outcome.value;
        }, currentMaintenanceAbortSignal(), error => error instanceof RetryableRunEndPreparation);
      };
      let toolCalls = 0;
      const interactionScope = effect.createInteractionScope({
        interactions: this.#interactions,
        context: submissionContext,
        surfacePrincipal: executionIngress.surfacePrincipal,
        broker: executionRuntime.confirmationBroker,
        stream,
        streamMeta,
      });
      const controlHeartbeat = effect.startHeartbeat();
      let runEndPrepared = false;
      const settleFailure = async (error: unknown): Promise<never> => {
        await controlHeartbeat.stop();
        try {
          await settleTerminal(async cancelled => {
            if (cancelled) return;
            const usageFinal = await flushResourceUsage();
            if (await effect.hasOpenSideEffects()) {
              await journal.markAssignmentUncertain(assignmentId, "ledger-unknown");
            } else {
              // Sealing may have succeeded before its acknowledgement was lost.
              // Never repeat started-only cleanup after crossing that boundary.
              if (!runEndPrepared) {
                await this.#prepareRunEndUntilAvailable(effect, submissionContext, interactionScope);
                runEndPrepared = true;
              }
              const failure = await effect.failExecution({
                reason: executionFailureReason(error),
                usageFinal,
              });
              if (failure) {
                const currentState = await journal.runState(runId);
                if (currentState === "dispatched" || currentState === "running") {
                  await journal.failAssignedRun(runId, assignmentId, failure.reason, failure.usageFinal);
                }
                // Projection I/O must not prevent the durable failure above.
                await finishObservedStream();
                await stream.markTerminal?.();
              }
            }
            this.#kickDelivery();
          });
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            `Conversation execution failed (${executionFailureReason(error)}) and durable failure settlement failed (${executionFailureReason(settlementError)})`,
          );
        }
        throw error;
      };
      let runResult: RunResult;
      let inputPort: import("@zhixing/core/loop").RunInputPort | undefined;
      let releaseConfirmation: (() => void) | undefined;
      try {
        releaseConfirmation = this.#requiredManager().bindExecutionConfirmation(input.conversationId, executionRuntime);
        inputPort = input.invocation.kind === "agent"
          ? await journal.openRunInput(runId, assignmentId)
          : undefined;
        const generator = effect.runKernel(executionMessages, {
          ...input.options,
          inputPort,
          turnContext: { ...input.options?.turnContext, worksceneTasks: readWorksceneTaskContext(dispatch.envelope.work.controlContext) },
          onProtocolEvent: async (event, meta) => {
            await appendObservedFrame(
              { kind: "agent-event", event },
              {
                ...streamMeta,
                ...(meta.lineage ? { lineage: meta.lineage } : {}),
              },
            );
          },
          toolSideEffectObserver: this.#interactions,
          assignmentIssuedAt: dispatch.envelope.issuedAt,
          assignmentMutations: effect.assignmentMutations({
            execution: "conversation",
            anchorEpoch: this.#authority.ownerEpoch,
            allowGlobal: this.#authority.globalPublishing,
            ...(this.#authority.globalPublishing
              ? {
                  capability: assignmentGlobalCapability({
                    assignmentId,
                    execution: "conversation",
                    capabilities: dispatch.envelope.capabilities,
                  }),
                }
              : {}),
          }),
          ...(this.#authority.globalState
            ? {
                globalQuery: createAssignmentGlobalQueryPort({
                  state: this.#authority.globalState,
                  capability: assignmentGlobalCapability({
                    assignmentId,
                    execution: "conversation",
                    capabilities: dispatch.envelope.capabilities,
                  }),
                  anchorEpoch: this.#authority.ownerEpoch,
                }),
              }
            : this.#authority.executionAssetCatalog
              ? { globalQuery: this.#authority.executionAssetCatalog }
              : {}),
          authorizeToolExecution: () =>
            effect.authorizeToolExecution(dispatch.envelope.permissionLease),
          modelCallResourceMeter: {
            reserve: async ({ callIndex, tokenUpperBound }) => {
              const usageId = `usage:${assignmentId}:model:${callIndex}`;
              await this.#requireExecutionResources().reserveUsage(
                dispatch.envelope.resourceLease,
                { usageId, tokens: tokenUpperBound, calls: 1 },
                resourceSubmissionContext,
              );
              return { usageId };
            },
            consume: async ({ usageId, tokens }) => {
              await this.#requireExecutionResources().consume(
                dispatch.envelope.resourceLease,
                { usageId, ...(tokens === 0 ? {} : { tokens }), calls: 1 },
                resourceSubmissionContext,
              );
            },
          },
        });
        try {
          while (true) {
            const item = await interactionScope.run(() => generator.next());
            if (item.done) {
              runResult = item.value;
              break;
            }
            if (item.value.type === "tool_start") toolCalls += 1;
            await appendObservedFrame(
              { kind: "agent-yield", yield: item.value },
              streamMeta,
            );
            // First-party observers consume one verified assignment projection.
            // Channel/internal callers still own their original generator output.
            if (executionIngress.kind !== "first-party" || !this.#onFirstPartyFrame) yield item.value;
          }
        } finally {
          // A consumer can return while suspended at yield. Forward that close
          // to the executor before its assignment identity is released.
          await interactionScope.run(() => generator.return(undefined as never));
        }
      } catch (error) {
        return await settleFailure(error);
      } finally {
        try { releaseConfirmation?.(); }
        finally {
          try { await controlHeartbeat.stop(); }
          finally { await inputPort?.close(); }
        }
      }

      if (runResult.agentResult.reason !== "completed") {
        const cancelled = await settleTerminal(async cancelled => {
          if (cancelled) return true;
          const usageFinal = await flushResourceUsage();
          if (await effect.hasOpenSideEffects()) {
            await journal.markAssignmentUncertain(assignmentId, "ledger-unknown");
          } else {
            if (!runEndPrepared) {
              await this.#prepareRunEndUntilAvailable(effect, submissionContext, interactionScope);
              runEndPrepared = true;
            }
            await finishObservedStream();
            const failure = await effect.failExecution({
              reason: runFailureReason(runResult.agentResult),
              usageFinal,
            });
            if (failure) {
              const currentState = await journal.runState(runId);
              if (
                currentState === "dispatched" ||
                currentState === "running"
              ) {
                await journal.failAssignedRun(
                  runId,
                  assignmentId,
                  failure.reason,
                  failure.usageFinal,
                );
              }
            }
            await stream.markTerminal?.();
          }
          return false;
        });
        if (cancelled) return cancelledRunResult(runResult);
        this.#kickDelivery(input.hooks?.onFinalPublishFailure, runResult);
        return runResult;
      }

      const terminal = await settleTerminal(async cancelled => {
        if (cancelled) {
          return { kind: "cancelled" as const };
        }
        if (!runEndPrepared) {
          await this.#prepareRunEndUntilAvailable(effect, submissionContext, interactionScope);
          runEndPrepared = true;
        }
        const sourceValue = runResult.runRecord.source ?? input.options?.source;
        const advancement =
          runResult.runRecord.advancement ?? input.options?.advancement;
        const transcriptRun: TranscriptRunRecord = {
          ...runResult.runRecord,
          type: "run",
          runId,
          // Visible turn count resets on /clear; the issued authority revision
          // remains monotonic and owns transcript identity on every executor.
          runIndex: dispatch.envelope.work.baseRevision,
          ...(sourceValue ? { source: sourceValue } : {}),
          ...(advancement ? { advancement } : {}),
        };
        const usageFinal = await flushResourceUsage();
        const bundle = await effect.sealConversationBundle({
          runRecord: transcriptRun,
          ...(runResult.windowCompact
            ? { windowCompact: runResult.windowCompact }
            : {}),
          contentAssets: [...appliedAdmission.attachments],
          streamFinal: await finishObservedStream(),
          usage: {
            inputTokens: runResult.agentResult.usage.inputTokens,
            outputTokens: runResult.agentResult.usage.outputTokens,
            toolCalls,
          },
          usageFinal,
        });
        const committed = await effect.submitSealedBundle(submissionContext);
        if (!committed.committed) {
          const error = new Error(
            `Conversation commit rejected: ${committed.error.message}`,
          );
          input.hooks?.onCommitFailure?.(error, runResult);
          throw error;
        }
        await stream.markTerminal?.();
        return { kind: "committed" as const, bundle, committed };
      }).catch(settleFailure);
      if (terminal.kind === "cancelled") return cancelledRunResult(runResult);
      const { bundle, committed } = terminal;
      if (firstPartySurfaceSession && firstPartyFinalitySession) {
        const final = (await journal.pendingFinalFrames()).find(
          (candidate) =>
            candidate.conversationId === input.conversationId &&
            candidate.runId === runId &&
            candidate.commitRevision === committed.commitRevision,
        );
        if (!final) {
          throw new Error(
            "Committed first-party run has no durable final projection",
          );
        }
        const finalIdentity = canonicalize(final);
        this.#pendingFirstPartyFinals.add(finalIdentity);
        try {
          await firstPartyFinalitySession.confirmConversationFinal({
            frame: final,
            bundle,
          });
        } catch (error) {
          input.hooks?.onFinalPublishFailure?.(error, runResult);
        }
        drainFirstPartyProjection(bundle.streamFinal.finalSeq, finalIdentity);
      }
      this.#markRecovery(input.conversationId);
      this.#kickDelivery(input.hooks?.onFinalPublishFailure, runResult);
      return runResult;
      }).bind(this);
      return yield* executorPlan.run({
        execute: executeLocal,
        onCommitted: (committed) =>
          replayCommittedRun(committed.runRecord, committed.windowCompact),
        onRemoteSettled: () => {
          this.#markRecovery(input.conversationId);
          this.#kickDelivery();
        },
      });
    } catch (error) {
      runFailed = true;
      runError = error;
      if (error instanceof ConversationPendingCancellationError) {
        this.#markRecovery(input.conversationId);
        throw error;
      }
      const cancelledPreparation = (error instanceof ConversationAssignmentCancelledError &&
        error.runId === runId && error.assignmentId === assignmentId) ||
        ((error instanceof AssignmentStartCancelledError || (error instanceof DataPlaneAssignmentInactiveError &&
          error.ref.execution === "conversation" && error.ref.runId === runId && error.ref.conversationId === input.conversationId)) && error.assignmentId === assignmentId &&
          ["cancel-requested", "cancelled"].includes(await journal.runState(runId) ?? ""));
      if (cancelledPreparation) {
        this.#markRecovery(input.conversationId);
        await this.#drivePendingCancellations(journal);
        this.#kickDelivery();
        runFailed = false;
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "aborted", usage },
          runRecord: { timestamp: this.#clock(), messages: [], usage },
          newMessages: [], durationMs: 0 };
      }
      this.#observeFailure(error, { phase: "run", conversationId: input.conversationId, runId });
      this.#markRecovery(input.conversationId);
      throw error;
    } finally {
      // 每项释放独立执行：前一项关闭失败不能让流尾、投影会话或执行计划泄漏。
      const cleanupErrors: unknown[] = [];
      const release = async (step: () => unknown) => {
        try { await step(); } catch (error) { cleanupErrors.push(error); }
      };
      await release(() => channelSession?.close());
      if (firstPartyStreamFinalSeq !== undefined) drainFirstPartyProjection(firstPartyStreamFinalSeq);
      await release(() => firstPartyFinalitySession?.close());
      await release(() => firstPartySurfaceSession?.close());
      await release(() => executorPlan?.dispose());
      // Local execution has left this frame; the claim must not outlive it even
      // when session cleanup fails, or recovery would skip this attempt forever.
      this.#clearRunClaims(runId);
      this.#activeAssignmentClaims.delete(assignmentId);
      try {
        await this.#retireSettledAssignments(input.conversationId, journal);
      } catch (cleanupError) {
        // Route retirement is derived cleanup: the run outcome above is already
        // durable. Keep the route and leave retirement to recovery under transient
        // pressure; never let a cleanup read replace the run's real result.
        this.#markRecovery(input.conversationId);
        this.#observeFailure(cleanupError, { phase: "recovery", conversationId: input.conversationId });
        if (maintenanceRetryDelayMs(cleanupError) === undefined) cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        this.#markRecovery(input.conversationId);
        if (runFailed) {
          throw new AggregateError(
            [runError, ...cleanupErrors],
            `Conversation run failed (${executionFailureReason(runError)}) and cleanup failed (${cleanupErrors.map(executionFailureReason).join(", ")})`,
          );
        }
        throw cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, `Conversation run cleanup failed (${cleanupErrors.map(executionFailureReason).join(", ")})`);
      }
    }
  }

  inputReceipt(input: { readonly conversationId: string; readonly turnId: string; readonly surfacePrincipal: string }) {
    return this.#authority.controlAdmission.inputReceipt(input);
  }

  async #prepareRunEndUntilAvailable(
    effect: ConversationExecutorExecutionEffect,
    context: AuthorityCallContext,
    interactionScope: import("./conversation-executor-dispatch.js").ConversationExecutorInteractionScope,
  ): Promise<void> {
    // 这里位于本机终态队列内，不在持有队列时睡眠重试；调用方在队列外结算延期。
    try {
      await effect.prepareForRunEnd(context);
      await interactionScope.drain();
    } catch (error) {
      if (maintenanceRetryDelayMs(error) !== undefined || error instanceof AuthorityStorageError || !shouldRetryRemoteObligation(error)) throw error;
      throw new RetryableRunEndPreparation(error);
    }
  }

  async #applyInputAdmission(
    input: DurableConversationAdmissionInput,
    allowPendingReplay = false,
  ): Promise<AppliedConversationAdmission> {
    await this.#adopt(input.conversationId);
    const at = this.#clock();
    const ingress = ingressForTurn(input, this.#authority.deviceId, at);
    const requestId = inputControlRequestId(ingress);
    const source = {
      principal: {
        surfacePrincipal: ingress.surfacePrincipal,
        deviceId: this.#authority.deviceId,
        connectionId:
          input.options?.turnContext?.turnOrigin?.triggeredBy ?? "connection:local",
      },
      ingress,
    };
    const journal = this.#journal(input.conversationId);
    const envelope = createInitialControlEnvelope({
      requestId,
      source,
      at,
      body: {
        t: "input",
        conversationId: input.conversationId,
        ingress: { ingressId: ingress.ingressId, source: ingress.kind },
        input: normalizeUserTurnInput(input.input),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: [...input.attachments] }
          : {}),
        invocation: input.invocation,
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
        ownerEpoch: this.#ownerEpochFor(input.conversationId),
      },
    });
    const control = {
      admission: this.#authority.controlAdmission,
      envelope,
      source,
      runId: `run:${randomUUID()}`,
    } as const;
    const recover = async () => {
      await this.#prepareControlBasis();
      await this.#prepareConversationBasis(input.conversationId);
    };
    return retryControlAdmission(async () => {
      if (!journal.hasRecoveredInputProjection || !this.#authority.controlAdmission.hasRecoveredProjection) await recover();
      if (currentMaintenanceAbortSignal().aborted) throw new StorageMaintenanceCancelledError();
      await this.ensureSession(input.conversationId);
      if (currentMaintenanceAbortSignal().aborted) throw new StorageMaintenanceCancelledError();
    const durablePending = allowPendingReplay
      ? (await this.#journal(input.conversationId).pendingInputs()).find(
          (candidate) =>
            candidate.ingress.ingressId === ingress.ingressId &&
            candidate.ingress.surfacePrincipal === ingress.surfacePrincipal,
        )
      : undefined;
    if (durablePending) {
      if (
        canonicalize(durablePending.input) !==
          canonicalize(normalizeUserTurnInput(input.input)) ||
        canonicalize(durablePending.attachments) !==
          canonicalize(input.attachments ?? []) ||
        canonicalize(durablePending.invocation) !== canonicalize(input.invocation)
        ||
        canonicalize(durablePending.environment ?? null) !==
          canonicalize(input.environment ?? null)
      ) {
        throw new DurableConversationAdmissionRejectedError(
          "idempotency-conflict",
          "Conversation ingress is already bound to another invocation",
        );
      }
      await this.#markAttachmentsAdopted(durablePending.attachments);
      return {
        runId: durablePending.runId,
        ingress: durablePending.ingress,
        attachments: durablePending.attachments,
        ...(durablePending.environment
          ? { environment: structuredClone(durablePending.environment) }
          : {}),
        replayed: true,
      };
    }
    const admissionState = await this.#authority.controlAdmission.lookup({
      envelope,
      source,
    });
    if (admissionState.kind === "settled") {
      const appliedReplay = admissionState.outcome;
      if (appliedReplay.kind === "rejected") {
        throw new DurableConversationAdmissionRejectedError(
          "idempotency-conflict",
          `Conversation input was rejected: ${appliedReplay.result.error.message}`,
        );
      }
      if (appliedReplay.result.status === "rejected") {
        throw new DurableConversationAdmissionRejectedError(
          appliedReplay.result.error.code === "idempotency-conflict"
            ? "idempotency-conflict"
            : "conversation-not-found",
          `Conversation input was rejected: ${appliedReplay.result.error.message}`,
        );
      }
      if (appliedReplay.result.body.t !== "input") {
        throw new Error("Conversation input admission returned another control result");
      }
      const replayedAttachments = [...(input.attachments ?? [])];
      await this.#markAttachmentsAdopted(replayedAttachments);
      return {
        runId: appliedReplay.result.body.runId,
        ingress,
        attachments: replayedAttachments,
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
        replayed: true,
      };
    }
    if (
      admissionState.kind === "absent"
      && input.attachments
      && input.attachments.length > 0
    ) {
      await this.#assertUploadAdoption({
        scope: {
          domain: "conversation",
          conversationId: input.conversationId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
        },
        surfacePrincipal: ingress.surfacePrincipal,
        requestId,
        assets: input.attachments,
        payloadDigest: envelope.payloadDigest,
      });
    }
    let admission: Awaited<ReturnType<ConversationRunJournal["applyInputControl"]>>;
    try {
      admission = await journal.applyInputControl(control);
    } catch (firstError) {
      // The append may have committed before its response was lost. Replaying the
      // exact envelope recovers the stable runId instead of reporting an ordinary
      // admission failure for work already owned by the durable scheduler.
      this.#markRecovery(input.conversationId);
      if (maintenanceRetryDelayMs(firstError) !== undefined) throw firstError;
      try {
        admission = await journal.applyInputControl(control);
      } catch (replayError) {
        if (maintenanceRetryDelayMs(replayError) !== undefined) throw replayError;
        if (
          firstError instanceof DurableConversationAdmissionRejectedError &&
          replayError instanceof DurableConversationAdmissionRejectedError
        ) {
          throw replayError;
        }
        throw new AggregateError(
          [firstError, replayError],
          "Conversation input admission could not determine its durable disposition",
        );
      }
    }
    if (admission.kind === "rejected") {
      throw new DurableConversationAdmissionRejectedError(
        "idempotency-conflict",
        `Conversation input was rejected: ${admission.result.error.message}`,
      );
    }
    if (admission.result.status === "rejected") {
      throw new DurableConversationAdmissionRejectedError(
        admission.result.error.code === "idempotency-conflict"
          ? "idempotency-conflict"
          : "conversation-not-found",
        `Conversation input was rejected: ${admission.result.error.message}`,
      );
    }
    if (admission.result.body.t !== "input") {
      throw new Error("Conversation input admission returned another control result");
    }
    let durableIngress = ingress;
    let durableAttachments = [...(input.attachments ?? [])];
    let durableEnvironment = input.environment
      ? structuredClone(input.environment)
      : undefined;
    const admittedRunId = admission.result.body.runId;
    if (admission.kind === "replayed") {
      const pending = (await journal.pendingInputs()).find(
        (candidate) => candidate.runId === admittedRunId,
      );
      if (pending) {
        durableIngress = pending.ingress;
        durableAttachments = [...pending.attachments];
        durableEnvironment = pending.environment
          ? structuredClone(pending.environment)
          : undefined;
      }
    }
    await this.#markAttachmentsAdopted(durableAttachments);
    return {
      runId: admittedRunId,
      ingress: durableIngress,
      attachments: durableAttachments,
      ...(durableEnvironment ? { environment: durableEnvironment } : {}),
      replayed: admission.kind === "replayed",
    };
    }, recover, input.options?.abortSignal);
  }

  async #markAttachmentsAdopted(
    attachments: PendingConversationInput["attachments"],
  ): Promise<void> {
    if (this.#authority.surfaceAssets) {
      await this.#authority.surfaceAssets.markAdopted(attachments);
      return;
    }
    for (const attachment of attachments) {
      if (!await this.#authority.artifacts.has(attachment)) {
        throw new Error(`Conversation attachment is unavailable: ${attachment.digest}`);
      }
    }
  }

  async #assertUploadAdoption(
    input: Parameters<
      import("@zhixing/core/authority").SurfaceAssetCoordinator["assertUploadAdoption"]
    >[0],
  ): Promise<void> {
    if (this.#authority.surfaceAssets) {
      await this.#authority.surfaceAssets.assertUploadAdoption(input);
      return;
    }
    for (const asset of input.assets) {
      if (!await this.#authority.artifacts.has(asset)) {
        throw new Error(`Conversation attachment is unavailable: ${asset.digest}`);
      }
    }
  }

  /** Internal owner-domain directory; no public RPC or channel registration. */
  async listSessions(): Promise<readonly string[]> {
    const ids = new Set(await this.#authority.controlAdmission.listCreatedConversationIds());
    for (const conversationId of this.#adoptedConversations.keys()) ids.add(conversationId);
    for (const conversationId of await this.#committedTransfers?.conversations() ?? []) ids.add(conversationId);
    const active: string[] = [];
    for (const conversationId of ids) {
      await this.#adopt(conversationId);
      if (!this.#acceptsConversationId(conversationId)) continue;
      if (!await this.#journalForQuery(conversationId).recoveryDeleted()) active.push(conversationId);
    }
    return active.sort((left, right) => left.localeCompare(right, "en-US"));
  }

  async sessionExists(conversationId: string): Promise<boolean> {
    await this.#adopt(conversationId);
    if (!this.#acceptsConversationId(conversationId)) return false;
    if (!this.#adoptedConversations.has(conversationId)) {
      if (!await this.#authority.controlAdmission.hasCreatedConversation(conversationId)) return false;
    }
    return !await this.#journalForQuery(conversationId).recoveryDeleted();
  }

  async #establishSession(conversationId: string): Promise<void> {
    const scope = {
      domain: "conversation" as const,
      conversationId,
      ownerEpoch: this.#ownerEpochFor(conversationId),
    };
    if (this.#authority.surfaceAssets &&
      await this.#authority.surfaceAssets.ownsScope(scope)) return;

    const parsed = parseConversationId(conversationId);
    const source = {
      principal: {
        surfacePrincipal: "owner:conversation-lifecycle",
        deviceId: this.#authority.deviceId,
        connectionId: "owner:conversation-lifecycle",
      },
    };
    const envelope = createInitialControlEnvelope({
      requestId: `session-create:${conversationId}`,
      source,
      at: this.#clock(),
      body: {
        t: "session-create",
        ...(parsed.scope.kind === "workscene"
          ? { sceneId: parsed.scope.sceneId }
          : {}),
      },
    });
    const apply = () =>
      this.#authority.controlAdmission.apply({
        envelope,
        source,
        prepare: () => ({
          result: {
            v: 1,
            status: "ok",
            body: { t: "session-create", conversationId },
          },
          authorityRevision: 1,
        }),
      });
    let outcome: Awaited<ReturnType<typeof apply>>;
    try {
      outcome = await apply();
    } catch (firstError) {
      if (maintenanceRetryDelayMs(firstError) !== undefined) throw firstError;
      try {
        outcome = await apply();
      } catch (replayError) {
        if (maintenanceRetryDelayMs(replayError) !== undefined) throw replayError;
        throw new AggregateError(
          [firstError, replayError],
          "Conversation creation could not determine its durable disposition",
        );
      }
    }
    if (outcome.kind === "rejected" || outcome.result.status === "rejected") {
      const message = outcome.result.status === "rejected"
        ? outcome.result.error.message
        : "conversation creation was rejected";
      throw new Error(`Conversation creation was rejected: ${message}`);
    }
    if (
      outcome.result.body.t !== "session-create" ||
      outcome.result.body.conversationId !== conversationId
    ) {
      throw new Error("Conversation creation returned another durable identity");
    }
  }

  #kickDelivery(
    onFailure?: (error: unknown, runResult: RunResult) => void,
    runResult?: RunResult,
  ): void {
    if (!this.#deliveryDrain) return;
    void this.#deliveryDrain().catch((error) => {
      if (onFailure && runResult) onFailure(error, runResult);
    });
  }

  async #applyAuthorityControl(
    conversationId: string,
    journal: ConversationRunJournal,
    input: Parameters<ConversationRunJournal["applyControl"]>[0],
    deferCapacityRetry = false,
  ): Promise<Awaited<ReturnType<ConversationRunJournal["applyControl"]>>> {
    try {
      return await journal.applyControl(input);
    } catch (firstError) {
      this.#markRecovery(conversationId);
      if (deferCapacityRetry && maintenanceRetryDelayMs(firstError) !== undefined) throw firstError;
      try {
        return await journal.applyControl(input);
      } catch (replayError) {
        throw new AggregateError(
          [firstError, replayError],
          "Conversation control could not determine its durable disposition",
        );
      }
    }
  }

  async recover(): Promise<number> {
    if (this.#recoveryRunning) return this.#recoveryRunning;
    await this.recoverReadinessProjections();
    if (this.#recoveryStopped) return 0;
    if (this.#recoveryDiscoveryAfter) {
      const page = await conversationRecoveryPage(this.#authority.authorityLog, this.#authority.artifacts, this.#recoveryDiscoveryAfter);
      for (const id of page.conversationIds) {
        await this.#adopt(id);
        if (this.#acceptsConversationId(id)) this.#markRecovery(id);
      }
      this.#recoveryDiscoveryAfter = page.after;
    }
    const queue = [...this.#recoveryConversations.entries()].slice(0, 32);
    // Received control obligations precede dispatch of queued inputs. The
    // owner still commits applied before issuing any local abort signal.
    let recovered = await this.#recoverReceivedCancellations();
    recovered += await this.#executorDispatch.reconcileLocalReceipts();
    recovered += await this.#authority.resourceRecovery.reclaimExpired();
    const recoverConversation = async (conversationId: string): Promise<number> =>
      this.#withRecoveryClaim(conversationId, async () => {
        let count = 0;
        await this.#prepareConversationBasis(conversationId);
        const journal = this.#journal(conversationId);
        if (this.#losslessDataPlane.kind === "available") {
          count += await this.#losslessDataPlane.port.recoverConversationChannels(
            journal,
          );
        }
        count += await this.#resumeLifecycleProjections(conversationId, journal);
        const authority = await journal.authorityState();
        if (authority.deleted && authority.pendingLifecycleProjections === 0) {
          this.#retireConversation(conversationId);
          return 0;
        }
        await this.#primeAssignmentRouting(journal);
        const recovery = this.#createRecoveryDispatcher(journal);
        const { dispatcher, executor: routedExecutor, cancellationContinuationPending } = recovery;
        if (this.#recoveryStopped) return count;
        count += await journal.resumeCommittedProjections();
        if (this.#recoveryStopped) return count;
        count += await journal.resumePendingPublishing();
        if (this.#recoveryStopped) return count;
        count += await dispatcher.recoverCancellations();
        if (this.#recoveryStopped) return count;
        if (!this.#shutdownDraining) {
          let ready = true;
          for (const pending of await journal.pendingDispatches()) {
            if (!await this.#settleTargetCancellations(conversationId, pending.envelope.work.runId)) ready = false;
          }
          if (ready) count += await dispatcher.dispatchPending().then((items) => items.length);
          if (this.#recoveryStopped) return count;
        }
        count += await dispatcher.recoverAssignments();
        if (this.#recoveryStopped) return count;
        count += await dispatcher.recoverSupersedes();
        if (this.#recoveryStopped) return count;
        count += await this.#reconcileAbandonedAssignments(
          journal,
          dispatcher,
          routedExecutor,
          cancellationContinuationPending,
        );
        if (this.#recoveryStopped) return count;
        if (!this.#shutdownDraining) {
          count += await this.#resumeQueuedInputs(conversationId, journal);
        }
        if (this.#recoveryStopped) return count;
        count += await this.publishPendingFinals(conversationId);
        await this.#retireSettledAssignments(conversationId, journal);
        await this.#recoverAuxiliary(conversationId);
        return count;
      });
    const workers = Array.from(
      { length: Math.min(4, queue.length) },
      async () => {
        while (queue.length > 0) {
          if (this.#recoveryStopped) return;
          const entry = queue.shift();
          if (!entry) return;
          const [conversationId, claimedGeneration] = entry;
          try {
            recovered += await recoverConversation(conversationId);
            if (!this.#recoveryStopped && await conversationRecoveryPending(this.#authority.authorityLog, this.#authority.artifacts, conversationId)) {
              this.#markRecovery(conversationId);
            }
            if (
              !this.#recoveryStopped &&
              this.#recoveryConversations.get(conversationId) === claimedGeneration
            ) {
              this.#recoveryConversations.delete(conversationId);
            }
          } catch (error) {
            this.#observeFailure(error, { phase: "recovery", conversationId });
            // A later pass retries this conversation without blocking service readiness or peers.
          } finally {
            if (this.#recoveryConversations.get(conversationId) === claimedGeneration) {
              this.#recoveryConversations.delete(conversationId);
              this.#recoveryConversations.set(conversationId, claimedGeneration);
            }
          }
        }
      },
    );
    await Promise.all(workers);
    return recovered;
  }

  async recoverConversation(conversationId: string): Promise<number> {
    this.#markRecovery(conversationId);
    await this.prepareConversationReadiness(conversationId);
    return this.recover();
  }

  /** The selected conversation must be prepared before a surface reports ready. */
  async prepareConversationReadiness(conversationId: string): Promise<void> {
    await this.#prepareControlBasis();
    // 旧资料升级后该会话的决定状态若尚未迁移，插到后台迁移的最前；准备该会话时等它本身的迁移
    // （升级后首次另需等一次性的全库只读扫描完成）。
    prioritizeConversationDecisionMigration(this.#authority.authorityLog, conversationId);
    await this.#prepareConversationBasis(conversationId);
  }


  /** 业务入口开放前追平控制索引；稳态仅续读未覆盖尾部，不再延后到首次发送。 */
  #prepareControlBasis(): Promise<void> {
    if (this.#authority.controlAdmission.hasRecoveredProjection) return Promise.resolve();
    if (this.#controlBasis) return this.#controlBasis;
    const preparing = this.#authority.controlAdmission.prepareRecovery().finally(() => {
      if (this.#controlBasis === preparing) this.#controlBasis = undefined;
    });
    this.#controlBasis = preparing;
    return preparing;
  }

  async #prepareConversationBasis(conversationId: string): Promise<void> {
    await this.#adopt(conversationId);
    const unavailable = this.#unavailableTransfers.get(conversationId);
    if (unavailable) {
      const publication = await loadCommittedConversationBase(this.#authority.authorityLog, this.#authority.artifacts,
        this.#authority.verifier, unavailable.transferId);
      await this.installCommittedConversationTransfer({ manifest: publication.manifest, source: publication.source });
    }
    const journal = this.#journal(conversationId);
    if (journal.hasRecoveredInputProjection) return;
    await journal.restoreRecoveryCheckpoint();
  }


  async completeLifecycleProjections(conversationId: string): Promise<number> {
    await this.#adopt(conversationId);
    return this.#resumeLifecycleProjections(
      conversationId,
      this.#journal(conversationId),
    );
  }

  async publishPendingFinals(conversationId: string): Promise<number> {
    try {
      await this.#adopt(conversationId);
      const journal = this.#journal(conversationId);
      await journal.resumeCommittedProjections();
      if (!this.#onFinal) return 0;
      return await journal.publishPendingFinals(async (frame, publishResults) => {
        const identity = canonicalize(frame);
        if (this.#firstPartyPublishedFinals.delete(identity)) {
          for (const notice of publishResults) await this.#onPublishResult?.(notice);
          return;
        }
        if (this.#pendingFirstPartyFinals.has(identity)) {
          await this.#onFinal?.(frame);
          for (const notice of publishResults) await this.#onPublishResult?.(notice);
          this.#ownerPublishedFirstPartyFinals.add(identity);
          return;
        }
        await this.#onFinal?.(frame);
        for (const notice of publishResults) await this.#onPublishResult?.(notice);
      });
    } catch (error) {
      this.#markRecovery(conversationId);
      throw error;
    }
  }

  /**
   * 停机收束核对:全部会话的未发布 final 总数与恢复积压会话数。
   * 在恢复循环停止后读取;两者皆零才可宣称 durable 义务已收束。
   */
  async pendingClosureWork(conversationId?: string): Promise<{
    readonly pendingFinals: number;
    readonly pendingAssignments: number;
    readonly recoveryBacklog: number;
    readonly activeLocalLeases: number;
    readonly items: {
      readonly finals: readonly { readonly id: string; readonly revision: string }[];
      readonly assignments: readonly { readonly id: string; readonly revision: string }[];
      readonly recovery: readonly { readonly id: string; readonly revision: string }[];
      readonly leases: readonly { readonly id: string; readonly revision: string }[];
    };
  }> {
    const finals: Array<{ id: string; revision: string }> = [];
    const assignments: Array<{ id: string; revision: string }> = [];
    const conversations = conversationId === undefined
      ? await this.listSessions()
      : [conversationId];
    for (const currentConversationId of conversations) {
      await this.#adopt(currentConversationId);
      const journal = this.#journal(currentConversationId);
      for (const final of await journal.pendingFinalFrames()) {
        finals.push({
          id: `${final.conversationId}:${final.runId}`,
          revision: String(final.commitRevision),
        });
      }
      for (const assignment of await journal.assignmentsAwaitingRecovery()) {
        assignments.push({
          id: `${
            assignment.dispatch.envelope.executorId === this.#authority.executorId
              ? "local"
              : "relay"
          }:${assignment.assignmentId}`,
          revision: dispatchEnvelopeDigest(assignment.dispatch.envelope),
        });
      }
    }
    const leases: Array<{ id: string; revision: string }> = [];
    for (const reservation of
      await this.#authority.resourceRecovery.activeConversationReservations()) {
      await this.#adopt(reservation.conversationId);
      if (
        reservation.ownerEpoch === this.#ownerEpochFor(reservation.conversationId) &&
        this.#acceptsConversationId(reservation.conversationId) &&
        (conversationId === undefined ||
          reservation.conversationId === conversationId)
      ) {
        leases.push({
          id: reservation.reservationId,
          revision: reservation.revision,
        });
      }
    }
    const recoveryIds = new Set<string>();
    for (const id of this.#recoveryConversations.keys()) {
      if (conversationId === undefined || conversationId === id) recoveryIds.add(`queued:${id}`);
    }
    for (const id of this.#activeRecoveryClaims.keys()) {
      if (conversationId === undefined || conversationId === id) recoveryIds.add(`claimed:${id}`);
    }
    if (this.#recoveryRunning) recoveryIds.add(`worker:${conversationId ?? "all"}`);
    const recovery = [...recoveryIds].sort().map((id) => ({
      id,
      revision: protocolDigest("ConversationRecoveryClosure", 1, { id }),
    }));
    const sortItems = <T extends { readonly id: string }>(items: T[]) =>
      Object.freeze(items.sort((left, right) => left.id.localeCompare(right.id, "en-US")));
    return {
      pendingFinals: finals.length,
      pendingAssignments: assignments.length,
      recoveryBacklog: recovery.length,
      activeLocalLeases: leases.length,
      items: Object.freeze({
        finals: sortItems(finals),
        assignments: sortItems(assignments),
        recovery: sortItems(recovery),
        leases: sortItems(leases),
      }),
    };
  }

  sessionAuthorityState(conversationId: string) {
    return this.#adopt(conversationId).then(() => this.#journal(conversationId).authorityState());
  }

  async statusHistory(
    requests: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ): Promise<{
    readonly notices: readonly ConversationStatusNotice[];
    readonly next: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[];
  }> {
    for (const request of requests) {
      await this.#adopt(request.conversationId);
      if (!this.#acceptsConversationId(request.conversationId)) {
        throw new Error("Conversation identity does not belong to this owner domain");
      }
    }
    const grouped = new Map<
      string,
      Array<{ runId: string; afterStatusRevision: number }>
    >();
    for (const request of requests) {
      const group = grouped.get(request.conversationId) ?? [];
      group.push({
        runId: request.runId,
        afterStatusRevision: request.afterStatusRevision,
      });
      grouped.set(request.conversationId, group);
    }
    const queue = [...grouped.entries()];
    const notices: ConversationStatusNotice[][] = [];
    const next: Array<{
      conversationId: string;
      runId: string;
      afterStatusRevision: number;
    }> = [];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const entry = queue.shift();
          if (!entry) return;
          const [conversationId, cursors] = entry;
          const journal = this.#journalForQuery(conversationId);
          const pages = await journal.statusHistoryBatch(cursors);
          for (let index = 0; index < pages.length; index += 1) {
            const page = pages[index]!;
            const cursor = cursors[index]!;
            notices.push(page.notices);
            // 每个请求 subject 必须返回续读游标:无推进时保留原水位,
            // 不得省略——省略会被消费侧的集合全等对账当作丢失 subject。
            next.push({
              conversationId,
              runId: cursor.runId,
              afterStatusRevision:
                page.nextAfterStatusRevision ?? cursor.afterStatusRevision,
            });
          }
        }
      }),
    );
    return { notices: notices.flat(), next };
  }

  /**
   * 会话状态端口——advancement 等会话域消费者经它读写 owner 权威日志；
   * 惰性创建，journal 访问走缓存实例（查询侧不再每次重建）。
   */
  taskListBeforeMutation(conversationId: string, requestId: string) {
    return this.#adopt(conversationId).then(() => this.#journal(conversationId).taskListBeforeMutation(requestId));
  }

  /** Local owner-only recovery port; no metadata directory or surface authority. */
  get advancementPending() {
    return {
      list: (after?: string) => pendingAdvancementConversations(this.#authority.authorityLog, this.#authority.artifacts, this.#authority.verifier, after),
      cleanup: (conversationId: string, after?: string) =>
        this.#adopt(conversationId).then(() => this.#journal(conversationId).pendingAdvancementCleanup(after)),
      run: (conversationId: string, sessionId: string, before?: number) =>
        this.#adopt(conversationId).then(() => this.#journal(conversationId).pendingAdvancementRun(sessionId, before)),
    };
  }

  get sessionState(): SessionStatePort {
    if (!this.#sessionState) {
      this.#sessionState = new ConversationSessionStateAdapter({
        journalFor: async (conversationId) => {
          await this.#adopt(conversationId);
          return this.#journal(conversationId);
        },
        sessionExists: async (conversationId) => await this.sessionExists(conversationId) ||
          (await this.#storedIdentityExists?.(conversationId)) === true,
        establishIdentity: (conversationId) => this.ensureSession(conversationId),
        mutateControl: async (conversationId, mutation, ctx) => {
          await this.#adopt(conversationId);
          const principal = ctx.principal.kind === "surface"
            ? {
                surfacePrincipal: ctx.principal.surfacePrincipal,
                connectionId: ctx.principal.connectionId,
                deviceId: this.#authority.deviceId,
              }
            : ctx.principal.kind === "host"
              ? {
                  surfacePrincipal: `owner:${ctx.principal.component}`,
                  connectionId: `owner:${ctx.principal.component}`,
                  deviceId: this.#authority.deviceId,
                }
              : undefined;
          if (!principal) {
            throw new Error("Session control mutation requires a surface or host principal");
          }
          // A local empty conversation has no owner fact until its first write.
          // Establish only a known local identity; a durable tombstone stays final.
          if (
            !(await this.#journal(conversationId).authorityState()).hasDurableIdentity &&
            (await this.#storedIdentityExists?.(conversationId)) === true
          ) {
            await this.ensureSession(conversationId);
          }
          const result = await this.writeSession({
            conversationId,
            requestId: ctx.requestId,
            mutation,
            principal,
            conversationExists: () => this.sessionExists(conversationId),
          });
          if (result.status === "not-found") {
            const error: AuthorityError = {
              code: "not-found",
              message: `Session does not exist: ${conversationId}`,
              retryable: false,
            };
            throw error;
          }
          if (result.status !== "accepted") {
            const error: AuthorityError = {
              code: "busy",
              message: `Session mutation is busy: ${conversationId}`,
              retryable: true,
            };
            throw error;
          }
          return { revision: result.domainRevision };
        },
        stageAssignment: async (conversationId, mutation, ctx) => {
          await this.#adopt(conversationId);
          if (ctx.principal.kind !== "assignment") {
            throw new Error("Staged session mutation requires an assignment principal");
          }
          const capability = validateAuthorityCapability(
            ctx.principal.capability,
            this.#authority.verifier,
          );
          if (capability.scope.execution !== "conversation") {
            throw new Error("Assignment capability does not authorize this session mutation");
          }
          if (
            capability.scope.conversationId !== conversationId ||
            !("ownerEpoch" in capability) ||
            capability.ownerEpoch !== this.#ownerEpochFor(conversationId) ||
            this.#assignmentConversations.get(capability.assignmentId) !== conversationId ||
            !capability.methods.includes("session.mutate")
          ) {
            throw new Error("Assignment capability does not authorize this session mutation");
          }
          const staging = this.#assignmentStaging;
          if (!staging) {
            throw new Error("Local assignment staging is unavailable in this owner topology");
          }
          const staged = await staging.stageSession(
            capability.assignmentId,
            {
              mutation,
              requestId: ctx.requestId,
            },
          );
          return { revision: staged.recordSeq };
        },
      });
    }
    return this.#sessionState!;
  }

  #acceptsConversationId(conversationId: string): boolean {
    return (
      this.#authority.acceptsConversationId(conversationId) ||
      this.#adoptedConversations.has(conversationId)
    );
  }

  #ownerEpochFor(conversationId: string): number {
    return this.#adoptedConversations.get(conversationId)?.ownerEpoch ??
      this.#authority.ownerEpoch;
  }

  #journal(conversationId: string): ConversationRunJournal {
    const unavailable = this.#unavailableTransfers.get(conversationId);
    if (unavailable) throw unavailable.error;
    if (!this.#acceptsConversationId(conversationId)) {
      throw new Error("Conversation identity does not belong to this owner domain");
    }
    const existing = this.#journals.get(conversationId);
    if (existing) return existing;
    const journal = this.#createJournal(conversationId);
    this.#journals.set(conversationId, journal);
    return journal;
  }

  #journalForQuery(conversationId: string): ConversationRunJournal {
    if (!this.#acceptsConversationId(conversationId)) {
      throw new Error("Conversation identity does not belong to this owner domain");
    }
    return this.#journals.get(conversationId) ?? this.#createJournal(conversationId);
  }

  #createJournal(
    conversationId: string,
    ownerEpoch = this.#ownerEpochFor(conversationId),
  ): ConversationRunJournal {
    const journal = new ConversationRunJournal({
      conversationId,
      ownerEpoch,
      log: this.#authority.authorityLog,
      artifacts: this.#authority.artifacts,
      signer: this.#authority.signer,
      verifier: this.#authority.verifier,
      submission: createSubmissionAuthorizer(
        (assignmentId) =>
          this.#assignmentArtifactAuthority.find(assignmentId)?.capability.executorId ??
          this.#authority.executorId,
        this.#authority.verifier,
      ),
      authority: this.#commitAuthority(conversationId),
      projection: {
        project: (projection) => this.#requiredManager().project(projection),
      },
      ...(this.#authority.globalPublishing
        ? { publisher: this.#mutationPublisherProxy }
        : {}),
      ...(this.#authority.participant
        ? { delivery: this.#authority.participant }
        : {}),
      resources: this.#authority.resources,
      clock: this.#clock,
      currentAuthority: {
        deviceId: this.#authority.deviceId,
        executorId: this.#authority.executorId,
      },
    });
    journal.onStatus(async (notice) => {
      this.#markRecovery(conversationId);
      await this.#onStatus?.(notice);
      for (const listener of this.#statusListeners) await listener(notice);
    });
    return journal;
  }

  #commitAuthority(conversationId: string): ConversationCommitAuthority {
    return {
      decideAtPrefix: (decision) => {
        if (
          decision.conversationId !== conversationId ||
          decision.ownerEpoch !== this.#ownerEpochFor(conversationId)
        ) {
          return {
            committed: false,
            error: {
              code: "revision-conflict",
              message: "Conversation base revision is stale or unsupported",
              retryable: false,
            },
          };
        }
        return { committed: true, commitRevision: decision.baseRevision + 1 };
      },
    };
  }

  #conversationForAssignment(assignmentId: string): string {
    const conversationId = this.#assignmentConversations.get(assignmentId);
    if (!conversationId) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return conversationId;
  }

  async #primeAssignmentRouting(journal: ConversationRunJournal): Promise<void> {
    for (const candidate of await journal.assignmentsAwaitingRecovery()) {
      this.#rememberAssignment(
        candidate.dispatch.envelope,
        candidate.dispatch.activation,
      );
    }
    for (const candidate of await journal.pendingDispatches()) {
      this.#rememberAssignment(candidate.envelope, candidate.activation);
    }
  }

  async #driveCancellation(
    journal: ConversationRunJournal,
    request: Parameters<InProcessConversationDispatcher["cancelRun"]>[0],
  ): Promise<void> {
    await this.#withRecoveryClaim(journal.conversationId, async () => {
      await this.#primeAssignmentRouting(journal);
      await this.#createRecoveryDispatcher(journal).dispatcher.cancelRun(request);
    });
  }

  async #drivePendingCancellations(
    journal: ConversationRunJournal,
  ): Promise<number> {
    return this.#withRecoveryClaim(journal.conversationId, async () => {
      await this.#primeAssignmentRouting(journal);
      return this.#createRecoveryDispatcher(journal).dispatcher.recoverCancellations();
    });
  }

  async #continueAppliedCancellations(journal: ConversationRunJournal): Promise<void> {
    try { await this.#drivePendingCancellations(journal); }
    catch (error) {
      if (maintenanceRetryDelayMs(error) === undefined) throw error;
      // Applied is already durable and local stop has been issued. Settlement
      // pressure belongs to its retained recovery obligation, not a new user
      // cancellation or an extension of the foreground admission deadline.
      this.#markRecovery(journal.conversationId);
    }
  }

  #capturedAssignmentRouting() {
    // A dispatcher owns its bindings across awaits. Recovery claims prevent a newly
    // issued binding from being retired before its first lookup in this operation.
    const bindings = new Map<string, { conversationId: string; authority: ReturnType<ConversationAssignmentArtifactAuthorityIndex["read"]> }>();
    const capture = (assignmentId: string) => {
      let binding = bindings.get(assignmentId);
      if (!binding) {
        binding = { conversationId: this.#conversationForAssignment(assignmentId),
          authority: this.#assignmentArtifactAuthority.read(assignmentId) };
        bindings.set(assignmentId, binding);
      }
      return binding;
    };
    for (const assignmentId of this.#assignmentConversations.keys()) capture(assignmentId);
    return {
      contexts: createDispatchContexts({ signer: this.#authority.signer, deviceId: this.#authority.deviceId,
        clock: this.#clock, conversationIdFor: id => capture(id).conversationId,
        ownerEpochFor: id => capture(id).authority.activation.ref.ownerEpoch,
        anchorEpochFor: id => capture(id).authority.capability.anchorEpoch ??
          (capture(id).authority.activation.ref.ownerEpoch === this.#ownerEpochFor(capture(id).conversationId) && this.#authority.domain.kind === 'anchor'
            ? this.#authority.domain.anchorEpoch : undefined),
        assertSigningAuthority: (_id, tenure) => this.#assertControlSigningTenure(tenure) }),
      executorIdForAssignment: (id: string) => capture(id).authority.capability.executorId,
      submissionContext: (id: string): AuthorityCallContext => {
        const capability = capture(id).authority.capability;
        return { principal: { kind: "assignment", capability }, requestId: `submission:${id}`, deadlineAt: capability.expiry };
      },
    };
  }

  #createRecoveryDispatcher(journal: ConversationRunJournal) {
    return this.#executorDispatch.recoveryDispatcher({
      journal,
      ...this.#capturedAssignmentRouting(),
    });
  }

  async #reconcileAbandonedAssignments(
    journal: ConversationRunJournal,
    dispatcher: InProcessConversationDispatcher,
    executor: RunExecutorPort,
    cancellationContinuationPending: (assignmentId: string) => boolean,
  ): Promise<number> {
    let reconciled = 0;
    for (const candidate of await journal.assignmentsAwaitingRecovery()) {
      if (this.#scheduledRuns.has(candidate.dispatch.envelope.work.runId) ||
          this.#activeAssignmentClaims.has(candidate.assignmentId) ||
          cancellationContinuationPending(candidate.assignmentId)) {
        continue;
      }
      this.#rememberAssignment(
        candidate.dispatch.envelope,
        candidate.dispatch.activation,
      );
      const snapshot = await journal.validateExecutorLedgerSnapshot(
        await executor.queryLedger(
          candidate.assignmentId,
          this.#contexts.create(candidate.assignmentId, "executor.queryLedger", {
            requestId: `ledger:${candidate.assignmentId}:snapshot`,
            body: { range: null },
          }),
        ),
      );
      // Cancellation clears scheduler claims before its executor continuation
      // is installed. A live run still owns this assignment through its finally.
      if (this.#scheduledRuns.has(candidate.dispatch.envelope.work.runId) ||
          this.#activeAssignmentClaims.has(candidate.assignmentId) ||
          cancellationContinuationPending(candidate.assignmentId)) continue;
      if (snapshot.phase === "received" && candidate.state === "dispatched") {
        await dispatcher.supersede(
          candidate.assignmentId,
          `local-recovery:${candidate.assignmentId}`,
        );
        reconciled += 1;
        continue;
      }
      if (snapshot.phase === "started") {
        await journal.markAssignmentUncertain(
          candidate.assignmentId,
          "ledger-unknown",
        );
        reconciled += 1;
      }
    }
    return reconciled;
  }

  async #mayScheduleInput(conversationId: string, runId: string): Promise<boolean> {
    if (!await this.#settleTargetCancellations(conversationId, runId)) return false;
    const state = await this.#journal(conversationId).assignmentSchedulingState(runId);
    if (state.ready) return true;
    // 正常执行中的后续输入仍交给原内存队列；无人执行的待确认项只留耐久队列。
    return state.blockingRunId !== undefined && this.#scheduledRuns.has(state.blockingRunId) &&
      this.#manager()?.getSession(conversationId)?.busy === true;
  }

  async #resumeQueuedInputs(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<number> {
    let resumed = 0;
    for (const pending of await journal.pendingInputs()) {
      await this.#schedulePendingInput(conversationId, pending);
      resumed += 1;
    }
    return resumed;
  }

  async #schedulePendingInput(
    conversationId: string,
    pending: PendingConversationInput,
  ): Promise<void> {
    if (this.#shutdownDraining) return;
    if (this.#scheduledRuns.has(pending.runId)) return;
    if (!await this.#mayScheduleInput(conversationId, pending.runId)) return;
    if (this.#schedulingRuns.has(pending.runId)) {
      throw new Error(`Conversation run ${pending.runId} is still entering the scheduler`);
    }
    const manager = this.#requiredManager();
    const options = runOptionsForPending(pending);
    const retryAbort = new AbortController();
    this.#schedulingRuns.add(pending.runId);
    try {
      const admission = await manager.admitTurn({
        conversationId,
        source: options.source,
        capacityReserved: true,
        makeTask: (managed) => ({
          source: options.source,
          durableRunId: pending.runId,
          execute: async () => {
            try {
              await this.#executePendingInput(
                conversationId,
                pending,
                manager,
                managed,
                retryAbort.signal,
              );
            } catch (error) {
              this.#markRecovery(conversationId);
              throw error;
            } finally {
              manager.setBusy(conversationId, false);
            }
          },
          cancel: () => {},
          cancelLocally: () => {},
          cancelDurably: () => this.cancelAdmitted(conversationId, pending.runId),
          abort: (reason) => {
            const newlyAborted = !retryAbort.signal.aborted;
            if (newlyAborted) retryAbort.abort(reason);
            return managed.runtime.abort(reason) || newlyAborted;
          },
        }),
      });
      if (admission.status === "immediate") {
        this.#schedulingRuns.delete(pending.runId);
        this.#scheduledRuns.add(pending.runId);
        void admission.task.execute().catch(() => {});
      } else if (admission.status === "queued") {
        this.#schedulingRuns.delete(pending.runId);
        this.#scheduledRuns.add(pending.runId);
      } else if (admission.status === "full" || admission.status === "not-found") {
        throw new Error(
          `Recovered conversation run ${pending.runId} could not enter the scheduler`,
        );
      } else {
        throw new Error(
          `Recovered conversation run ${pending.runId} did not acquire a scheduler slot`,
        );
      }
    } catch (error) {
      this.#schedulingRuns.delete(pending.runId);
      this.#markRecovery(conversationId);
      throw error;
    }
  }

  async #scheduleResolvedRetry(
    conversationId: string,
    runId: string,
    journal: ConversationRunJournal,
  ): Promise<void> {
    const pending = (await journal.pendingInputs()).find(
      (candidate) => candidate.runId === runId,
    );
    if (!pending) {
      throw new Error(`Resolved conversation run ${runId} has no durable input`);
    }
    await this.#schedulePendingInput(conversationId, pending);
  }

  async #executePendingInput(
    conversationId: string,
    pending: PendingConversationInput,
    manager: ConversationManager,
    managed: ManagedSession,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const continuation = pending.ingress.turnOrigin?.worksceneContinuation;
    if (continuation && !await this.isWorksceneContinuationCurrent({ conversationId, runId: pending.runId })) {
      await this.cancelAdmitted(conversationId, pending.runId);
      return;
    }
    const options = runOptionsForPending(pending, abortSignal, true);
    const invocation = pending.invocation;
    if (invocation.kind === "perspectives") {
      if (!this.#executeRecoveredPerspective) {
        throw new Error(
          "Durable perspective recovery has no perspective execution adapter",
        );
      }
      const execute = this.#executeRecoveredPerspective;
      const createRuntime = (baseRuntime: SessionRuntime): SessionRuntime => ({
        sessionId: `recovered-perspectives:${conversationId}`,
        async *run(_messages, runtimeOptions): AsyncGenerator<AgentYield, RunResult> {
          // 恢复执行同样独占该 assignment 的计量序列——与正常 durable 路径同构
          const meter = runtimeOptions?.modelCallResourceMeter;
          let callIndex = 0;
          return await execute({
            manager,
            managed: { ...managed, runtime: baseRuntime },
            originalInput: pending.input,
            question: invocation.question,
            source: invocation.source,
            ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
            turnContext: options.turnContext,
            authorizeToolExecution: runtimeOptions?.authorizeToolExecution,
            ...(meter
              ? {
                  modelCallMetering: {
                    meter,
                    nextCallIndex: () => ++callIndex,
                  },
                }
              : {}),
          });
        },
        abort: (reason) => baseRuntime.abort(reason),
        async dispose() {},
        securitySnapshot: () => requireRuntimeSecuritySnapshot(baseRuntime),
        executionPermissionRules: () =>
          requireRuntimeExecutionPermissionRules(baseRuntime),
        executionProfile: () => requireRuntimeExecutionProfile(baseRuntime),
      });
      const runtime = createRuntime(managed.runtime);
      const generator = this.run({
        conversationId,
        input: pending.input,
        attachments: pending.attachments,
        messages: [
          ...managed.window.getMessages(),
          userMessageFromTurnInput(pending.input),
        ],
        baseRevision: managed.turnCount,
        runtime,
        adaptLocalRuntime: createRuntime,
        invocation,
        options: { ...options, turnIndex: managed.turnCount },
      });
      while (!(await generator.next()).done) {
        // Perspective orchestration publishes provisional events through its own bus.
      }
    } else {
      const generator = runTurnWithCommit(
        manager,
        conversationId,
        pending.input,
        {
          ...options,
          attachments: pending.attachments,
          turnIndex: managed.turnCount,
        },
        undefined,
        pending.environment,
      );
      while (!(await generator.next()).done) {
        // Provisional observers do not survive restart. Durable final and delivery
        // projections remain the user-facing recovery outputs.
      }
    }
    try {
      await this.publishPendingFinals(conversationId);
    } catch {
      // The authoritative run is already terminal. The runtime-owned recovery
      // queue will redrive the durable final independently of task execution.
    }
  }

  async #recoverReadinessProjections(): Promise<number> {
    if (this.#recoveryDiscovered) return 0;
    await this.#prepareControlBasis();
    // Read one current obligation page. Further pages belong to the recovery
    // worker; unrelated conversations are not a service-readiness barrier.
    const page = await conversationRecoveryPage(this.#authority.authorityLog, this.#authority.artifacts);
    for (const conversationId of page.conversationIds) await this.#adopt(conversationId);
    const conversationIds = new Set(
      page.conversationIds.filter((conversationId) =>
        this.#acceptsConversationId(conversationId),
      ),
    );
    if (conversationIds.size > 0) {
      for (const conversationId of conversationIds) {
        this.#markRecovery(conversationId);
        try { await this.#prepareConversationBasis(conversationId); }
        catch (error) {
          if (!this.#adoptedConversations.has(conversationId) || !isConversationSourceEvidenceError(error)) throw error;
          this.#observeFailure(error, { phase: 'recovery', conversationId });
          conversationIds.delete(conversationId);
        }
      }
    }

    let resumed = 0;
    const queue = [...conversationIds];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const conversationId = queue.shift();
          if (!conversationId) return;
          resumed += await this.#withRecoveryClaim(conversationId, async () => {
            const journal = this.#journal(conversationId);
            let count = await this.#resumeLifecycleProjections(conversationId, journal);
            const authority = await journal.authorityState();
            if (authority.deleted && authority.pendingLifecycleProjections === 0) {
              this.#retireConversation(conversationId);
              return count;
            }
            count += await journal.resumeCommittedProjections();
            return count;
          });
        }
      }),
    );
    this.#recoveryDiscovered = true;
    this.#recoveryDiscoveryAfter = page.after;
    return resumed;
  }

  async #resumeLifecycleProjections(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<number> {
    const existing = this.#lifecycleProjectionClaims.get(conversationId);
    if (existing) return existing;
    const projection = this.#runLifecycleProjections(
      conversationId,
      journal,
    ).finally(() => {
      if (this.#lifecycleProjectionClaims.get(conversationId) === projection) {
        this.#lifecycleProjectionClaims.delete(conversationId);
      }
    });
    this.#lifecycleProjectionClaims.set(conversationId, projection);
    return projection;
  }

  async #runLifecycleProjections(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<number> {
    const state = await journal.authorityState();
    if (state.pendingLifecycleProjections === 0) {
      if (state.deleted) {
        await this.#recoverAuxiliary(conversationId);
        this.#retireConversation(conversationId);
      }
      return 0;
    }
    if (!this.#projectLifecycle) {
      throw new Error("Durable conversation lifecycle projection is not configured");
    }
    const projected = await journal.resumeLifecycleProjections(async (input) => {
      if (input.mutation === "delete") {
        await this.#authority.surfaceAssets?.revokeConversation(input.conversationId);
      }
      await this.#projectLifecycle!(input);
    });
    const after = await journal.authorityState();
    await this.#recoverAuxiliary(conversationId);
    if (after.deleted && after.pendingLifecycleProjections === 0) {
      this.#retireConversation(conversationId);
    }
    return projected;
  }

  #observeFailure(error: unknown, context: Parameters<NonNullable<ConversationProtocolRuntimeOptions["onFailure"]>>[1]): void {
    try { this.#onFailure?.(error, context); } catch { /* Observation must not replace recovery. */ }
  }

  #markRecovery(conversationId: string): void {
    this.#recoveryGeneration += 1;
    this.#recoveryConversations.delete(conversationId);
    this.#recoveryConversations.set(conversationId, this.#recoveryGeneration);
  }

  #clearRunClaims(runId: string): void {
    this.#schedulingRuns.delete(runId);
    this.#scheduledRuns.delete(runId);
    for (const [key, prepared] of this.#preparedAdmissions) {
      if (prepared.admission.runId === runId) this.#preparedAdmissions.delete(key);
    }
  }

  #retireConversation(conversationId: string): void {
    if ((this.#activeRecoveryClaims.get(conversationId) ?? 0) > 0) {
      this.#pendingConversationRetirements.add(conversationId);
      return;
    }
    this.#finalizeConversationRetirement(conversationId);
  }

  #finalizeConversationRetirement(conversationId: string): void {
    this.#pendingConversationRetirements.delete(conversationId);
    this.#journals.get(conversationId)?.discardProjectionCheckpoints();
    this.#journals.delete(conversationId);
    this.#recoveryConversations.delete(conversationId);
    for (const [assignmentId, assignedConversationId] of this.#assignmentConversations) {
      if (assignedConversationId === conversationId) this.#forgetAssignment(assignmentId);
    }
    for (const prepared of [...this.#preparedAdmissions.values()]) {
      if (prepared.conversationId === conversationId) {
        this.#clearRunClaims(prepared.admission.runId);
      }
    }
  }

  async #withRecoveryClaim<T>(
    conversationId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.#activeRecoveryClaims.set(
      conversationId,
      (this.#activeRecoveryClaims.get(conversationId) ?? 0) + 1,
    );
    let primaryFailed = false;
    let primaryError: unknown;
    try {
      return await run();
    } catch (error) {
      primaryFailed = true; primaryError = error;
      throw error;
    } finally {
      const remaining = (this.#activeRecoveryClaims.get(conversationId) ?? 1) - 1;
      if (remaining > 0) {
        this.#activeRecoveryClaims.set(conversationId, remaining);
      } else {
        this.#activeRecoveryClaims.delete(conversationId);
        if (this.#pendingConversationRetirements.has(conversationId)) {
          this.#finalizeConversationRetirement(conversationId);
        } else {
          try {
            await this.#retireSettledAssignments(conversationId, this.#journal(conversationId));
          } catch (cleanupError) {
            // A pressured read has not proved a route safe to retire. Keep the
            // route and its recovery obligation, without undoing the main result
            // or replacing a permanent main failure with retryable pressure.
            this.#markRecovery(conversationId);
            this.#observeFailure(cleanupError, { phase: "recovery", conversationId });
            if (maintenanceRetryDelayMs(cleanupError) === undefined) {
              if (primaryFailed) throw new AggregateError([primaryError, cleanupError], "Conversation operation and route cleanup failed");
              throw cleanupError;
            }
          }
        }
      }
    }
  }

  async #retireSettledAssignments(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<void> {
    const recoverable = new Set(
      (await journal.assignmentsAwaitingRecovery()).map(
        (candidate) => candidate.assignmentId,
      ),
    );
    for (const [assignmentId, assignedConversationId] of this.#assignmentConversations) {
      if (
        assignedConversationId === conversationId &&
        !recoverable.has(assignmentId)
      ) {
        this.#forgetAssignment(assignmentId);
      }
    }
  }

  #rememberAssignment(
    envelope: Extract<
      import("@zhixing/core/contracts").DispatchEnvelope,
      { execution: "conversation" }
    >,
    activation: AssignmentActivationProof<"conversation">,
  ): void {
    const capability = envelope.capabilities[0];
    if (!capability) throw new Error("Conversation assignment has no submission capability");
    this.#assignmentConversations.set(
      envelope.assignmentId,
      envelope.work.conversationId,
    );
    this.#assignmentArtifactAuthority.install(
      envelope.assignmentId,
      capability,
      activation,
    );
    this.#assignmentIngress.set(
      envelope.assignmentId,
      structuredClone(envelope.work.ingress),
    );
  }

  #requireExecutionResources() {
    const resources = this.#authority.executionResources;
    if (!resources) {
      throw new Error("Local executor resource authority is unavailable");
    }
    return resources;
  }

  async finalHistory(
    conversationId: string,
    afterCommitRevision: number,
  ): Promise<CommittedConversationResult[]> {
    await this.#adopt(conversationId);
    return this.#journal(conversationId).finalHistory(afterCommitRevision);
  }

  /** 推进取证目标只由 accepted run 的冻结 manifest 与已验签能力目录决定。 */
  async advancementEvidenceTarget(conversationId: string, runId: string) {
    await this.#adopt(conversationId);
    const dispatch = await this.#journal(conversationId).advancementEvidenceDispatch(runId);
    if (!dispatch) return undefined;
    const descriptor = this.#authority.executorCapabilities.snapshotFor(
      dispatch.envelope.executorId,
    )?.descriptor;
    if (!descriptor) return undefined;
    return {
      ownerEpoch: this.#ownerEpochFor(conversationId),
      ...(this.#authority.domain.kind === 'anchor' ? { anchorEpoch: this.#authority.domain.anchorEpoch } : {}),
      executorId: dispatch.envelope.executorId,
      workspace: dispatch.envelope.manifest.environment.workspace,
      descriptor,
    };
  }

  #assertControlSigningTenure(tenure: number | undefined): void {
    const domain = this.#authority.domain;
    if (domain.kind === 'anchor' ? tenure !== domain.anchorEpoch : tenure !== undefined) throw new TypeError('Control signing authority is outside its current tenure');
  }

  #forgetAssignment(assignmentId: string): void {
    const conversationId = this.#assignmentConversations.get(assignmentId);
    if (this.#activeAssignmentClaims.has(assignmentId) ||
        (conversationId && (this.#activeRecoveryClaims.get(conversationId) ?? 0) > 0)) return;
    this.#assignmentConversations.delete(assignmentId);
    this.#assignmentArtifactAuthority.remove(assignmentId);
    this.#assignmentIngress.delete(assignmentId);
    this.#interactions.releaseAssignment(assignmentId);
  }

  async worksceneContinuationSources(conversationId: string, query?: import("@zhixing/core/workscene/application").WorksceneContinuationQuery) {
    await this.#adopt(conversationId);
    if (query && 'root' in query) {
      const frontiers = await this.#journal(conversationId).worksceneContinuationFrontiers(query.root);
      return (await Promise.all(frontiers.map(async ref => {
        await this.#adopt(ref.conversationId);
        return this.#journal(ref.conversationId).worksceneContinuationSources({ runId: ref.runId });
      }))).flat();
    }
    return this.#journal(conversationId).worksceneContinuationSources(query);
  }

  async isWorksceneContinuationCurrent(source: { conversationId: string; runId: string }): Promise<boolean> {
    return isWorksceneContinuationCurrent((id, query) => this.worksceneContinuationSources(id, query), source);
  }

  #requiredManager(): ConversationManager {
    return this.#manager();
  }

  #requiredMutationPublisher(): ConversationMutationPublisher {
    if (!this.#mutationPublisher) {
      throw new Error("Conversation global mutation publisher is unavailable");
    }
    return this.#mutationPublisher;
  }
}

function ingressForTurn(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
  deviceId: string,
  receivedAt: string,
): IngressContext {
  const origin = input.options?.turnContext?.turnOrigin;
  const ingressId = input.options?.turnContext?.turnId ?? `ingress:${randomUUID()}`;
  if (origin?.target && origin.channel !== "rpc") {
    const responder = {
      channelId: origin.channel,
      platformSubject: origin.triggeredBy ?? "unknown",
    };
    return {
      kind: "channel",
      surfacePrincipal: surfacePrincipalForTurn(input),
      responder,
      replyTarget: origin.target,
      deviceId,
      ingressId,
      turnOrigin: origin,
      receivedAt,
    };
  }
  return {
    kind: "first-party",
    surfacePrincipal: surfacePrincipalForTurn(input),
    deviceId,
    ingressId,
    ...(origin ? { turnOrigin: origin } : {}),
    receivedAt,
  };
}

function admissionKey(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
): string | undefined {
  const turnId = input.options?.turnContext?.turnId;
  if (!turnId) return undefined;
  return canonicalize([
    input.conversationId,
    surfacePrincipalForTurn(input),
    turnId,
  ]);
}

function surfacePrincipalForTurn(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
): string {
  const origin = input.options?.turnContext?.turnOrigin;
  if (origin?.target && origin.channel !== "rpc") {
    return channelSurfacePrincipal({
      channelId: origin.channel,
      platformSubject: origin.triggeredBy ?? "unknown",
    });
  }
  const declared = input.options?.surfacePrincipal ??
    ("surfacePrincipal" in input ? input.surfacePrincipal : undefined);
  return declared ??
    `surface:${origin?.channel ?? "local"}:${origin?.triggeredBy ?? "local"}`;
}

function inputControlRequestId(ingress: IngressContext): string {
  return `input:${protocolDigest("ConversationInputIdentity", 1, {
    surfacePrincipal: ingress.surfacePrincipal,
    ingressId: ingress.ingressId,
  })}`;
}

function runOptionsForPending(
  pending: PendingConversationInput,
  abortSignal?: AbortSignal,
  recovered = false,
) {
  const ingress = pending.ingress;
  const invocation: ConversationInvocation = pending.invocation;
  return {
    source: invocation.source,
    ...(invocation.kind === "agent" && invocation.advancement
      ? { advancement: invocation.advancement }
      : {}),
    ...(abortSignal ? { abortSignal } : {}),
    turnContext: {
      turnId: ingress.ingressId,
      ...(ingress.kind === "channel"
        ? { emissionTarget: ingress.replyTarget }
        : {}),
      ...(ingress.turnOrigin
        ? {
            turnOrigin: recovered
              ? withoutRecoveredSurfaceCapabilities(ingress.turnOrigin)
              : ingress.turnOrigin,
          }
        : {}),
    },
    surfacePrincipal: ingress.surfacePrincipal,
  };
}

function withoutRecoveredSurfaceCapabilities(
  origin: NonNullable<IngressContext["turnOrigin"]>,
): NonNullable<IngressContext["turnOrigin"]> {
  if (origin.surface?.capabilities?.postTurnControl !== true) return origin;
  return {
    ...origin,
    surface: {
      ...origin.surface,
      capabilities: {
        ...origin.surface.capabilities,
        postTurnControl: false,
      },
    },
  };
}

function assignmentContext(
  envelope: Extract<import("@zhixing/core/contracts").DispatchEnvelope, { execution: "conversation" }>,
): AuthorityCallContext {
  const capability = envelope.capabilities[0];
  if (!capability) throw new Error("Conversation assignment has no submission capability");
  return {
    principal: { kind: "assignment", capability },
    requestId: `submission:${envelope.assignmentId}`,
    deadlineAt: capability.expiry,
  };
}

function assignmentResourceContext(
  envelope: Extract<import("@zhixing/core/contracts").DispatchEnvelope, { execution: "conversation" }>,
): AuthorityCallContext {
  const context = assignmentContext(envelope);
  return {
    ...context,
    requestId: `resource-usage:${envelope.assignmentId}`,
    deadlineAt:
      Date.parse(context.deadlineAt) <= Date.parse(envelope.resourceLease.expiry)
        ? context.deadlineAt
        : envelope.resourceLease.expiry,
  };
}

function createSubmissionAuthorizer(
  executorIdFor: (assignmentId: string) => string,
  verifier: ProtocolSignatureVerifier,
): AssignmentSubmissionAuthorizer {
  const authenticate: AssignmentSubmissionAuthorizer["authenticate"] = (
    context,
    identity,
  ) => {
    if (context.principal.kind !== "assignment") {
      throw new Error("Assignment submission requires an assignment capability");
    }
    assertPrincipalAllowsAuthorityMethod("assignment", identity.method);
    const capability = validateAuthorityCapability(
      context.principal.capability,
      verifier,
    );
    if (
      // capability 必须属于该 assignment 被指派的 executor——本地或远端;
      // 写死 owner 本地 executorId 会把一切远端提交拒之门外。
      capability.executorId !== executorIdFor(identity.assignmentId) ||
      capability.assignmentId !== identity.assignmentId ||
      !capability.methods.includes(identity.method) ||
      Date.parse(context.deadlineAt) > Date.parse(capability.expiry)
    ) {
      throw new Error("Assignment capability does not authorize this submission");
    }
  };
  return {
    authenticate,
    authorize(context, authorization) {
      authenticate(context, authorization);
    },
  };
}

function createDispatchContexts(options: {
  readonly signer: ProtocolSigner;
  readonly deviceId: string;
  readonly ownerEpochFor: (assignmentId: string) => number;
  readonly anchorEpochFor: (assignmentId: string) => number | undefined;
  readonly assertSigningAuthority: (assignmentId: string, tenure: number | undefined) => void;
  readonly clock: () => string;
  readonly conversationIdFor: (assignmentId: string) => string;
}): InProcessDispatchContextFactory {
  return {
    create(assignmentId, method, request) {
      const now = Date.parse(options.clock());
      const tenure = options.anchorEpochFor(assignmentId);
      options.assertSigningAuthority(assignmentId, tenure);
      const renewalWindow = Math.floor(now / CONTROL_RENEWAL_INTERVAL_MS);
      const renewalSeq = renewalWindow + Number(tenure !== undefined);
      const issuedAt = new Date(
        renewalWindow * CONTROL_RENEWAL_INTERVAL_MS,
      ).toISOString();
      const expiry = new Date(
        renewalWindow * CONTROL_RENEWAL_INTERVAL_MS + CONTEXT_TTL_MS,
      ).toISOString();
      const scope = {
        execution: "conversation" as const,
        conversationId: options.conversationIdFor(assignmentId),
        ownerEpoch: options.ownerEpochFor(assignmentId),
      };
      const controlPayload = {
        ...(tenure === undefined ? { v: 1 as const } : { v: 2 as const, anchorEpoch: tenure }),
        controlLeaseId: `control-${assignmentId}`,
        assignmentId,
        authority: scope,
        renewalSeq,
        issuedAt,
        expiry,
      };
      const controlLease: ControlLease = {
        ...controlPayload,
        signature: options.signer.sign("ControlLease", controlPayload.v, controlPayload),
      };
      const requestDigest = ownerControlRequestDigest({
        method,
        assignmentId,
        authority: scope,
        requestId: request.requestId,
        body: request.body,
      });
      const payload = {
        ...(tenure === undefined ? { v: 1 as const } : { v: 2 as const, anchorEpoch: tenure }),
        assignmentId,
        scope,
        methods: [method],
        callerDeviceId: options.deviceId,
        requestId: request.requestId,
        requestDigest,
        controlLease,
        issuedAt,
        expiry,
      };
      const grant: OwnerControlGrant = {
        ...payload,
        signature: options.signer.sign("OwnerControlGrant", payload.v, payload),
      };
      return {
        principal: { kind: "owner-control", grant },
        requestId: request.requestId,
        deadlineAt: expiry,
      };
    },
  };
}

function reservationOriginForSource(source: string | undefined): ReservationOrigin {
  return source === "advancement"
    ? { admissionClass: "advancement", entry: "advancement-control" }
    : source === "scheduler"
      ? { admissionClass: "scheduler", entry: "schedule-trigger" }
      : { admissionClass: "interactive", entry: "conversation-input" };
}

function conversationAssignmentId(runId: string, attempt: number): string {
  return `assignment:${protocolDigest("ConversationAssignmentIdentity", 1, {
    runId,
    attempt,
  })}`;
}

function resourceHostContext(
  method: "reservation.prepareAssignmentRoot",
  assignmentId: string,
  now: string,
): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "resource-governor" },
    requestId: `resource:${assignmentId}:${method}`,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
  };
}

function usageReporterContext(
  executorId: string,
  reportDigest: string,
  now: string,
): AuthorityCallContext {
  return {
    principal: { kind: "usage-reporter", executorId },
    requestId: `usage-report:${reportDigest}`,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
  };
}

function runFailureReason(result: RunResult["agentResult"]): string {
  if (result.reason === "error") return result.error.message;
  if (result.reason === "max_turns") return "达到最大轮次限制";
  if (result.reason === "aborted") return "运行已中止";
  return "运行未完成";
}

function executionFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelledRunResult(result: RunResult): RunResult {
  if (result.agentResult.reason === "aborted") return result;
  return {
    ...result,
    agentResult: {
      reason: "aborted",
      usage: result.agentResult.usage,
    },
  };
}

function replayCommittedRun(
  runRecord: TranscriptRunRecord,
  windowCompact: RunResult["windowCompact"],
): RunResult {
  const message = [...runRecord.messages]
    .reverse()
    .find((candidate) => candidate.role === "assistant");
  if (!message || message.role !== "assistant") {
    throw new Error("Committed conversation run has no assistant result");
  }
  const usage = runRecord.usage ?? { inputTokens: 0, outputTokens: 0 };
  return {
    agentResult: { reason: "completed", message, usage },
    runRecord: {
      timestamp: runRecord.timestamp,
      messages: [...runRecord.messages],
      usage,
      ...(runRecord.source ? { source: runRecord.source } : {}),
      ...(runRecord.advancement ? { advancement: runRecord.advancement } : {}),
      ...(runRecord.perspectives ? { perspectives: runRecord.perspectives } : {}),
      ...(runRecord.postTurnControl ? { postTurnControl: runRecord.postTurnControl } : {}),
    },
    ...(runRecord.postTurnControl ? { pendingPostTurnControl: runRecord.postTurnControl } : {}),
    ...(windowCompact ? { windowCompact } : {}),
    newMessages: runRecord.messages.slice(1),
    durationMs: 0,
  };
}



function requireRuntimeSecuritySnapshot(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["securitySnapshot"]>> {
  const snapshot = runtime.securitySnapshot?.();
  if (snapshot === undefined) {
    throw new Error("Recovered conversation runtime lacks a security snapshot");
  }
  return snapshot;
}

function requireRuntimeExecutionProfile(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["executionProfile"]>> {
  const profile = runtime.executionProfile?.();
  if (profile === undefined) {
    throw new Error("Recovered conversation runtime lacks an execution profile");
  }
  return profile;
}

function requireRuntimeExecutionPermissionRules(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["executionPermissionRules"]>> {
  const rules = runtime.executionPermissionRules?.();
  if (rules === undefined) {
    throw new Error(
      "Recovered conversation runtime lacks an execution permission snapshot",
    );
  }
  return rules;
}

function conversationIdFromSubmissionContext(context: AuthorityCallContext): string {
  const principal = context.principal;
  if (
    principal.kind !== "assignment" ||
    principal.capability.scope.execution !== "conversation"
  ) {
    throw new TypeError("Conversation submission requires a conversation assignment capability");
  }
  return principal.capability.scope.conversationId;
}

function asConversationMirrorBatch(
  batch: InteractionMirrorBatch,
): ConversationInteractionMirrorBatch {
  for (const entry of batch.entries) {
    if (
      entry.outcome.t === "answered" &&
      entry.outcome.authority.via !== "surface-ticket"
    ) {
      throw new TypeError("Conversation interaction answer requires a surface ticket");
    }
  }
  return batch as ConversationInteractionMirrorBatch;
}

function conversationExecutorRequirement(
  invocation: ConversationInvocation,
  ingress: IngressContext,
): import("./conversation-executor-dispatch.js").ConversationExecutorRequirement {
  // Conversation owns portability policy. The Host sees only the already
  // decided placement requirement and never interprets invocation or ingress.
  return invocation.kind === "agent" &&
      invocation.advancement === undefined &&
      ((invocation.source === "interactive" && ingress.kind === "first-party") ||
        (invocation.source === "channel" && ingress.kind === "channel"))
    ? { placement: "authorized-device" }
    : { placement: "current-device" };
}
