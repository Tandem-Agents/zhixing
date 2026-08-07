import type { AnchorRubricGlobalStateAdapter } from "@zhixing/core/rubrics";
import {
  RUBRIC_AUTHORITY_STREAM,
} from "@zhixing/core/rubrics";
import type {
  ArtifactRef,
  AuthorityCallContext,
  DeferredGlobalIntent,
  RubricWriteMutation,
  ScheduleWriteMutation,
} from "@zhixing/core/contracts";
import {
  assertPrincipalAllowsAuthorityMethod,
  deferredGlobalIntentDigest,
  deferredIntentMutationDigest,
  deferredIntentStream,
} from "@zhixing/core/protocol";
import {
  confirmedIntentRecord,
  DeferredGlobalIntentRepository,
  emptyDeferredIntentConversationState,
  reduceDeferredIntentConversationState,
} from "./deferred-global-intents.js";
import {
  createGlobalControlEnvelope,
  type ControlAdmissionJournal,
  type TrustedControlSource,
} from "./control-admission.js";
import type { GlobalMutationCommitCoordinator } from "./global-mutation-commit-coordinator.js";
import { scheduleMutationTaskId } from "./scheduler-mutation-commit.js";

export interface DeferredGlobalIntentAnchorReviewOptions {
  readonly repository: DeferredGlobalIntentRepository;
  readonly admission: ControlAdmissionJournal;
  readonly coordinator: GlobalMutationCommitCoordinator;
  readonly rubrics: AnchorRubricGlobalStateAdapter;
  readonly anchorEpoch: number;
  readonly deviceId: string;
  readonly isCurrentOwner: (conversationId: string) => boolean | Promise<boolean>;
  readonly now?: () => string;
}

/** Internal anchor seam consumed by transfer adoption; it registers no public route. */
export class DeferredGlobalIntentAnchorReviewService {
  readonly #options: DeferredGlobalIntentAnchorReviewOptions;
  readonly #now: () => string;

  constructor(options: DeferredGlobalIntentAnchorReviewOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async list(
    conversationId: string,
    context: AuthorityCallContext,
  ): Promise<readonly DeferredGlobalIntent[]> {
    this.#admit(context, "intent.list");
    await this.#assertCurrentOwner(conversationId);
    return this.#options.repository.list(conversationId, context);
  }

  async review(
    intentId: string,
    context: AuthorityCallContext,
  ): Promise<DeferredGlobalIntent> {
    this.#admit(context, "intent.list");
    const conversationId = await this.#options.repository.locateConversation(intentId);
    await this.#assertCurrentOwner(conversationId);
    return structuredClone((await this.#options.repository.locate(intentId)).intent);
  }

  async decide(
    intentId: string,
    decision: "confirmed" | "discarded",
    context: AuthorityCallContext,
  ): Promise<DeferredGlobalIntent> {
    this.#admit(context, "intent.decide");
    const conversationId = await this.#options.repository.locateConversation(intentId);
    await this.#assertCurrentOwner(conversationId);
    const located = await this.#options.repository.locate(intentId);
    const intent = located.intent;
    if (intent.status !== "pending") {
      if (intent.status === decision) return structuredClone(intent);
      throw new TypeError("Deferred intent already has the opposite terminal decision");
    }
    if (decision === "discarded") {
      await this.#options.repository.decide(intentId, decision, context);
      return structuredClone((await this.#options.repository.locate(intentId)).intent);
    }
    if (intent.timeSensitive && context.principal.kind !== "surface") {
      throw new TypeError("Schedule deferred intent requires authenticated user confirmation");
    }
    if (
      !intent.timeSensitive &&
      context.principal.kind !== "surface" &&
      context.principal.kind !== "host"
    ) {
      throw new TypeError("Rubric deferred intent requires an owner review principal");
    }

    const mutationDigest = deferredIntentMutationDigest(
      intent.mutation,
      intent.timeSensitive,
    );
    const controlRequestId = `intent-apply:${intent.intentId}:${mutationDigest}`;
    const source = this.#source(context);
    const envelope = createGlobalControlEnvelope({
      requestId: controlRequestId,
      source,
      at: this.#now(),
      body: {
        t: "global-write",
        mutation: intent.mutation,
        anchorEpoch: this.#options.anchorEpoch,
        domainRevision: mutationRevision(intent.mutation),
      },
    });
    const companionStreams = intent.timeSensitive
      ? [`job:${scheduleMutationTaskId(
          intent.mutation as ScheduleWriteMutation,
          controlRequestId,
        )}`]
      : [RUBRIC_AUTHORITY_STREAM];
    const outcome = await this.#options.admission.applyAuthority({
      envelope,
      source,
      stream: deferredIntentStream(conversationId),
      initial: emptyDeferredIntentConversationState(),
      reducer: (state, record) =>
        reduceDeferredIntentConversationState(state, record),
      companionStreams,
      readProjectionIds: [
        ...this.#options.coordinator.readProjectionIds,
        this.#options.rubrics.deferredIntentProjectionId,
      ],
      candidateReferences: intentReferences(intent),
      decide: async (state, transaction) => {
        const current = state.intents.get(intentId);
        if (!current || current.status !== "pending") {
          throw new TypeError("Deferred intent is no longer pending at the authority prefix");
        }
        if (deferredGlobalIntentDigest(current) !== deferredGlobalIntentDigest(intent)) {
          throw new TypeError("Deferred intent changed before authority review");
        }
        let records;
        let revision: number;
        if (current.timeSensitive) {
          const mutation = current.mutation as ScheduleWriteMutation;
          const prepared = await this.#options.coordinator.prepareDeferredScheduleIntent({
            intentId,
            requestId: controlRequestId,
            mutation,
            context: transaction.authorityPrefix,
          });
          records = prepared.records;
          revision = prepared.targetRevision;
        } else {
          const prepared = await this.#options.rubrics.prepareDeferredIntentMutation({
            mutation: current.mutation as Extract<
              RubricWriteMutation,
              { kind: "rubric-save-own" | "rubric-update-own" }
            >,
            requestId: controlRequestId,
            at: transaction.authorityPrefix.at,
            projection: transaction.authorityPrefix.readProjection(
              this.#options.rubrics.deferredIntentProjectionId,
            ),
          });
          records = prepared.records;
          revision = prepared.revision;
        }
        return {
          result: { v: 1, status: "ok", body: { t: "global-write", revision } },
          authorityEntries: [
            ...records,
            {
              stream: deferredIntentStream(conversationId),
              body: confirmedIntentRecord(current, transaction.authorityPrefix),
            },
          ],
        };
      },
    });
    if (outcome.kind === "rejected") {
      throw new TypeError(`Deferred intent remains pending: ${outcome.result.error.message}`);
    }
    if (
      intent.timeSensitive &&
      outcome.result.status === "ok" &&
      outcome.result.body.t === "global-write"
    ) {
      await this.#options.coordinator.applyDeferredScheduleIntent({
        intentId,
        requestId: controlRequestId,
        mutation: intent.mutation as ScheduleWriteMutation,
        targetRevision: outcome.result.body.revision,
      });
    }
    return structuredClone((await this.#options.repository.locate(intentId)).intent);
  }

  #admit(
    context: AuthorityCallContext,
    method: "intent.list" | "intent.decide",
  ): void {
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
    if (!context.requestId || Date.parse(context.deadlineAt) < Date.parse(this.#now())) {
      throw new TypeError("Deferred intent review request is invalid or expired");
    }
  }

  async #assertCurrentOwner(conversationId: string): Promise<void> {
    if (!(await this.#options.isCurrentOwner(conversationId))) {
      throw new TypeError("Deferred intent conversation is not owned by this anchor");
    }
  }

  #source(context: AuthorityCallContext): TrustedControlSource {
    return {
      principal: context.principal.kind === "surface"
        ? {
            surfacePrincipal: context.principal.surfacePrincipal,
            connectionId: context.principal.connectionId,
            deviceId: this.#options.deviceId,
          }
        : {
            surfacePrincipal: "surface:host:deferred-intent",
            connectionId: "host:deferred-intent",
            deviceId: this.#options.deviceId,
          },
    };
  }
}

function mutationRevision(mutation: DeferredGlobalIntent["mutation"]): number {
  return mutation.kind === "schedule-create" || mutation.kind === "rubric-save-own"
    ? 0
    : mutation.kind === "rubric-update-own"
      ? mutation.expectedRevision
      : mutation.taskRevision;
}

function intentReferences(intent: DeferredGlobalIntent): readonly ArtifactRef[] {
  return intent.mutation.kind === "rubric-save-own" ||
    intent.mutation.kind === "rubric-update-own"
    ? [intent.mutation.rubric.content]
    : [];
}
