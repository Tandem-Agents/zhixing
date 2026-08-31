import {
  bindProductApiOperation,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import { buildClosureFacts, type AdvancementClosureFacts } from "./closure.js";
import type {
  AdvancementExit,
  AdvancementRunReview,
  AdvancementSession,
  AdvancementSessionStatus,
} from "./types.js";

/** Path-free read mechanism for the current Advancement owner projection. */
export interface AdvancementDetailReadPort {
  loadLatestSession(conversationId: string): Promise<AdvancementSession | null>;
}

export interface AdvancementDetailQuery {
  readonly conversationId: string;
}

export interface AdvancementDetailProjection {
  readonly advancementSessionId: string;
  readonly status: AdvancementSessionStatus;
  readonly rubricTitle?: string;
  readonly exit?: AdvancementExit;
  readonly facts: AdvancementClosureFacts;
  readonly lastReview?: AdvancementRunReview;
}

export type AdvancementDetailResult = AdvancementDetailProjection | null;

export interface AdvancementApplication {
  queryDetail(query: AdvancementDetailQuery): Promise<AdvancementDetailResult>;
}

/** Advancement-owned application decision for the expandable detail view. */
export class AdvancementApplicationService implements AdvancementApplication {
  constructor(private readonly detail: AdvancementDetailReadPort) {}

  async queryDetail(
    query: AdvancementDetailQuery,
  ): Promise<AdvancementDetailResult> {
    assertConversationId(query.conversationId);
    const session = await this.detail.loadLatestSession(query.conversationId);
    if (!session) return null;

    const lastReview = session.runs[session.runs.length - 1];
    return freezeSnapshot({
      advancementSessionId: session.id,
      status: session.status,
      ...(session.confirmedRubric?.title
        ? { rubricTitle: session.confirmedRubric.title }
        : session.pendingRubricDraft?.title
          ? { rubricTitle: session.pendingRubricDraft.title }
          : {}),
      ...(session.exit ? { exit: session.exit } : {}),
      facts: buildClosureFacts(session),
      ...(lastReview ? { lastReview } : {}),
    });
  }
}

export const ADVANCEMENT_DETAIL_QUERY = defineProductApiQuery<
  "advancement.query.detail",
  AdvancementDetailQuery,
  AdvancementDetailResult
>("advancement.query.detail");

export const ADVANCEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [ADVANCEMENT_DETAIL_QUERY],
  factEvents: [],
});

export function createAdvancementProductApiContribution(
  application: AdvancementApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(ADVANCEMENT_DETAIL_QUERY, async (query) => ({
        result: await application.queryDetail(query),
        facts: [],
      })),
    ],
    factEvents: [],
  });
}

function assertConversationId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Advancement detail requires a conversation identity");
  }
}

function freezeSnapshot<T>(value: T): Readonly<T> {
  const snapshot = structuredClone(value);
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
