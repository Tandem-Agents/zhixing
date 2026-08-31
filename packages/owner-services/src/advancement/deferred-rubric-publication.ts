import type { RubricContractDraftSnapshot, RubricDraftPersistenceChoice } from "@zhixing/core";
import type {
  AuthorityCallContext,
  DeferredGlobalIntent,
  DeferredGlobalIntentPort,
} from "@zhixing/core/contracts";
import type {
  RubricPublicationOutcome,
  RubricPublicationPort,
} from "@zhixing/core/advancement/application";

const DEFERRED_MESSAGE = "已用于本任务，连接值班设备后保存";

export interface DeferredRubricPublicationOptions {
  readonly intents: DeferredGlobalIntentPort;
  readonly prepareMutation: (input: {
    readonly draft: RubricContractDraftSnapshot;
    readonly persistence: RubricDraftPersistenceChoice;
  }) => Promise<DeferredGlobalIntent["mutation"]>;
  readonly now?: () => string;
}

/**
 * Local-owner adapter seam. The durable intent log remains owned by the injected
 * port; advancement only prepares the Rubric mutation and records the intent.
 */
export class DeferredRubricPublication implements RubricPublicationPort {
  readonly #options: DeferredRubricPublicationOptions;
  readonly #now: () => string;

  constructor(options: DeferredRubricPublicationOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  acceptanceOutcome(): RubricPublicationOutcome {
    return { kind: "deferred", message: DEFERRED_MESSAGE };
  }

  async publish(
    input: Parameters<RubricPublicationPort["publish"]>[0],
  ): Promise<RubricPublicationOutcome> {
    const mutation = await this.#options.prepareMutation({
      draft: input.draft,
      persistence: input.persistence,
    });
    await this.#options.intents.record(
      input.conversationId,
      mutation,
      false,
      this.#context(input),
    );
    return this.acceptanceOutcome();
  }

  #context(
    input: Parameters<RubricPublicationPort["publish"]>[0],
  ): AuthorityCallContext {
    const persistenceIdentity = input.persistence.kind === "update-existing"
      ? `${input.persistence.kind}:${input.persistence.rubricId}`
      : input.persistence.kind;
    return {
      principal: { kind: "host", component: "advancement-rubric-intent" },
      requestId: `rubric-intent:${input.conversationId}:${input.draft.draftId}:${persistenceIdentity}`,
      deadlineAt: new Date(Date.parse(this.#now()) + 30_000).toISOString(),
    };
  }
}
