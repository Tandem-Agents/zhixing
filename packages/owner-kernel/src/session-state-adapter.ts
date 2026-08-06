import type {
  AdvancementSnapshot,
  AuthorityCallContext,
  AuthorityError,
  SessionControlMutation,
  SessionStatePort,
  SessionStagedMutation,
  SessionMeta,
  TaskListState,
  TranscriptCursor,
  TranscriptPage,
} from "@zhixing/core/contracts";
import {
  assertPrincipalAllowsAuthorityMethod,
  assertProtocolIdentifier,
} from "@zhixing/core/protocol";
import { advancementHeadSession } from "@zhixing/core/advancement";
import type { ConversationRunJournal } from "./conversation-assignment.js";

export interface AnchorSessionStateAdapterOptions {
  readonly journalFor: (conversationId: string) => ConversationRunJournal;
  readonly sessionExists?: (conversationId: string) => Promise<boolean>;
  readonly mutateControl?: (
    conversationId: string,
    mutation: Exclude<SessionControlMutation, { readonly kind: "advancement-event" }>,
    ctx: AuthorityCallContext,
  ) => Promise<{ readonly revision: number }>;
  readonly stageAssignment?: (
    conversationId: string,
    mutation: SessionStagedMutation,
    ctx: AuthorityCallContext,
  ) => Promise<{ readonly revision: number }>;
}

/**
 * Domain-neutral session-state adapter. Every read folds the conversation
 * owner journal; control and assignment writes retain their distinct guarded
 * entry points while sharing the same session reducer.
 */
export class ConversationSessionStateAdapter implements SessionStatePort {
  readonly #options: AnchorSessionStateAdapterOptions;

  constructor(options: AnchorSessionStateAdapterOptions) {
    this.#options = options;
  }

  async readAdvancementState(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<AdvancementSnapshot | null> {
    assertProtocolIdentifier(conversationId, "Session conversationId");
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind,
      "session.readAdvancementState",
    );
    return advancementHeadSession(
      await this.#journal(conversationId).advancementSessions(),
    );
  }

  async mutate(
    conversationId: string,
    mutation: SessionControlMutation | SessionStagedMutation,
    ctx: AuthorityCallContext,
  ): Promise<{ revision: number }> {
    assertProtocolIdentifier(conversationId, "Session conversationId");
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind, "session.mutate");
    assertProtocolIdentifier(ctx.requestId, "Session mutation requestId");
    if (mutation.kind === "advancement-event") {
      if (ctx.principal.kind !== "host") {
        throw authorityError("unauthorized", "Advancement events are host-only");
      }
      const journal = this.#journal(conversationId);
      const existing = await journal.advancementWriteRequest(ctx.requestId);
      if (!existing) {
        const authority = await journal.authorityState();
        const exists = authority.hasDurableIdentity ||
          (await this.#options.sessionExists?.(conversationId)) === true;
        if (!exists) {
          throw authorityError(
            "not-found",
            `Session does not exist: ${conversationId}`,
          );
        }
      }
      const result = await journal.applyAdvancementEvents({
        requestId: ctx.requestId,
        events: mutation.events,
      });
      return { revision: result.domainRevision };
    }
    if (
      ctx.principal.kind === "assignment" &&
      (mutation.kind === "task-list-op" || mutation.kind === "segment-append")
    ) {
      if (!this.#options.stageAssignment) {
        throw unavailable("session.mutate assignment staging", conversationId);
      }
      return this.#options.stageAssignment(conversationId, mutation, ctx);
    }
    if (mutation.kind === "segment-append") {
      throw authorityError(
        "unauthorized",
        "Segment history can only be staged by its active assignment",
      );
    }
    if (!this.#options.mutateControl) {
      throw unavailable("session.mutate control", conversationId);
    }
    return this.#options.mutateControl(conversationId, mutation, ctx);
  }

  #journal(conversationId: string): ConversationRunJournal {
    const journal = this.#options.journalFor(conversationId);
    if (journal.conversationId !== conversationId) {
      throw authorityError(
        "invalid",
        `Session state journal belongs to another conversation: ${journal.conversationId}`,
      );
    }
    return journal;
  }

  async readSessionMeta(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<SessionMeta> {
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind, "session.readSessionMeta");
    return this.#journal(conversationId).sessionMeta();
  }

  async readTranscriptTail(
    conversationId: string,
    ctx: AuthorityCallContext,
    _cursor?: TranscriptCursor,
    _limit?: number,
  ): Promise<TranscriptPage> {
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind,
      "session.readTranscriptTail",
    );
    return this.#journal(conversationId).transcriptTail(_cursor, _limit);
  }

  async readTaskList(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<TaskListState> {
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind, "session.readTaskList");
    return this.#journal(conversationId).taskList();
  }
}

/** Backward-compatible name for the anchor composition; behavior is domain-neutral. */
export class AnchorSessionStateAdapter extends ConversationSessionStateAdapter {}

function unavailable(method: string, conversationId: string): AuthorityError {
  return authorityError(
    "capability-gap",
    `${method} is not routed in this unit (conversation: ${conversationId})`,
  );
}

function authorityError(
  code: AuthorityError["code"],
  message: string,
): AuthorityError {
  return { code, message, retryable: false };
}
