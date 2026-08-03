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
}

/**
 * 锚点会话状态端口（生产进程内适配器）——本单元承载 advancement 切片：
 * 推进事件只由 host principal 写入（经统一 authority guard），读取折叠自
 * 对话权威日志。其余读写面随所属单元逐片接入；未接入面按能力缺口拒绝。
 */
export class AnchorSessionStateAdapter implements SessionStatePort {
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
    if (mutation.kind !== "advancement-event") {
      throw authorityError(
        "capability-gap",
        `Session mutation kind is not routed in this unit: ${mutation.kind}`,
      );
    }
    if (ctx.principal.kind !== "host") {
      throw authorityError(
        "unauthorized",
        "Advancement events are host-only",
      );
    }
    const result = await this.#journal(conversationId).applyAdvancementEvents({
      requestId: ctx.requestId,
      events: mutation.events,
    });
    return { revision: result.domainRevision };
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

  readSessionMeta(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<SessionMeta> {
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind, "session.readSessionMeta");
    throw unavailable("session.readSessionMeta", conversationId);
  }

  readTranscriptTail(
    conversationId: string,
    ctx: AuthorityCallContext,
    _cursor?: TranscriptCursor,
    _limit?: number,
  ): Promise<TranscriptPage> {
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind,
      "session.readTranscriptTail",
    );
    throw unavailable("session.readTranscriptTail", conversationId);
  }

  readTaskList(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<TaskListState> {
    assertPrincipalAllowsAuthorityMethod(ctx.principal.kind, "session.readTaskList");
    throw unavailable("session.readTaskList", conversationId);
  }
}

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
