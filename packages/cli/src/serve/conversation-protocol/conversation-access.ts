import { parseConversationId, parseLocalConversationId } from "@zhixing-ai/core/conversation";
import type {
  AssignmentActivationProof,
  AuthorityCallContext,
  AuthorityCapability,
  AuthorityError,
  ConversationRecoveryRequest,
  ConversationStatusNotice,
  IngressContext,
  RunSubmissionPort,
  SessionStatePort,
} from "@zhixing-ai/core/contracts";
import { validateAuthorityCapability } from "@zhixing-ai/core/protocol";
import { maintenanceRetryDelayMs } from "@zhixing-ai/core/resources";
import {
  isWorksceneContinuationCurrent,
  type WorksceneContinuationQuery,
} from "@zhixing-ai/core/workscene/application";
import { createInitialControlEnvelope } from "@zhixing-ai/owner-kernel/control-admission";
import {
  ConversationRunJournal,
  pendingAdvancementConversations,
  type AssignmentSubmissionIdentity,
  type AssignmentSubmissionPreflightPort,
  type CommittedConversationResult,
  type ConversationCommitAuthority,
  type ConversationMutationPublisher,
  type TrustRuleHitBatchState,
  type TrustRuleHitPort,
  type ConversationTrustSedimentPort,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import type { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import {
  isConversationSourceEvidenceError,
  readCommittedConversationTransferHeader,
  resolveConversationPublicationOwner,
  resolveCurrentConversationAuthority,
  type ConversationTransferPublication,
} from "@zhixing-ai/owner-kernel/conversation-transfer";
import type {
  DurableConversationSessionWriteInput,
  DurableConversationSessionWriteResult,
} from "@zhixing-ai/owner-kernel/run-turn";
import { ConversationSessionStateAdapter } from "@zhixing-ai/owner-kernel/session-state-adapter";
import type {
  ConversationAssignmentArtifactAuthorityIndex,
  ConversationAssignmentStagingPort,
  ConversationExecutorDispatchApplication,
} from "../conversation-executor-dispatch.js";
import type { ConversationOwnerRuntimeStack } from "../conversation-owner-runtime.js";
import type { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import type { CommittedConversationTransferPort } from "./contracts.js";
import {
  asConversationMirrorBatch,
  conversationIdFromSubmissionContext,
  createDispatchContexts,
  createSubmissionAuthorizer,
  routineStatusRun,
  type AuthorityScopeState,
  type RuntimeObligationScope,
} from "./runtime-obligation-scope.js";

export interface ConversationAccessHost {
  ensureSession(conversationId: string): Promise<void>;
  sessionExists(conversationId: string): Promise<boolean>;
  writeSession(
    input: DurableConversationSessionWriteInput,
  ): Promise<DurableConversationSessionWriteResult>;
  worksceneContinuationSources(
    conversationId: string,
    query?: WorksceneContinuationQuery,
  ): ReturnType<ConversationRunJournal["worksceneContinuationSources"]>;
}

export interface ConversationAccessOptions {
  readonly authority: ConversationOwnerRuntimeStack;
  readonly scope: RuntimeObligationScope;
  readonly host: ConversationAccessHost;
  readonly requiredManager: () => ConversationManager;
  readonly storedIdentityExists?: (conversationId: string) => Promise<boolean>;
  readonly clock: () => string;
  readonly executorDispatch: ConversationExecutorDispatchApplication;
  readonly assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly assignmentStaging?: ConversationAssignmentStagingPort;
  readonly interactions: DurableConversationInteractionObserver;
  readonly trustSediments?: ConversationTrustSedimentPort;
  readonly trustRuleHits?: TrustRuleHitPort;
  readonly onStatus?: (notice: ConversationStatusNotice) => void | Promise<void>;
  readonly statusListeners: Set<(notice: ConversationStatusNotice) => void | Promise<void>>;
  readonly observeFailure: (
    error: unknown,
    context: { readonly phase: "run" | "recovery"; readonly conversationId: string; readonly runId?: string },
  ) => void;
}

/**
 * Owns `journals`, first-touch adoption (`#adopt` / `#installAdoption`),
 * `routeRevision`-guarded assignment routing, session directory queries,
 * and stable late-bound publisher/transfer delegates within `AuthorityScope`.
 */
export class ConversationAccess {
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #scope: RuntimeObligationScope;
  readonly #host: ConversationAccessHost;
  readonly #requiredManager: () => ConversationManager;
  readonly #storedIdentityExists: ConversationAccessOptions["storedIdentityExists"];
  readonly #clock: () => string;
  readonly #executorDispatch: ConversationExecutorDispatchApplication;
  readonly #assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly #assignmentStaging: ConversationAssignmentStagingPort | undefined;
  readonly #trustSediments: ConversationTrustSedimentPort | undefined;
  readonly #trustRuleHits: TrustRuleHitPort | undefined;
  readonly #onStatus: ConversationAccessOptions["onStatus"];
  readonly #statusListeners: ConversationAccessOptions["statusListeners"];
  readonly #observeFailure: ConversationAccessOptions["observeFailure"];
  #sessionState: SessionStatePort | undefined;
  #committedTransfers: CommittedConversationTransferPort | undefined;
  #mutationPublisher: ConversationMutationPublisher | undefined;
  readonly #mutationPublisherProxy: ConversationMutationPublisher;

  constructor(options: ConversationAccessOptions) {
    this.#authority = options.authority;
    this.#scope = options.scope;
    this.#host = options.host;
    this.#requiredManager = options.requiredManager;
    this.#storedIdentityExists = options.storedIdentityExists;
    this.#clock = options.clock;
    this.#executorDispatch = options.executorDispatch;
    this.#assignmentArtifactAuthority = options.assignmentArtifactAuthority;
    this.#assignmentStaging = options.assignmentStaging;
    this.#trustSediments = options.trustSediments;
    this.#trustRuleHits = options.trustRuleHits;
    this.#onStatus = options.onStatus;
    this.#statusListeners = options.statusListeners;
    this.#observeFailure = options.observeFailure;
    const access = this;
    this.#mutationPublisherProxy = {
      get readProjectionIds() {
        return access.#mutationPublisher?.readProjectionIds ?? [];
      },
      collectStagedReferences: async (records) =>
        (await this.#requiredMutationPublisher().collectStagedReferences?.(records)) ?? [],
      decideGlobalBatchAtPrefix: (input) =>
        this.#requiredMutationPublisher().decideGlobalBatchAtPrefix(input),
      prepareGlobalBatchAtPrefix: async (input) => {
        const publisher = this.#requiredMutationPublisher();
        return await (
          publisher.prepareGlobalBatchAtPrefix?.(input) ??
          Promise.resolve(publisher.decideGlobalBatchAtPrefix(input)).then((outcomes) => ({
            outcomes,
            records: [],
          }))
        );
      },
      afterGlobalCommit: async (input) => {
        try {
          await this.#requiredMutationPublisher().afterGlobalCommit?.(input);
        } catch (error) {
          this.#observeFailure(error, { phase: "run", conversationId: input.conversationId });
        }
      },
      apply: (input) => this.#requiredMutationPublisher().apply(input),
    };
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

  bindCommittedConversationTransfers(port: CommittedConversationTransferPort): () => void {
    if (this.#committedTransfers && this.#committedTransfers !== port) {
      throw new Error("Committed conversation transfers are already bound");
    }
    this.#committedTransfers = port;
    return () => {
      if (this.#committedTransfers === port) this.#committedTransfers = undefined;
    };
  }

  needsAdoption(conversationId: string): boolean {
    return this.#needsAdoption(conversationId);
  }

  #needsAdoption(conversationId: string): boolean {
    const scopeState = this.#scope.current;
    return (
      this.#committedTransfers !== undefined &&
      !this.#authority.acceptsConversationId(conversationId) &&
      !scopeState.adoptedConversations.has(conversationId) &&
      !scopeState.unavailableTransfers.has(conversationId) &&
      !!parseLocalConversationId(conversationId)
    );
  }

  adopt(conversationId: string): Promise<void> {
    return this.#adopt(conversationId);
  }

  #adopt(conversationId: string): Promise<void> {
    if (!this.#needsAdoption(conversationId)) return Promise.resolve();
    const scopeState = this.#scope.current;
    let adopting = scopeState.adopting.get(conversationId);
    if (!adopting) {
      adopting = this.#installAdoption(conversationId).finally(() => {
        if (scopeState.adopting.get(conversationId) === adopting) {
          scopeState.adopting.delete(conversationId);
        }
      });
      scopeState.adopting.set(conversationId, adopting);
    }
    return adopting;
  }

  async #installAdoption(conversationId: string): Promise<void> {
    const scopeState = this.#scope.current;
    const port = this.#committedTransfers!;
    for (const transferId of await port.committedFor(conversationId)) {
      if (!this.#scope.isCurrent(scopeState)) return;
      if (
        scopeState.adoptedConversations.get(conversationId)?.transferId === transferId &&
        !scopeState.unavailableTransfers.has(conversationId)
      ) continue;
      let publication: ConversationTransferPublication;
      try {
        publication = await port.load(transferId);
      } catch (error) {
        if (!isConversationSourceEvidenceError(error)) throw error;
        await this.retainUnavailableCommittedConversationTransfer(transferId, error as Error);
        continue;
      }
      const prepared = await this.prepareCommittedConversationTransfer({
        manifest: publication.manifest,
        source: publication.source,
      });
      if (!this.#scope.isCurrent(scopeState)) return;
      if (
        scopeState.adoptedConversations.get(conversationId)?.transferId === transferId &&
        !scopeState.unavailableTransfers.has(conversationId)
      ) continue;
      prepared.publish();
    }
  }

  /** Installs a committed immutable source prefix before exposing the adopted session. */
  async retainUnavailableCommittedConversationTransfer(
    transferId: string,
    error: Error,
  ): Promise<void> {
    const scopeState = this.#scope.current;
    const { state } = await readCommittedConversationTransferHeader(
      this.#authority.authorityLog,
      this.#authority.verifier,
      transferId,
    );
    const id = state.identity.conversationId;
    const owner = await resolveCurrentConversationAuthority(
      this.#authority.authorityLog,
      this.#authority.verifier,
      id,
      { deviceId: this.#authority.deviceId, ownerEpoch: this.#authority.ownerEpoch },
    );
    if (owner.state !== "current" || owner.deviceId !== this.#authority.deviceId) {
      throw new TypeError("Unavailable transfer belongs to another current owner");
    }
    if (!this.#scope.isCurrent(scopeState)) return;
    scopeState.adoptedConversations.set(id, {
      transferId,
      ownerEpoch: owner.ownerEpoch,
      clearedThroughLsn: 0,
    });
    scopeState.unavailableTransfers.set(id, { transferId, error });
    scopeState.journals.delete(id);
    this.#scope.markRecoveryInScope(scopeState, id);
    this.#observeFailure(error, { phase: "recovery", conversationId: id });
  }

  async installCommittedConversationTransfer(input: {
    readonly manifest: ConversationTransferPublication["manifest"];
    readonly source: ConversationTransferPublication["source"];
  }): Promise<void> {
    const prepared = await this.prepareCommittedConversationTransfer(input);
    prepared.publish();
  }

  async prepareCommittedConversationTransfer(input: {
    readonly manifest: ConversationTransferPublication["manifest"];
    readonly source: ConversationTransferPublication["source"];
  }): Promise<{ readonly publish: () => void }> {
    const scopeState = this.#scope.current;
    const owner = await resolveConversationPublicationOwner(
      this.#authority.authorityLog,
      this.#authority.verifier,
      input.manifest,
      input.source.manifestRef,
      this.#authority.deviceId,
    );
    const conversationId = input.manifest.conversationId;
    const existing = scopeState.adoptedConversations.get(conversationId);
    if (
      existing &&
      (existing.transferId !== input.manifest.transferId ||
        existing.ownerEpoch > owner.ownerEpoch)
    ) {
      throw new Error("Conversation already has another committed transfer generation");
    }
    const journal = this.createJournal(conversationId, owner.ownerEpoch, scopeState);
    const meta = (await input.source.read((view) =>
      view.get("directory/" + JSON.stringify(conversationId) + ":meta"),
    )) as { readonly clearId?: string; readonly clearedLsn?: number } | undefined;
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
        if (!this.#scope.isCurrent(scopeState)) return;
        scopeState.unavailableTransfers.delete(conversationId);
        scopeState.adoptedConversations.set(conversationId, adopted);
        scopeState.journals.set(conversationId, journal);
        scopeState.sessionIdentities.set(conversationId, Promise.resolve());
        this.#scope.markRecoveryInScope(scopeState, conversationId);
      },
    });
  }

  ownerEpochFor(
    conversationId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): number {
    return (
      scopeState.adoptedConversations.get(conversationId)?.ownerEpoch ??
      this.#authority.ownerEpoch
    );
  }

  acceptsConversationId(
    conversationId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): boolean {
    return (
      this.#authority.acceptsConversationId(conversationId) ||
      scopeState.adoptedConversations.has(conversationId)
    );
  }

  journal(
    conversationId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): ConversationRunJournal {
    const unavailable = scopeState.unavailableTransfers.get(conversationId);
    if (unavailable) throw unavailable.error;
    if (!this.acceptsConversationId(conversationId, scopeState)) {
      throw new Error("Conversation identity does not belong to this owner domain");
    }
    const existing = scopeState.journals.get(conversationId);
    if (existing) return existing;
    const journal = this.createJournal(conversationId, undefined, scopeState);
    scopeState.journals.set(conversationId, journal);
    return journal;
  }

  journalForQuery(
    conversationId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): ConversationRunJournal {
    if (!this.acceptsConversationId(conversationId, scopeState)) {
      throw new Error("Conversation identity does not belong to this owner domain");
    }
    return (
      scopeState.journals.get(conversationId) ??
      this.createJournal(conversationId, undefined, scopeState)
    );
  }

  createJournal(
    conversationId: string,
    ownerEpoch = this.ownerEpochFor(conversationId),
    scopeState: AuthorityScopeState = this.#scope.current,
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
      authority: this.#commitAuthority(conversationId, scopeState),
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
      ...(this.#trustSediments ? { trustSediments: this.#trustSediments } : {}),
      ...(this.#trustRuleHits ? { trustRuleHits: this.#trustRuleHits } : {}),
    });
    journal.onStatus(async (notice) => {
      this.#scope.markRecoveryInScope(
        scopeState,
        conversationId,
        routineStatusRun(notice.state, notice.ref.runId),
      );
      if (!this.#scope.isCurrent(scopeState)) return;
      await this.#onStatus?.(notice);
      for (const listener of this.#statusListeners) await listener(notice);
    });
    return journal;
  }

  #commitAuthority(
    conversationId: string,
    scopeState: AuthorityScopeState,
  ): ConversationCommitAuthority {
    return {
      decideAtPrefix: (decision) => {
        if (
          decision.conversationId !== conversationId ||
          decision.ownerEpoch !== this.ownerEpochFor(conversationId, scopeState)
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

  conversationIdForAssignment(
    assignmentId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): string {
    const route = scopeState.assignmentRoutes.get(assignmentId);
    if (!route) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return route.conversationId;
  }

  assignmentIngress(assignmentId: string): IngressContext {
    const ingress = this.#scope.current.assignmentIngress.get(assignmentId);
    if (!ingress) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return structuredClone(ingress);
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

  assertControlSigningTenure(tenure: number | undefined): void {
    const domain = this.#authority.domain;
    if (domain.kind === "anchor" ? tenure !== domain.anchorEpoch : tenure !== undefined) {
      throw new TypeError("Control signing authority is outside its current tenure");
    }
  }

  createDefaultDispatchContexts() {
    return createDispatchContexts({
      signer: this.#authority.signer,
      deviceId: this.#authority.deviceId,
      ownerEpochFor: (assignmentId) =>
        this.ownerEpochFor(this.conversationIdForAssignment(assignmentId)),
      anchorEpochFor: () =>
        this.#authority.domain.kind === "anchor"
          ? this.#authority.domain.anchorEpoch
          : undefined,
      assertSigningAuthority: (_id, tenure) => this.assertControlSigningTenure(tenure),
      clock: this.#clock,
      conversationIdFor: (assignmentId) => this.conversationIdForAssignment(assignmentId),
    });
  }

  async primeAssignmentRouting(
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<void> {
    for (const candidate of await journal.assignmentsAwaitingRecovery()) {
      this.#scope.rememberAssignmentInScope(
        scopeState,
        candidate.dispatch.envelope,
        candidate.dispatch.activation,
        this.#assignmentArtifactAuthority,
      );
    }
    for (const candidate of await journal.pendingDispatches()) {
      this.#scope.rememberAssignmentInScope(
        scopeState,
        candidate.envelope,
        candidate.activation,
        this.#assignmentArtifactAuthority,
      );
    }
  }

  capturedAssignmentRouting(scopeState: AuthorityScopeState = this.#scope.current) {
    const bindings = new Map<
      string,
      {
        conversationId: string;
        authority: ReturnType<ConversationAssignmentArtifactAuthorityIndex["read"]>;
      }
    >();
    const capture = (assignmentId: string) => {
      let binding = bindings.get(assignmentId);
      if (!binding) {
        binding = {
          conversationId: this.conversationIdForAssignment(assignmentId, scopeState),
          authority: this.#assignmentArtifactAuthority.read(assignmentId),
        };
        bindings.set(assignmentId, binding);
      }
      return binding;
    };
    for (const assignmentId of scopeState.assignmentRoutes.keys()) capture(assignmentId);
    return {
      contexts: createDispatchContexts({
        signer: this.#authority.signer,
        deviceId: this.#authority.deviceId,
        clock: this.#clock,
        conversationIdFor: (id) => capture(id).conversationId,
        ownerEpochFor: (id) => capture(id).authority.activation.ref.ownerEpoch,
        anchorEpochFor: (id) =>
          capture(id).authority.capability.anchorEpoch ??
          (capture(id).authority.activation.ref.ownerEpoch ===
            this.ownerEpochFor(capture(id).conversationId, scopeState) &&
          this.#authority.domain.kind === "anchor"
            ? this.#authority.domain.anchorEpoch
            : undefined),
        assertSigningAuthority: (_id, tenure) => this.assertControlSigningTenure(tenure),
      }),
      executorIdForAssignment: (id: string) => capture(id).authority.capability.executorId,
      submissionContext: (id: string): AuthorityCallContext => {
        const capability = capture(id).authority.capability;
        return {
          principal: { kind: "assignment", capability },
          requestId: `submission:${id}`,
          deadlineAt: capability.expiry,
        };
      },
    };
  }

  createRecoveryDispatcher(
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState = this.#scope.current,
  ) {
    return this.#executorDispatch.recoveryDispatcher({
      journal,
      ...this.capturedAssignmentRouting(scopeState),
    });
  }

  submissionMeshRole(): {
    readonly submission: RunSubmissionPort;
    readonly submissionGuard: AssignmentSubmissionPreflightPort;
  } {
    const journalFor = async (context: AuthorityCallContext) => {
      const conversationId = conversationIdFromSubmissionContext(context);
      await this.#adopt(conversationId);
      return this.journal(conversationId);
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

  ensureSession(conversationId: string): Promise<void> {
    if (this.#needsAdoption(conversationId)) {
      return this.#adopt(conversationId).then(() =>
        this.#ensureAcceptedSession(conversationId),
      );
    }
    return this.#ensureAcceptedSession(conversationId);
  }

  #ensureAcceptedSession(conversationId: string): Promise<void> {
    const scopeState = this.#scope.current;
    if (!this.acceptsConversationId(conversationId, scopeState)) {
      return Promise.reject(
        new Error("Conversation identity does not belong to this owner domain"),
      );
    }
    const existing = scopeState.sessionIdentities.get(conversationId);
    if (existing) return existing;
    const establishing = this.#establishSession(conversationId, scopeState);
    scopeState.sessionIdentities.set(conversationId, establishing);
    void establishing.catch(() => {
      if (scopeState.sessionIdentities.get(conversationId) === establishing) {
        scopeState.sessionIdentities.delete(conversationId);
      }
    });
    return establishing;
  }

  async #establishSession(
    conversationId: string,
    scopeState: AuthorityScopeState,
  ): Promise<void> {
    const scope = {
      domain: "conversation" as const,
      conversationId,
      ownerEpoch: this.ownerEpochFor(conversationId, scopeState),
    };
    if (
      this.#authority.surfaceAssets &&
      (await this.#authority.surfaceAssets.ownsScope(scope))
    ) {
      return;
    }

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
      const message =
        outcome.result.status === "rejected"
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

  async listSessions(): Promise<readonly string[]> {
    const scopeState = this.#scope.current;
    const ids = new Set(await this.#authority.controlAdmission.listCreatedConversationIds());
    for (const conversationId of scopeState.adoptedConversations.keys()) ids.add(conversationId);
    for (const conversationId of (await this.#committedTransfers?.conversations()) ?? []) {
      ids.add(conversationId);
    }
    const active: string[] = [];
    for (const conversationId of ids) {
      await this.#adopt(conversationId);
      if (!this.acceptsConversationId(conversationId)) continue;
      if (!(await this.journalForQuery(conversationId).recoveryDeleted())) {
        active.push(conversationId);
      }
    }
    return active.sort((left, right) => left.localeCompare(right, "en-US"));
  }

  async sessionExists(conversationId: string): Promise<boolean> {
    await this.#adopt(conversationId);
    const scopeState = this.#scope.current;
    if (!this.acceptsConversationId(conversationId, scopeState)) return false;
    if (!scopeState.adoptedConversations.has(conversationId)) {
      if (!(await this.#authority.controlAdmission.hasCreatedConversation(conversationId))) {
        return false;
      }
    }
    return !(await this.journalForQuery(conversationId, scopeState).recoveryDeleted());
  }

  get sessionState(): SessionStatePort {
    if (!this.#sessionState) {
      this.#sessionState = new ConversationSessionStateAdapter({
        journalFor: async (conversationId) => {
          await this.#adopt(conversationId);
          return this.journal(conversationId);
        },
        sessionExists: async (conversationId) =>
          (await this.#host.sessionExists(conversationId)) ||
          (await this.#storedIdentityExists?.(conversationId)) === true,
        establishIdentity: (conversationId) => this.#host.ensureSession(conversationId),
        mutateControl: async (conversationId, mutation, ctx) => {
          await this.#adopt(conversationId);
          const principal =
            ctx.principal.kind === "surface"
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
          if (
            !(await this.journal(conversationId).authorityState()).hasDurableIdentity &&
            (await this.#storedIdentityExists?.(conversationId)) === true
          ) {
            await this.#host.ensureSession(conversationId);
          }
          const result = await this.#host.writeSession({
            conversationId,
            requestId: ctx.requestId,
            mutation,
            principal,
            conversationExists: () => this.#host.sessionExists(conversationId),
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
          const scopeState = this.#scope.current;
          if (
            capability.scope.conversationId !== conversationId ||
            !("ownerEpoch" in capability) ||
            capability.ownerEpoch !== this.ownerEpochFor(conversationId, scopeState) ||
            scopeState.assignmentRoutes.get(capability.assignmentId)?.conversationId !==
              conversationId ||
            !capability.methods.includes("session.mutate")
          ) {
            throw new Error("Assignment capability does not authorize this session mutation");
          }
          const staging = this.#assignmentStaging;
          if (!staging) {
            throw new Error("Local assignment staging is unavailable in this owner topology");
          }
          const staged = await staging.stageSession(capability.assignmentId, {
            mutation,
            requestId: ctx.requestId,
          });
          return { revision: staged.recordSeq };
        },
      });
    }
    return this.#sessionState;
  }

  async remoteRunInput(
    address: { conversationId: string; runId: string; assignmentId: string },
    executorId: string,
  ) {
    await this.#adopt(address.conversationId);
    const journal = this.journal(address.conversationId);
    await journal.assertInputExecutor(address.runId, address.assignmentId, executorId);
    return {
      open: () => journal.openRunInput(address.runId, address.assignmentId).then(() => undefined),
      receive: (boundary: { boundary: number; closing: boolean }) =>
        journal.receiveRunInput(address.runId, address.assignmentId, boundary),
      close: () => journal.closeRunInput(address.runId, address.assignmentId),
    };
  }

  async inspectMessage(conversationId: string, messageId: string) {
    if (!(await this.#host.sessionExists(conversationId))) return undefined;
    return this.journal(conversationId).messageStatus(messageId);
  }

  async messageInputsOutsideHistory(conversationId: string) {
    if (!(await this.#host.sessionExists(conversationId))) {
      return { inputs: [], truncated: false };
    }
    return this.journal(conversationId).messageInputsOutsideHistory();
  }

  async recoveryPage(request: ConversationRecoveryRequest) {
    const id = request.conversationId;
    await this.#adopt(id);
    const scopeState = this.#scope.current;
    if (!this.acceptsConversationId(id, scopeState)) {
      throw Error("Conversation recovery owner is unavailable");
    }
    const exists =
      scopeState.adoptedConversations.has(id) ||
      (await this.#authority.controlAdmission.hasCreatedConversation(id)) ||
      (await this.#storedIdentityExists?.(id)) === true;
    if (!exists || (await this.journal(id, scopeState).recoveryDeleted())) {
      throw Error("Conversation recovery owner is unavailable");
    }
    return this.journal(request.conversationId, scopeState).recoveryPage(request);
  }

  async findRunByIngress(
    conversationId: string,
    ingressId: string,
    source: import("@zhixing-ai/core/contracts").ConversationInvocation["source"],
  ) {
    await this.#adopt(conversationId);
    return this.journal(conversationId).runByIngress(ingressId, source);
  }

  async findInteractionOutcome(conversationId: string, requestId: string) {
    await this.#adopt(conversationId);
    return this.journal(conversationId).interactionOutcome(requestId);
  }

  async activeRunSecurityFacts(conversationId: string): Promise<
    | (NonNullable<Awaited<ReturnType<ConversationRunJournal["assignmentSecurityFacts"]>>> & {
        readonly assignmentId: string;
      })
    | undefined
  > {
    const scopeState = this.#scope.current;
    for (const [assignmentId] of scopeState.activeAssignmentClaims) {
      if (scopeState.assignmentRoutes.get(assignmentId)?.conversationId !== conversationId) {
        continue;
      }
      await this.#adopt(conversationId);
      const facts = await this.journal(conversationId).assignmentSecurityFacts(assignmentId);
      if (facts) return { ...facts, assignmentId };
    }
    return undefined;
  }

  async trustSedimentMirrored(
    conversationId: string,
    assignmentId: string,
    requestId: string,
  ): Promise<boolean> {
    await this.#adopt(conversationId);
    return this.journal(conversationId).trustSedimentMirrored(assignmentId, requestId);
  }

  async trustRuleHitBatchState(
    conversationId: string,
    assignmentId: string,
    batchDigest: string,
  ): Promise<TrustRuleHitBatchState> {
    await this.#adopt(conversationId);
    return this.journal(conversationId).trustRuleHitBatchState(assignmentId, batchDigest);
  }

  async touchWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string }> {
    await this.#host.ensureSession(input.conversationId);
    const { conversationId, ...activity } = input;
    return this.journal(conversationId).touchWorksceneSession(activity);
  }

  deleteWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string } | undefined> {
    const { conversationId, ...activity } = input;
    return this.#adopt(conversationId).then(() =>
      this.journal(conversationId).deleteWorksceneSession(activity),
    );
  }

  async assignmentLifecycleProvenance(
    conversationId: string,
    assignmentId: string,
  ): Promise<
    | {
        readonly conversationId: string;
        readonly runId: string;
        readonly queuedPosition: number;
        readonly assignmentId: string;
        readonly assignmentItemId: string;
        readonly executorId: string;
        readonly dispatchDigest: string;
        readonly committed: boolean;
      }
    | undefined
  > {
    await this.#adopt(conversationId);
    const scopeState = this.#scope.current;
    if (!this.acceptsConversationId(conversationId, scopeState)) return undefined;
    if (scopeState.unavailableTransfers.has(conversationId)) return undefined;
    const provenance = await this.journalForQuery(
      conversationId,
      scopeState,
    ).assignmentLifecycleProvenance(assignmentId);
    if (!provenance) return undefined;
    return Object.freeze({
      ...provenance,
      assignmentId,
      assignmentItemId: `${
        provenance.executorId === this.#authority.executorId ? "local" : "relay"
      }:${assignmentId}`,
    });
  }

  async ownsReservation(conversationId: string, reservationId: string): Promise<boolean> {
    await this.#adopt(conversationId);
    const scopeState = this.#scope.current;
    if (!this.acceptsConversationId(conversationId, scopeState)) return false;
    if (scopeState.unavailableTransfers.has(conversationId)) return false;
    return this.journalForQuery(conversationId, scopeState).ownsReservation(reservationId);
  }

  async reservationConversationScope(reservationId: string): Promise<string | undefined> {
    return this.#authority.resourceRecovery.reservationConversationScope?.(reservationId);
  }

  sessionAuthorityState(conversationId: string) {
    return this.#adopt(conversationId).then(() =>
      this.journal(conversationId).authorityState(),
    );
  }

  async statusHistory(
    requests: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ) {
    for (const request of requests) {
      await this.#adopt(request.conversationId);
      if (!this.acceptsConversationId(request.conversationId)) {
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
          const journal = this.journalForQuery(conversationId);
          const pages = await journal.statusHistoryBatch(cursors);
          for (let index = 0; index < pages.length; index += 1) {
            const page = pages[index]!;
            const cursor = cursors[index]!;
            notices.push(page.notices);
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
    return Object.freeze({
      notices: Object.freeze(notices.flat()),
      next: Object.freeze(next),
    });
  }

  taskListBeforeMutation(conversationId: string, requestId: string) {
    return this.#adopt(conversationId).then(() =>
      this.journal(conversationId).taskListBeforeMutation(requestId),
    );
  }

  get advancementPending() {
    return {
      list: (after?: string) =>
        pendingAdvancementConversations(
          this.#authority.authorityLog,
          this.#authority.artifacts,
          this.#authority.verifier,
          after,
        ),
      cleanup: (conversationId: string, after?: string) =>
        this.#adopt(conversationId).then(() =>
          this.journal(conversationId).pendingAdvancementCleanup(after),
        ),
      run: (conversationId: string, sessionId: string, before?: number) =>
        this.#adopt(conversationId).then(() =>
          this.journal(conversationId).pendingAdvancementRun(sessionId, before),
        ),
    };
  }

  async finalHistory(
    conversationId: string,
    afterCommitRevision: number,
  ): Promise<CommittedConversationResult[]> {
    await this.#adopt(conversationId);
    return this.journal(conversationId).finalHistory(afterCommitRevision);
  }

  async advancementEvidenceTarget(conversationId: string, runId: string) {
    await this.#adopt(conversationId);
    const dispatch = await this.journal(conversationId).advancementEvidenceDispatch(runId);
    if (!dispatch) return undefined;
    const descriptor = this.#authority.executorCapabilities.snapshotFor(
      dispatch.envelope.executorId,
    )?.descriptor;
    if (!descriptor) return undefined;
    return {
      ownerEpoch: this.ownerEpochFor(conversationId),
      ...(this.#authority.domain.kind === "anchor"
        ? { anchorEpoch: this.#authority.domain.anchorEpoch }
        : {}),
      executorId: dispatch.envelope.executorId,
      workspace: dispatch.envelope.manifest.environment.workspace,
      descriptor,
    };
  }

  async worksceneContinuationSources(
    conversationId: string,
    query?: WorksceneContinuationQuery,
  ) {
    await this.#adopt(conversationId);
    if (query && "root" in query) {
      const frontiers = await this.journal(conversationId).worksceneContinuationFrontiers(
        query.root,
      );
      return (
        await Promise.all(
          frontiers.map(async (ref) => {
            await this.#adopt(ref.conversationId);
            return this.journal(ref.conversationId).worksceneContinuationSources({
              runId: ref.runId,
            });
          }),
        )
      ).flat();
    }
    return this.journal(conversationId).worksceneContinuationSources(query);
  }

  async isWorksceneContinuationCurrent(source: {
    conversationId: string;
    runId: string;
  }): Promise<boolean> {
    return isWorksceneContinuationCurrent(
      (id, query) => this.#host.worksceneContinuationSources(id, query),
      source,
    );
  }

  #requiredMutationPublisher(): ConversationMutationPublisher {
    if (!this.#mutationPublisher) {
      throw new Error("Conversation global mutation publisher is unavailable");
    }
    return this.#mutationPublisher;
  }
}
