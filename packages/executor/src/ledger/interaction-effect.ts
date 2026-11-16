import { Buffer } from "node:buffer";
import {
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type ArtifactStore,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssignmentRecord,
  ChannelInteractionGrant,
  ExecutionRef,
  InteractionMirrorBatch,
  InteractionMirrorEntry,
  InteractionSettlementStreamProof,
  TrustRuleHitFact,
  TrustSedimentFact,
} from "@zhixing-ai/core/contracts";
import {
  advanceAssignmentInteractionMirrorDigest,
  assertChannelInteractionGrantActiveAt,
  assertChannelInteractionGrantBinding,
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  channelInteractionConfirmationDecision,
  channelResponderPrincipal,
  confirmationDecisionDigest,
  createSignedInteractionSettlementStreamProof,
  interactionMirrorSeed,
  prepareInteractionDisplay,
  TRUST_RULE_HIT_REQUEST_PREFIX,
  TRUST_SEDIMENT_REQUEST_PREFIX,
  validateAssignmentInteractionMirrorEntry,
  validateAssignmentInteractionOutcome,
  validateChannelInteractionGrant,
  validateConversationInteractionMirrorEntry,
  validateConversationInteractionOutcome,
  validateFirstPartyInteractionDecision,
  validateInteractionDisplay,
  validateTrustRuleHitFact,
  validateTrustSedimentFact,
  verifyProtocolStep,
  type AssignmentInteractionOutcome,
  type ConversationInteractionOutcome,
  type FirstPartyInteractionDecision,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  assertBoundedText,
  assertDigest,
  assertExactKeys,
  assertPlainObject,
  assertPositiveSafeInteger,
  assignmentRecord,
  canonicalTime,
  MAX_WIDTH_CANONICAL_TIME,
  mutableSnapshot,
  nextEntryFromSeq,
  snapshot,
  type AssignmentLedgerOptions,
  type ChannelInteractionAnswerPreparation,
  type DeepReadonly,
  type DurableInteractionStreamEvent,
  type FinishedInteraction,
  type InteractionOutcome,
  type InteractionRecoveryResult,
  type InteractionRequestDisposition,
  type InteractionRequestInput,
  type InteractionStreamProjectionReceipt,
  type MirrorChainItem,
  type OwnerControlAuthorizer,
  type PendingAssignmentInteraction,
  type PreparedExecutionAuthorityCheck,
  type SideEffectInput,
  type SurfaceInteractionAnswerPreparation,
} from "./contracts.js";
import type { LedgerProjectionHistoryStore } from "./projection-history-store.js";

export interface LedgerInteractionEffectOptions {
  readonly store: LedgerProjectionHistoryStore;
  readonly artifacts: ArtifactStore;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly ownerControl: OwnerControlAuthorizer;
  readonly clock: () => string;
  readonly dataPlaneTickets?: AssignmentLedgerOptions["dataPlaneTickets"];
  readonly maxPendingInteractions: number;
  readonly assignmentRecordV2Writes: boolean;
  readonly prepareExecutionAuthority: (
    assignmentId: string,
    terminalReplay?: boolean,
  ) => Promise<PreparedExecutionAuthorityCheck | undefined>;
  readonly runEnableInteractionStreamProjection?: (
    assignmentId: string,
  ) => Promise<number | undefined>;
  readonly runDataPlaneBinding?: (
    assignmentId: string,
  ) => ReturnType<LedgerProjectionHistoryStore["dataPlaneBinding"]>;
  readonly runInteractionSettlementStreamProof?: (
    assignmentId: string,
  ) => Promise<InteractionSettlementStreamProof>;
}

export class LedgerInteractionEffect {
  readonly #store: LedgerProjectionHistoryStore;
  readonly #artifacts: ArtifactStore;
  readonly #executorId: string;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #ownerControl: OwnerControlAuthorizer;
  readonly #clock: () => string;
  readonly #dataPlaneTickets: AssignmentLedgerOptions["dataPlaneTickets"];
  readonly #maxPendingInteractions: number;
  readonly #assignmentRecordV2Writes: boolean;
  readonly #prepareExecutionAuthority: LedgerInteractionEffectOptions["prepareExecutionAuthority"];
  readonly #runEnableInteractionStreamProjection:
    | LedgerInteractionEffectOptions["runEnableInteractionStreamProjection"]
    | undefined;
  readonly #runDataPlaneBinding:
    | LedgerInteractionEffectOptions["runDataPlaneBinding"]
    | undefined;
  readonly #runInteractionSettlementStreamProof:
    | LedgerInteractionEffectOptions["runInteractionSettlementStreamProof"]
    | undefined;

  constructor(options: LedgerInteractionEffectOptions) {
    this.#store = options.store;
    this.#artifacts = options.artifacts;
    this.#executorId = options.executorId;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#ownerControl = options.ownerControl;
    this.#clock = options.clock;
    this.#dataPlaneTickets = options.dataPlaneTickets;
    this.#maxPendingInteractions = options.maxPendingInteractions;
    this.#assignmentRecordV2Writes = options.assignmentRecordV2Writes;
    this.#prepareExecutionAuthority = options.prepareExecutionAuthority;
    this.#runEnableInteractionStreamProjection =
      options.runEnableInteractionStreamProjection;
    this.#runDataPlaneBinding = options.runDataPlaneBinding;
    this.#runInteractionSettlementStreamProof =
      options.runInteractionSettlementStreamProof;
  }

  async startSideEffect(
    assignmentId: string,
    input: SideEffectInput,
  ): Promise<{ readonly effectSeq: number }> {
    assertIdentifier(input.toolName, "Side-effect tool name");
    assertBoundedText(input.summary, "Side-effect summary");
    if (input.kind !== "tool-mutation" && input.kind !== "external-call") {
      throw new TypeError("Side-effect kind is invalid");
    }
    if (
      input.target !== "workspace-file" &&
      input.target !== "external-service" &&
      input.target !== "device-system"
    ) {
      throw new TypeError("Side-effect target is invalid");
    }
    const current = await this.#prepareExecutionAuthority(assignmentId);
    const transaction = await this.#store.transactInteractionEffect<{
      effectSeq: number;
    }>(
      assignmentId,
      async (facts, prefix) => {
        await current?.(facts, prefix);
        if (facts.phase !== "started" || facts.hasAborts) {
          throw new Error("Side effects require an active, unfenced assignment");
        }
        const effectSeq = facts.sideEffectCount + 1;
        return {
          kind: "append",
          entries: [
            assignmentRecord(
              assignmentId,
              nextEntryFromSeq(facts.lastSeq, {
                v: 1,
                t: "side-effect-started",
                effectSeq,
                ...snapshot(input, "Side-effect input"),
              }),
            ),
          ],
          value: { effectSeq },
        };
      },
      { readProjectionIds: this.#ownerControl.readProjectionIds },
    );
    return transaction.value;
  }

  async completeSideEffect(
    assignmentId: string,
    effectSeq: number,
    result: {
      readonly status: "ok" | "failed" | "aborted";
      readonly resultDigest?: string;
    },
  ): Promise<void> {
    assertPositiveSafeInteger(effectSeq, "Side-effect sequence");
    if (
      result.status !== "ok" &&
      result.status !== "failed" &&
      result.status !== "aborted"
    ) {
      throw new TypeError("Side-effect completion status is invalid");
    }
    if (result.resultDigest !== undefined) {
      assertDigest(result.resultDigest, "Side-effect result digest");
    }
    await this.#store.transactInteractionEffect<void>(
      assignmentId,
      (facts) => {
        const effect = facts.sideEffectBySeq(effectSeq);
        if (!effect) throw new Error("Side-effect completion has no durable start");
        const body = snapshot(
          {
            v: 1 as const,
            t: "side-effect-completed" as const,
            effectSeq,
            status: result.status,
            ...(result.resultDigest ? { resultDigest: result.resultDigest } : {}),
          },
          "Side-effect completion",
        );
        if (effect.completed) {
          if (canonicalize(effect.completed) !== canonicalize(body)) {
            throw new Error(
              "Side effect already has a different terminal result",
            );
          }
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [
            assignmentRecord(
              assignmentId,
              nextEntryFromSeq(facts.lastSeq, body),
            ),
          ],
          value: undefined,
        };
      },
      { history: () => ({ effects: [effectSeq] }) },
    );
  }

  async hasOpenSideEffects(assignmentId: string): Promise<boolean> {
    return this.#store.selectInteractionEffect(
      assignmentId,
      (facts) => facts.hasOpenSideEffects,
    );
  }

  async requestInteraction(
    assignmentId: string,
    input: InteractionRequestInput,
  ): Promise<InteractionRequestDisposition> {
    await (this.#runEnableInteractionStreamProjection
      ? this.#runEnableInteractionStreamProjection(assignmentId)
      : this.enableInteractionStreamProjection(assignmentId));
    const prepared = await interactionRequested(input, this.#artifacts);
    const body = prepared.body;
    const transaction =
      await this.#store.transactInteractionEffect<InteractionRequestDisposition>(
        assignmentId,
        (facts) => {
          const existing = facts.requestedById(body.requestId);
          if (existing) {
            if (canonicalize(existing.body) !== canonicalize(body)) {
              throw new Error(
                "Interaction requestId has conflicting durable payloads",
              );
            }
            const finished = facts.finishedById(body.requestId);
            const rejectedByBackpressure =
              finished?.body.outcome.t === "cancelled" &&
              finished.body.outcome.via === "backpressure";
            return {
              kind: "return",
              value: {
                recordSeq: existing.recordSeq,
                accepted: !rejectedByBackpressure,
                display: existing.body.display,
              },
            };
          }
          if (facts.phase !== "started" || facts.hasAborts) {
            throw new Error(
              "Interactions can only be requested by a started assignment",
            );
          }
          const entry = nextEntryFromSeq(facts.lastSeq, body);
          const entries = [entry];
          if (facts.pendingRequestCount >= this.#maxPendingInteractions) {
            entries.push({
              recordSeq: entry.recordSeq + 1,
              body: {
                v: 1,
                t: "interaction-finished",
                requestId: body.requestId,
                kind: "allow-once",
                outcome: { t: "cancelled", via: "backpressure" },
              },
            });
          }
          return {
            kind: "append",
            entries: entries.map((item) => assignmentRecord(assignmentId, item)),
            value: {
              recordSeq: entry.recordSeq,
              accepted: entries.length === 1,
              display: body.display,
            },
          };
        },
        {
          candidateReferences: prepared.references,
          history: () => ({ requests: [body.requestId] }),
        },
      );
    return transaction.value;
  }

  async finishInteraction(
    assignmentId: string,
    requestId: string,
    outcome: InteractionOutcome,
  ): Promise<InteractionMirrorEntry> {
    assertIdentifier(requestId, "Interaction requestId");
    const validatedOutcome = await verifyProtocolStep(() =>
      validateAssignmentInteractionOutcome(outcome, this.#verifier),
    );
    const body = snapshot(
      {
        v: 1 as const,
        t: "interaction-finished" as const,
        requestId,
        kind: "allow-once" as const,
        outcome: validatedOutcome,
      },
      "Interaction result",
    );
    assertFinishedInteractionFits(assignmentId, this.#executorId, body);
    const transaction = await this.#store.transactInteractionEffect<{
      readonly existing?: FinishedInteraction;
      readonly recordSeq?: number;
      readonly ordinal?: number;
      readonly mirrorDigest?: string;
    }>(
      assignmentId,
      (facts) => {
        const requested = facts.requestedById(requestId);
        if (!requested) {
          throw new Error("Interaction result has no durable request");
        }
        if (validatedOutcome.t === "answered") {
          assertAnsweredInteractionAuthority(validatedOutcome.authority, {
            assignmentId,
            requestId,
            ref: facts.received?.body.activation.ref,
            ownerKeyId: facts.received?.body.activation.signature.keyId,
            requested: requested.body,
          });
        }
        const existing = facts.finishedById(requestId);
        if (existing) {
          if (canonicalize(existing.body) !== canonicalize(body)) {
            throw new Error(
              "Interaction requestId already has a different terminal result",
            );
          }
          return { kind: "return", value: { existing } };
        }
        if (facts.hasAborts) {
          throw new Error(
            "Interaction result cannot overtake a durable cancellation",
          );
        }
        const entry = nextEntryFromSeq(facts.lastSeq, body);
        const ordinal = facts.finishedCount + 1;
        const mirrorDigest = advanceAssignmentInteractionMirrorDigest(
          facts.interactionMirrorDigest,
          {
            ordinal,
            seq: entry.recordSeq,
            requestId,
            kind: "allow-once",
            outcome: validatedOutcome,
          },
        );
        return {
          kind: "append",
          entries: [assignmentRecord(assignmentId, entry)],
          value: { recordSeq: entry.recordSeq, ordinal, mirrorDigest },
        };
      },
      { history: () => ({ requests: [requestId] }) },
    );
    if (transaction.value.existing) {
      return mirrorEntry(transaction.value.existing);
    }
    return await verifyProtocolStep(() =>
      validateAssignmentInteractionMirrorEntry(
        {
          ordinal: transaction.value.ordinal!,
          seq: transaction.value.recordSeq!,
          requestId,
          kind: "allow-once",
          outcome: validatedOutcome,
          at: transaction.commit!.at,
        },
        this.#verifier,
      ),
    );
  }

  async recordTrustSediment(
    assignmentId: string,
    sediment: TrustSedimentFact,
  ): Promise<{ readonly requestId: string; readonly recordSeq: number }> {
    const validated = validateTrustSedimentFact(
      snapshot(sediment, "Trust sediment"),
    );
    const transaction = await this.#store.transactInteractionEffect<{
      readonly requestId: string;
      readonly recordSeq: number;
    }>(assignmentId, (facts) => {
      if (facts.phase !== "started" || facts.hasAborts) {
        throw new Error(
          "Trust sediments can only be recorded by a started assignment",
        );
      }
      const requestId = `${TRUST_SEDIMENT_REQUEST_PREFIX}${facts.trustSedimentCount + 1}`;
      const body = snapshot(
        {
          v: 1 as const,
          t: "trust-sediment" as const,
          requestId,
          sediment: validated,
        },
        "Trust sediment record",
      );
      const entry = nextEntryFromSeq(facts.lastSeq, body);
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: { requestId, recordSeq: entry.recordSeq },
      };
    });
    return transaction.value;
  }

  async recordTrustRuleHit(
    assignmentId: string,
    hit: TrustRuleHitFact,
  ): Promise<{ readonly requestId: string; readonly recordSeq: number }> {
    const validated = validateTrustRuleHitFact(snapshot(hit, "Trust rule hit"));
    const transaction = await this.#store.transactInteractionEffect<{
      readonly requestId: string;
      readonly recordSeq: number;
    }>(assignmentId, (facts) => {
      if (facts.phase !== "started" || facts.hasAborts) {
        throw new Error(
          "Trust rule hits can only be recorded by a started assignment",
        );
      }
      const requestId = `${TRUST_RULE_HIT_REQUEST_PREFIX}${facts.trustRuleHitCount + 1}`;
      const body = snapshot(
        {
          v: 1 as const,
          t: "trust-rule-hit" as const,
          requestId,
          hit: validated,
        },
        "Trust rule hit record",
      );
      const entry = nextEntryFromSeq(facts.lastSeq, body);
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: { requestId, recordSeq: entry.recordSeq },
      };
    });
    return transaction.value;
  }

  async jobInteractionOutcome(
    assignmentId: string,
    requestId: string,
  ): Promise<InteractionOutcome | undefined> {
    assertIdentifier(requestId, "Interaction requestId");
    return this.#store.selectInteractionEffect(
      assignmentId,
      (facts) => {
        if (
          facts.received?.body.activation.ref.execution !== "job" ||
          !facts.hasRequested(requestId)
        ) {
          throw new Error("Job interaction outcome has no durable job request");
        }
        const finished = facts.finishedById(requestId);
        return finished
          ? snapshot(finished.body.outcome, "Interaction outcome")
          : undefined;
      },
      () => ({ requests: [requestId] }),
    );
  }

  async conversationInteractionOutcome(
    assignmentId: string,
    requestId: string,
  ): Promise<ConversationInteractionOutcome | undefined> {
    assertIdentifier(requestId, "Interaction requestId");
    return this.#store.selectInteractionEffect(
      assignmentId,
      (facts) => {
        if (
          facts.received?.body.activation.ref.execution !== "conversation" ||
          !facts.hasRequested(requestId)
        ) {
          throw new Error(
            "Conversation interaction outcome has no durable conversation request",
          );
        }
        const finished = facts.finishedById(requestId);
        return finished
          ? snapshot(
              validateConversationInteractionOutcome(finished.body.outcome),
              "Interaction outcome",
            )
          : undefined;
      },
      () => ({ requests: [requestId] }),
    );
  }

  async pendingInteractionRequests(
    assignmentId: string,
  ): Promise<readonly PendingAssignmentInteraction[]> {
    return this.#store.selectInteractionEffect(assignmentId, (facts) =>
      [...facts.pendingRequestsSnapshot()]
        .sort((left, right) => left.recordSeq - right.recordSeq)
        .map(({ body }) => ({
          assignmentId,
          request: snapshot(body, "Pending interaction request"),
        })),
    );
  }

  async interactionStreamEvents(
    assignmentId: string,
    afterRecordSeq = 0,
  ): Promise<readonly DurableInteractionStreamEvent[]> {
    return this.#store.interactionStreamEvents(assignmentId, afterRecordSeq);
  }

  async prepareInteractionAnswerFromSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly ticketId: string;
    readonly surfacePrincipal: string;
    readonly decision: Parameters<typeof validateFirstPartyInteractionDecision>[0];
  }): Promise<SurfaceInteractionAnswerPreparation> {
    const decision = validateFirstPartyInteractionDecision(input.decision);
    const expectedOutcome = surfaceTicketInteractionOutcome({
      requestId: input.requestId,
      ticketId: input.ticketId,
      surfacePrincipal: input.surfacePrincipal,
      decision,
    });
    const existing = await this.#store.selectInteractionEffect(
      input.assignmentId,
      (facts) => facts.finishedById(input.requestId),
      () => ({ requests: [input.requestId] }),
    );
    if (existing) {
      if (
        canonicalize(existing.body.outcome) !== canonicalize(expectedOutcome)
      ) {
        throw new Error(
          "Interaction requestId already has a different terminal result",
        );
      }
      return {
        kind: "replayed",
        result: validateConversationInteractionMirrorEntry(
          mirrorEntry(existing),
        ),
      };
    }
    const tickets = this.#dataPlaneTickets;
    if (!tickets) {
      throw new Error("Data-plane ticket authorization is not configured");
    }
    const binding = await (this.#runDataPlaneBinding
      ? this.#runDataPlaneBinding(input.assignmentId)
      : this.#store.dataPlaneBinding(input.assignmentId));
    if (!binding) {
      throw new Error("Interaction answer has no durable assignment activation");
    }
    const authorization = await tickets.authorize(
      input.ticketId,
      "interact",
      {
        assignmentId: input.assignmentId,
        ref: binding.ref,
        executorId: binding.executorId,
        surfacePrincipal: input.surfacePrincipal,
      },
    );
    return {
      kind: "authorized",
      decision,
      ticketId: authorization.ticket.ticketId,
      surfacePrincipal: authorization.ticket.surfacePrincipal,
    };
  }

  async prepareInteractionAnswerFromChannel(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly grant: ChannelInteractionGrant;
    readonly at?: string;
  }): Promise<ChannelInteractionAnswerPreparation> {
    assertIdentifier(input.assignmentId, "Channel answer assignmentId");
    assertIdentifier(input.requestId, "Channel answer requestId");
    const grant = await verifyProtocolStep(() =>
      validateChannelInteractionGrant(input.grant, this.#verifier),
    );
    const at = input.at ?? this.#clock();
    const selected = await this.#store.selectInteractionEffect(
      input.assignmentId,
      (facts) => ({
        ref: facts.received?.body.activation.ref,
        ownerKeyId: facts.received?.body.activation.signature.keyId,
        requested: facts.requestedById(input.requestId)?.body,
        existing: facts.finishedById(input.requestId),
        active:
          facts.phase === "started" &&
          !facts.hasAborts &&
          !facts.supersedeFence,
      }),
      () => ({ requests: [input.requestId] }),
    );
    assertAnsweredInteractionAuthority(
      { via: "channel-grant", grant },
      {
        assignmentId: input.assignmentId,
        requestId: input.requestId,
        ref: selected.ref,
        ownerKeyId: selected.ownerKeyId,
        requested: selected.requested,
      },
    );
    const outcome = (await verifyProtocolStep(() =>
      validateAssignmentInteractionOutcome(
        {
          t: "answered",
          authority: { via: "channel-grant", grant },
          decision: grant.decision,
          decisionDigest: confirmationDecisionDigest(
            input.requestId,
            channelInteractionConfirmationDecision(grant.decision),
          ),
          by: channelResponderPrincipal(grant.responder),
        },
        this.#verifier,
      ),
    )) as Extract<InteractionOutcome, { readonly t: "answered" }>;
    if (selected.existing) {
      if (
        canonicalize(selected.existing.body.outcome) !== canonicalize(outcome)
      ) {
        throw new Error(
          "Interaction requestId already has a different terminal result",
        );
      }
      return { kind: "replayed", result: mirrorEntry(selected.existing) };
    }
    if (!selected.active) {
      throw new Error("Channel interaction grant cannot answer an inactive job");
    }
    assertChannelInteractionGrantActiveAt(grant, at);
    return { kind: "authorized", grant, outcome };
  }

  async enableInteractionStreamProjection(
    assignmentId: string,
  ): Promise<number | undefined> {
    if (!this.#assignmentRecordV2Writes) return undefined;
    return (
      await this.#store.transactInteractionEffect<number | undefined>(
        assignmentId,
        (facts) => {
          if (facts.received?.body.activation.ref.execution !== "job") {
            return { kind: "return", value: undefined };
          }
          if (facts.streamProjectionEnabledAfter !== undefined) {
            return {
              kind: "return",
              value: facts.streamProjectionEnabledAfter,
            };
          }
          const legacyUpToRecordSeq = facts.lastSeq;
          return {
            kind: "append",
            entries: [
              assignmentRecord(
                assignmentId,
                nextEntryFromSeq(facts.lastSeq, {
                  v: 2,
                  t: "interaction-stream-projection-enabled",
                  legacyUpToRecordSeq,
                }),
              ),
            ],
            value: legacyUpToRecordSeq,
          };
        },
      )
    ).value;
  }

  async interactionStreamProjectionEnabled(
    assignmentId: string,
  ): Promise<boolean> {
    return this.#store.selectInteractionEffect(
      assignmentId,
      (facts) => facts.streamProjectionEnabledAfter !== undefined,
    );
  }

  async interactionStreamProjectedUpTo(
    assignmentId: string,
  ): Promise<number | undefined> {
    return this.#store.selectInteractionEffect(assignmentId, (facts) =>
      facts.streamProjectionEnabledAfter === undefined
        ? undefined
        : facts.streamProjectedUpTo,
    );
  }

  async markInteractionStreamProjected(
    assignmentId: string,
    receipts: readonly InteractionStreamProjectionReceipt[],
  ): Promise<void> {
    if (receipts.length === 0) return;
    const lastReceipt = receipts.at(-1)!;
    const checkpoint = lastReceipt.checkpoint;
    if (
      checkpoint.assignmentId !== assignmentId ||
      checkpoint.lastSeq < lastReceipt.frame.seq ||
      lastReceipt.frame.assignmentId !== assignmentId ||
      checkpoint.streamEpoch !== lastReceipt.frame.streamEpoch ||
      canonicalize(checkpoint.ref) !== canonicalize(lastReceipt.frame.ref)
    ) {
      throw new TypeError(
        "Interaction stream receipt does not bind its durable checkpoint",
      );
    }
    let previousFrameSeq = 0;
    let previousRecordSeq = 0;
    for (const receipt of receipts) {
      const recordSeq = interactionRecordSeqFromSource(receipt.sourceId);
      if (
        receipt.frame.assignmentId !== assignmentId ||
        receipt.frame.payload.kind !== "interaction" ||
        receipt.checkpoint.assignmentId !== assignmentId ||
        receipt.checkpoint.lastSeq < receipt.frame.seq ||
        receipt.checkpoint.streamEpoch !== receipt.frame.streamEpoch ||
        canonicalize(receipt.checkpoint.ref) !==
          canonicalize(receipt.frame.ref) ||
        receipt.frame.seq <= previousFrameSeq ||
        recordSeq <= previousRecordSeq
      ) {
        throw new TypeError(
          "Interaction stream receipts are not a contiguous ordered projection",
        );
      }
      previousFrameSeq = receipt.frame.seq;
      previousRecordSeq = recordSeq;
    }
    await this.#store.transactInteractionEffect<void>(assignmentId, (facts) => {
      if (facts.received?.body.activation.ref.execution !== "job") {
        throw new TypeError(
          "Conversation assignments cannot write job stream projection facts",
        );
      }
      if (facts.streamProjectionEnabledAfter === undefined) {
        throw new Error(
          "Interaction stream projection has no durable format cutover",
        );
      }
      const finishedRecordSeqs = receipts
        .filter(
          (receipt) =>
            receipt.frame.payload.kind === "interaction" &&
            receipt.frame.payload.event.t === "finished",
        )
        .map((receipt) => interactionRecordSeqFromSource(receipt.sourceId));
      const upToRecordSeq = finishedRecordSeqs.at(-1);
      if (upToRecordSeq === undefined) {
        return { kind: "return", value: undefined };
      }
      if (upToRecordSeq < facts.streamProjectedUpTo) {
        throw new Error(
          "Interaction stream projection watermark cannot move backward",
        );
      }
      if (upToRecordSeq === facts.streamProjectedUpTo) {
        if (
          checkpoint.lastSeq !== facts.lastInteractionStreamSeq ||
          checkpoint.head !== facts.interactionStreamDigest
        ) {
          throw new Error(
            "Interaction stream projection watermark has a conflicting durable checkpoint",
          );
        }
        return { kind: "return", value: undefined };
      }
      const expected = facts.interactionProjectionSourceIdsBetween(
        facts.streamProjectedUpTo,
        upToRecordSeq,
      );
      const actual = receipts
        .map((receipt) => receipt.sourceId)
        .filter((sourceId) => {
          const seq = interactionRecordSeqFromSource(sourceId);
          return seq > facts.streamProjectedUpTo && seq <= upToRecordSeq;
        });
      if (canonicalize(actual) !== canonicalize(expected)) {
        throw new Error(
          "Interaction stream receipt skips or reorders a durable interaction prefix",
        );
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntryFromSeq(facts.lastSeq, {
              v: 2,
              t: "interaction-stream-projected",
              assignmentId,
              upToRecordSeq,
              lastStreamSeq: checkpoint.lastSeq,
              streamDigest: checkpoint.head,
            }),
          ),
        ],
        value: undefined,
      };
    });
  }

  async interactionSettlementRequest(
    assignmentId: string,
  ): Promise<
    | { readonly settlementVersion: 1 }
    | {
        readonly settlementVersion: 2;
        readonly streamProof?: InteractionSettlementStreamProof;
      }
  > {
    const shape = await this.#store.selectInteractionEffect(
      assignmentId,
      (facts) => ({
        enabled: facts.streamProjectionEnabledAfter !== undefined,
        needsProof: facts.needsStreamProof,
      }),
    );
    if (!shape.enabled) return { settlementVersion: 1 };
    if (!shape.needsProof) return { settlementVersion: 2 };
    return {
      settlementVersion: 2,
      streamProof: await (this.#runInteractionSettlementStreamProof
        ? this.#runInteractionSettlementStreamProof(assignmentId)
        : this.interactionSettlementStreamProof(assignmentId)),
    };
  }

  async interactionSettlementStreamProof(
    assignmentId: string,
  ): Promise<InteractionSettlementStreamProof> {
    return this.#store.selectInteractionEffect(assignmentId, (facts) => {
      const abort = facts.firstValidationTicketAbort();
      const target = facts.needsStreamProof
        ? { recordSeq: facts.lastFinishedInteractionRecordSeq }
        : undefined;
      if (
        !abort ||
        !target ||
        facts.streamProjectionEnabledAfter === undefined ||
        facts.streamProjectedUpTo < target.recordSeq ||
        facts.lastStreamProjectionRecordSeq === undefined ||
        facts.interactionStreamDigest === undefined
      ) {
        throw new Error(
          "Interaction settlement stream proof is not yet derivable from the assignment ledger",
        );
      }
      return createSignedInteractionSettlementStreamProof({
        v: 2,
        assignmentId,
        executorId: this.#executorId,
        ticketDigest: abort.refId,
        sourceLastSeq: abort.recordSeq,
        sourceChainDigest: abort.ledgerDigest,
        targetInteractionRecordSeq: target.recordSeq,
        projectedRecordSeq: facts.lastStreamProjectionRecordSeq,
        upToRecordSeq: facts.streamProjectedUpTo,
        lastStreamSeq: facts.lastInteractionStreamSeq,
        streamDigest: facts.interactionStreamDigest,
        ledgerChainDigest: facts.lastStreamProjectionDigest!,
        signer: this.#signer,
      });
    });
  }

  async recoverInteractions(
    assignmentId: string,
    now = this.#clock(),
  ): Promise<InteractionRecoveryResult> {
    const nowMs = canonicalTime(now, "Interaction recovery time");
    const transaction = await this.#store.transactInteractionEffect<{
      readonly pending: Array<
        Extract<AssignmentRecord, { t: "interaction-requested" }>
      >;
      readonly appended: Array<{
        requestId: string;
        outcome: InteractionOutcome;
        recordSeq: number;
        ordinal: number;
      }>;
    }>(assignmentId, (facts) => {
      const pending = facts.pendingRequestsSnapshot().map(
        (request) => request.body,
      );
      const terminal =
        facts.phase === "failed" ||
        facts.phase === "sealed" ||
        facts.phase === "acked";
      const cancellation = facts.latestAbort();
      const toResolve = pending.filter(
        (request) =>
          terminal ||
          cancellation !== undefined ||
          canonicalTime(request.expiresAt, "Interaction expiry") < nowMs,
      );
      const stillPending = pending.filter(
        (request) => !toResolve.includes(request),
      );
      if (toResolve.length === 0) {
        return {
          kind: "return",
          value: { pending: stillPending, appended: [] },
        };
      }
      let nextSeq = facts.lastSeq;
      let ordinal = facts.finishedCount;
      const appended = toResolve.map((request) => {
        const outcome: InteractionOutcome =
          terminal || cancellation
            ? {
                t: "cancelled",
                via: terminal
                  ? "run-end"
                  : cancellation!.via === "owner-fence"
                    ? "cancel-fence"
                    : "abort-ticket",
              }
            : { t: "expired" };
        nextSeq += 1;
        ordinal += 1;
        return {
          requestId: request.requestId,
          outcome,
          recordSeq: nextSeq,
          ordinal,
        };
      });
      return {
        kind: "append",
        entries: appended.map((item) =>
          assignmentRecord(assignmentId, {
            recordSeq: item.recordSeq,
            body: {
              v: 1,
              t: "interaction-finished",
              requestId: item.requestId,
              kind: "allow-once",
              outcome: item.outcome,
            },
          }),
        ),
        value: { pending: stillPending, appended },
      };
    });
    const resolved: InteractionMirrorEntry[] = [];
    if (transaction.commit) {
      resolved.push(
        ...(await verifyProtocolStep(() =>
          transaction.value.appended.map((item) =>
            validateAssignmentInteractionMirrorEntry(
              {
                ordinal: item.ordinal,
                seq: item.recordSeq,
                requestId: item.requestId,
                kind: "allow-once",
                outcome: item.outcome,
                at: transaction.commit!.at,
              },
              this.#verifier,
            ),
          ),
        )),
      );
    }
    return { pending: transaction.value.pending, resolved };
  }

  async closePendingInteractionsForRunEnd(
    assignmentId: string,
  ): Promise<number> {
    const transaction = await this.#store.transactInteractionEffect<number>(
      assignmentId,
      (facts) => {
        if (facts.phase !== "started" || facts.hasAborts) {
          throw new Error(
            "Run-end interaction closure requires an active started assignment",
          );
        }
        if (facts.pendingRequestCount === 0) {
          return { kind: "return", value: 0 };
        }
        let nextSeq = facts.lastSeq;
        const entries = facts.pendingRequestsSnapshot().map((request) => ({
          recordSeq: ++nextSeq,
          body: {
            v: 1 as const,
            t: "interaction-finished" as const,
            requestId: request.body.requestId,
            kind: "allow-once" as const,
            outcome: { t: "cancelled" as const, via: "run-end" as const },
          },
        }));
        return {
          kind: "append",
          entries: entries.map((entry) =>
            assignmentRecord(assignmentId, entry),
          ),
          value: entries.length,
        };
      },
    );
    return transaction.value;
  }
}

export function mirrorEntry(
  finished: MirrorChainItem | DeepReadonly<MirrorChainItem>,
): InteractionMirrorEntry {
  if (finished.body.t === "trust-sediment") {
    return {
      ordinal: finished.ordinal,
      seq: finished.recordSeq,
      requestId: finished.body.requestId,
      kind: "trust-sediment",
      sediment: mutableSnapshot<
        Extract<AssignmentRecord, { t: "trust-sediment" }>["sediment"]
      >(finished.body.sediment, "Trust sediment"),
      at: finished.at,
    };
  }
  if (finished.body.t === "trust-rule-hit") {
    return {
      ordinal: finished.ordinal,
      seq: finished.recordSeq,
      requestId: finished.body.requestId,
      kind: "trust-rule-hit",
      hit: mutableSnapshot<
        Extract<AssignmentRecord, { t: "trust-rule-hit" }>["hit"]
      >(finished.body.hit, "Trust rule hit"),
      at: finished.at,
    };
  }
  return {
    ordinal: finished.ordinal,
    seq: finished.recordSeq,
    requestId: finished.body.requestId,
    kind: "allow-once",
    outcome: mutableSnapshot<
      Extract<AssignmentRecord, { t: "interaction-finished" }>["outcome"]
    >(finished.body.outcome, "Interaction outcome"),
    at: finished.at,
  };
}

export function interactionMirrorRecordBytes(
  assignmentId: string,
  batch: InteractionMirrorBatch,
): number {
  return Buffer.byteLength(
    canonicalize({ t: "interaction-mirror", assignmentId, batch }),
    "utf8",
  );
}

export function interactionMirrorRecordCapacityBytes(input: {
  readonly assignmentId: string;
  readonly executorId: string;
  readonly previousDigest: string;
  readonly entries: readonly InteractionMirrorEntry[];
  readonly mirrorDigest: string;
}): number {
  const maxWidthIdentifier = "\0".repeat(480);
  return interactionMirrorRecordBytes(input.assignmentId, {
    v: 1,
    assignmentId: input.assignmentId,
    executorId: input.executorId,
    previousDigest: input.previousDigest,
    entries: [...input.entries],
    mirrorDigest: input.mirrorDigest,
    signature: {
      alg: maxWidthIdentifier,
      keyId: maxWidthIdentifier,
      sig: maxWidthIdentifier,
    },
  } as InteractionMirrorBatch);
}

function interactionRecordSeqFromSource(sourceId: string): number {
  const match = /^interaction:(\d+)$/u.exec(sourceId);
  const recordSeq = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(recordSeq) || recordSeq <= 0) {
    throw new TypeError(
      "Interaction stream source identity is not a positive record sequence",
    );
  }
  return recordSeq;
}


function assertAnsweredInteractionAuthority(
  authority: Extract<
    AssignmentInteractionOutcome,
    { readonly t: "answered" }
  >["authority"],
  durable: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly ref: ExecutionRef | undefined;
    readonly ownerKeyId: string | undefined;
    readonly requested:
      | Extract<AssignmentRecord, { t: "interaction-requested" }>
      | undefined;
  },
): void {
  if (authority.via !== "channel-grant") return;
  if (!durable.ref || durable.ref.execution !== "job" || !durable.requested) {
    throw new TypeError(
      "Channel interaction grant has no durable pending job request",
    );
  }
  const grant = authority.grant;
  if (
    grant.signature.keyId !== durable.ownerKeyId ||
    grant.challengeToken.signature.keyId !== durable.ownerKeyId
  ) {
    throw new TypeError(
      "Channel interaction grant is not signed by the durable job owner",
    );
  }
  assertChannelInteractionGrantBinding(grant, {
    ref: durable.ref,
    assignmentId: durable.assignmentId,
    interactionRequestId: durable.requestId,
    challengeId: grant.challengeToken.challengeId,
    route: grant.route,
    responder: grant.responder,
    decision: grant.decision,
    toolName: durable.requested.toolName,
    display: durable.requested.display,
  });
}

async function interactionRequested(
  input: InteractionRequestInput,
  artifacts: ArtifactStore,
): Promise<{
  readonly body: Extract<AssignmentRecord, { t: "interaction-requested" }>;
  readonly references: readonly ArtifactRef[];
}> {
  const prepared = await prepareInteractionDisplay(input.display, artifacts);
  const display = prepared.display;
  const body = snapshot(
    {
      v: 1 as const,
      t: "interaction-requested" as const,
      requestId: input.requestId,
      kind: "allow-once" as const,
      toolName: input.toolName,
      display,
      issuedAt: input.issuedAt,
      ttlMs: input.ttlMs,
      expiresAt: input.expiresAt,
    },
    "Interaction request",
  );
  validateInteractionRequest(body);
  return {
    body,
    references: prepared.references,
  };
}

function validateInteractionRequest(
  body: Extract<AssignmentRecord, { t: "interaction-requested" }>,
): void {
  assertPlainObject(body, "Interaction request");
  assertExactKeys(
    body,
    [
      "display",
      "expiresAt",
      "issuedAt",
      "kind",
      "requestId",
      "t",
      "ttlMs",
      "toolName",
      "v",
    ],
    "Interaction request",
  );
  if (
    body.v !== 1 ||
    body.t !== "interaction-requested" ||
    body.kind !== "allow-once"
  ) {
    throw new TypeError("Interaction request discriminators are invalid");
  }
  assertIdentifier(body.requestId, "Interaction requestId");
  assertIdentifier(body.toolName, "Interaction toolName");
  if (!Number.isSafeInteger(body.ttlMs) || body.ttlMs <= 0) {
    throw new TypeError("Interaction TTL is outside the supported bound");
  }
  const issuedAt = canonicalTime(body.issuedAt, "Interaction issuedAt");
  const expiresAt = canonicalTime(body.expiresAt, "Interaction expiresAt");
  if (expiresAt - issuedAt !== body.ttlMs) {
    throw new TypeError("Interaction expiresAt must equal issuedAt plus ttlMs");
  }
  validateInteractionDisplay(body.display);
  assertInteractionRecordSize(body, "Interaction request");
}

function surfaceTicketInteractionOutcome(input: {
  readonly requestId: string;
  readonly ticketId: string;
  readonly surfacePrincipal: string;
  readonly decision: FirstPartyInteractionDecision;
}): ConversationInteractionOutcome {
  const allowed = input.decision.kind === "allow-once";
  const reason =
    input.decision.kind === "deny"
      ? input.decision.reason
      : input.decision.note;
  return validateConversationInteractionOutcome({
    t: "answered",
    authority: { via: "surface-ticket", ticketId: input.ticketId },
    decision: { allowed, ...(reason ? { reason } : {}) },
    decisionDigest: confirmationDecisionDigest(input.requestId, input.decision),
    by: input.surfacePrincipal,
  });
}

function assertInteractionRecordSize(value: unknown, label: string): void {
  const largestSequenceWrapper = {
    recordSeq: Number.MAX_SAFE_INTEGER,
    body: value,
  };
  if (
    Buffer.byteLength(canonicalize(largestSequenceWrapper), "utf8") >
    MAX_INLINE_LOGICAL_RECORD_BYTES
  ) {
    throw new TypeError(`${label} exceeds the durable protocol limit`);
  }
}

function assertFinishedInteractionFits(
  assignmentId: string,
  executorId: string,
  body: Extract<AssignmentRecord, { t: "interaction-finished" }>,
): void {
  assertInteractionRecordSize(body, "Interaction result");
  const digest = interactionMirrorSeed(assignmentId);
  const bytes = interactionMirrorRecordCapacityBytes({
    assignmentId,
    executorId,
    previousDigest: digest,
    entries: [
      {
        ordinal: Number.MAX_SAFE_INTEGER,
        seq: Number.MAX_SAFE_INTEGER,
        requestId: body.requestId,
        kind: "allow-once",
        outcome: body.outcome,
        at: MAX_WIDTH_CANONICAL_TIME,
      },
    ],
    mirrorDigest: digest,
  });
  if (bytes > MAX_INLINE_LOGICAL_RECORD_BYTES) {
    throw new TypeError(
      "Interaction result cannot fit in a durable mirror record",
    );
  }
}
