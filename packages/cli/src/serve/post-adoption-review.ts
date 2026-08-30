import {
  ConfirmationBroker,
  parseLocalConversationId,
  type ConfirmationDecision,
  type ConfirmationLifecycleObserver,
  type ConfirmationRequest,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  DeferredGlobalIntent,
} from "@zhixing/core/contracts";
import type { ConversationAdoptionReviewProjection } from "@zhixing/core/conversation/application";
import type { ConfirmationHub } from "@zhixing/owner-kernel";

interface DeferredIntentReviewPort {
  list(
    conversationId: string,
    context: AuthorityCallContext,
  ): Promise<readonly DeferredGlobalIntent[]>;
  decide(
    intentId: string,
    decision: "confirmed" | "discarded",
    context: AuthorityCallContext,
  ): Promise<DeferredGlobalIntent>;
}

interface PendingSurfaceDecision {
  readonly intentId: string;
  readonly conversationId: string;
  readonly surfacePrincipal: string;
  readonly context: AuthorityCallContext;
  requestPromise?: Promise<ConfirmationDecision>;
}

/** Anchor-only adoption consumer. Durable state remains the imported intent stream. */
export class PostAdoptionReviewCoordinator {
  readonly #review: DeferredIntentReviewPort;
  readonly #hub: ConfirmationHub;
  readonly #broker: ConfirmationBroker;
  readonly #workingDirectory: string;
  readonly #now: () => number;
  readonly #surfaceDecisions = new Map<string, PendingSurfaceDecision>();
  readonly #surfaceTransitions = new Map<string, Promise<void>>();
  readonly #requested = new Set<string>();
  #closed = false;

  constructor(input: {
    readonly review: DeferredIntentReviewPort;
    readonly hub: ConfirmationHub;
    readonly workingDirectory: string;
    readonly now?: () => number;
  }) {
    this.#review = input.review;
    this.#hub = input.hub;
    this.#workingDirectory = input.workingDirectory;
    this.#now = input.now ?? (() => Date.now());
    const lifecycle: ConfirmationLifecycleObserver = {
      beforeRequest: async (request) => {
        if (!this.#surfaceDecisions.has(request.id)) {
          throw new Error("这项排程确认已失效，请重新打开对话后再试。");
        }
      },
      afterResolved: async (request, decision, source) => {
        if (source.kind !== "surface") return;
        const pending = this.#surfaceDecisions.get(request.id);
        if (!pending) {
          throw new Error("这项排程确认已失效，请重新打开对话后再试。");
        }
        const outcome = scheduleDecision(decision);
        if (!outcome) return;
        try {
          await this.#review.decide(pending.intentId, outcome, {
            ...pending.context,
            requestId: `adoption-decision:${pending.intentId}:${outcome}`,
          });
        } catch {
          throw new Error(
            "这项排程暂时没有确认成功，内容仍已保存，请稍后重新打开对话再试。",
          );
        }
      },
    };
    this.#broker = new ConfirmationBroker({
      id: "post-adoption-review",
      lifecycleObserver: lifecycle,
      resolvedGraceMs: 1,
      maxQueueDepth: 128,
      now: this.#now,
    });
    this.#hub.attach("post-adoption-review", this.#broker, {
      conversationIdFor: (request) =>
        this.#surfaceDecisions.get(request.id)?.conversationId,
    });
  }

  /** Runs immediately after commit/recovery; rubric writes need no user gesture. */
  async reviewAfterAdoption(
    conversationId: string,
  ): Promise<ConversationAdoptionReviewProjection> {
    return this.#reviewConversation(conversationId);
  }

  /** Rebuilds actionable schedule confirmations for the authenticated current surface. */
  async reviewForSurface(input: {
    readonly conversationId: string;
    readonly surfacePrincipal: string;
    readonly connectionId: string;
  }): Promise<ConversationAdoptionReviewProjection | undefined> {
    if (!parseLocalConversationId(input.conversationId)) return undefined;
    const summary = await this.#reviewConversation(input.conversationId);
    if (summary.status !== "ready") return summary;
    const context = surfaceContext(input, this.#now());
    let intents: readonly DeferredGlobalIntent[];
    try {
      intents = await this.#review.list(input.conversationId, context);
    } catch {
      return retrySummary();
    }
    for (const intent of intents) {
      if (intent.status !== "pending" || !intent.timeSensitive) continue;
      await this.#requestScheduleConfirmation(intent, context);
    }
    return summary;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#hub.detach("post-adoption-review", {
      cancelPending: true,
      cause: "session-end",
    });
    this.#requested.clear();
    this.#surfaceDecisions.clear();
    this.#surfaceTransitions.clear();
  }

  async #reviewConversation(
    conversationId: string,
  ): Promise<ConversationAdoptionReviewProjection> {
    if (!parseLocalConversationId(conversationId)) return readySummary(0, 0, 0);
    const context = hostContext(conversationId, this.#now());
    let intents: readonly DeferredGlobalIntent[];
    try {
      intents = await this.#review.list(conversationId, context);
    } catch {
      return retrySummary();
    }
    let appliedRuleCount = 0;
    for (const intent of intents) {
      if (intent.status !== "pending" || intent.timeSensitive) continue;
      try {
        await this.#review.decide(intent.intentId, "confirmed", {
          ...context,
          requestId: `adoption-auto:${intent.intentId}`,
        });
        appliedRuleCount += 1;
      } catch {
        // A concurrent/global conflict remains a durable pending item and is
        // presented below; automatic review never guesses through a conflict.
      }
    }
    try {
      intents = await this.#review.list(conversationId, context);
    } catch {
      return retrySummary();
    }
    return readySummary(
      appliedRuleCount,
      intents.filter((intent) => intent.status === "pending" && intent.timeSensitive).length,
      intents.filter((intent) => intent.status === "pending" && !intent.timeSensitive).length,
    );
  }

  async #requestScheduleConfirmation(
    intent: DeferredGlobalIntent,
    context: AuthorityCallContext,
  ): Promise<void> {
    const requestId = `adoption-review:${intent.intentId}`;
    const previous = this.#surfaceTransitions.get(requestId) ?? Promise.resolve();
    const transition = previous.catch(() => {}).then(() =>
      this.#replaceScheduleConfirmation(requestId, intent, context));
    this.#surfaceTransitions.set(requestId, transition);
    try {
      await transition;
    } finally {
      if (this.#surfaceTransitions.get(requestId) === transition) {
        this.#surfaceTransitions.delete(requestId);
      }
    }
  }

  async #replaceScheduleConfirmation(
    requestId: string,
    intent: DeferredGlobalIntent,
    context: AuthorityCallContext,
  ): Promise<void> {
    const principal = surfacePrincipal(context);
    const existing = this.#surfaceDecisions.get(requestId);
    if (existing?.surfacePrincipal === principal) return;
    if (existing) {
      this.#broker.cancel(requestId, "session-end");
      await existing.requestPromise?.catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const current = await this.#review.list(intent.conversationId, context);
      if (!current.some((item) => item.intentId === intent.intentId && item.status === "pending")) {
        return;
      }
    }
    this.#requested.add(requestId);
    const pending: PendingSurfaceDecision = {
      intentId: intent.intentId,
      conversationId: intent.conversationId,
      surfacePrincipal: principal,
      context,
    };
    this.#surfaceDecisions.set(requestId, pending);
    const createdAt = this.#now();
    const request: ConfirmationRequest = {
      id: requestId,
      tool: "排程确认",
      toolInput: { action: scheduleAction(intent) },
      workingDirectory: this.#workingDirectory,
      operationClass: "external",
      display: {
        title: "确认离线期间保存的排程",
        body: {
          kind: "generic",
          summary: scheduleAction(intent),
          details: {
            提示: "确认后才会在值班设备生效；拒绝或暂不处理都不会丢失对话内容。",
          },
        },
        cwd: this.#workingDirectory,
      },
      options: [
        { kind: "allow-once", label: "确认并启用", hotkey: "y" },
        { kind: "deny", label: "不启用", hotkey: "n" },
      ],
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt,
      expiresAt: createdAt + 30 * 60_000,
      turnOrigin: {
        channel: "rpc",
        triggeredBy: surfacePrincipal(context),
      },
    };
    pending.requestPromise = this.#broker.requestConfirmation(request);
    void pending.requestPromise
      .catch(() => {})
      .finally(() => {
        if (this.#surfaceDecisions.get(requestId) === pending) {
          this.#requested.delete(requestId);
          this.#surfaceDecisions.delete(requestId);
        }
      });
  }
}

function surfacePrincipal(context: AuthorityCallContext): string {
  if (context.principal.kind !== "surface") {
    throw new TypeError("排程确认必须绑定当前会话入口。");
  }
  return context.principal.surfacePrincipal;
}

function hostContext(conversationId: string, now: number): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "post-adoption-review" },
    requestId: `adoption-list:${conversationId}`,
    deadlineAt: new Date(now + 10 * 60_000).toISOString(),
  };
}

function surfaceContext(
  input: {
    readonly conversationId: string;
    readonly surfacePrincipal: string;
    readonly connectionId: string;
  },
  now: number,
): AuthorityCallContext {
  return {
    principal: {
      kind: "surface",
      surfacePrincipal: input.surfacePrincipal,
      connectionId: input.connectionId,
    },
    requestId: `adoption-surface:${input.conversationId}`,
    deadlineAt: new Date(now + 30 * 60_000).toISOString(),
  };
}

function scheduleDecision(
  decision: ConfirmationDecision,
): "confirmed" | "discarded" | undefined {
  if (decision.kind === "allow-once") return "confirmed";
  if (decision.kind === "deny") return "discarded";
  return undefined;
}

function scheduleAction(intent: DeferredGlobalIntent): string {
  switch (intent.mutation.kind) {
    case "schedule-create":
      return `新增排程“${intent.mutation.spec.name}”`;
    case "schedule-update":
      return `更新排程“${intent.mutation.spec.name}”`;
    case "schedule-set-state":
      return intent.mutation.state === "enabled" ? "启用一个排程" : "暂停一个排程";
    case "schedule-delete":
      return "删除一个排程";
    default:
      return "处理一项离线保存的规则";
  }
}

function readySummary(
  appliedRuleCount: number,
  pendingScheduleCount: number,
  pendingRuleCount: number,
): ConversationAdoptionReviewProjection {
  const pending: string[] = [];
  if (pendingScheduleCount > 0) pending.push(`${pendingScheduleCount} 项排程等待确认`);
  if (pendingRuleCount > 0) pending.push(`${pendingRuleCount} 项规则保存需要处理`);
  return {
    status: "ready",
    mergedConversationCount: 1,
    appliedRuleCount,
    pendingScheduleCount,
    pendingRuleCount,
    message: pending.length > 0
      ? `已合并 1 个本机对话；${pending.join("，")}。`
      : "已合并 1 个本机对话，离线期间保存的内容已处理完成。",
  };
}

function retrySummary(): ConversationAdoptionReviewProjection {
  return {
    status: "retry",
    mergedConversationCount: 1,
    pendingScheduleCount: 0,
    pendingRuleCount: 0,
    message: "本机对话已经合并，但待确认事项暂时无法加载；内容已保留，请稍后重新打开这个对话。",
  };
}
