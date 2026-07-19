import type {
  AdvancementClosureReport,
  AdvancementExit,
  AdvancementRunReview,
  RunRecordAdvancementMetadata,
  TurnContext,
  UserTurnInput,
} from "@zhixing/core";

export type AdvancementProxyScheduleResult =
  | { readonly status: "immediate" | "queued" }
  | { readonly status: "not-found" | "full" | "busy" };

export type AdvancementProxyDurableClaim =
  | { readonly status: "unclaimed" }
  | { readonly status: "owned"; readonly runId: string }
  | { readonly status: "closed"; readonly runId: string };

export interface AdvancementProxyTurnRequest {
  readonly conversationId: string;
  readonly input: UserTurnInput;
  readonly turnId: string;
  readonly turnContext: TurnContext;
  readonly advancement: RunRecordAdvancementMetadata;
  readonly onTaskSettled?: () => void;
}

/** owner 准入与执行投影由组合层实现，推进服务只提交确定的代理 turn 请求。 */
export interface AdvancementProxyTurnPort {
  isRunning(conversationId: string): boolean;
  /**
   * 跨域耐久所有权判定,必需能力:恢复调度前必须取得显式 unclaimed,
   * 缺席或异常一律不得调度。legacy(无耐久 run 日志)由实现显式返回
   * unclaimed 表达"耐久 claim 不存在",不允许以方法缺省绕过查询。
   */
  inspectDurableClaim(
    conversationId: string,
    proxyMessageId: string,
  ): Promise<AdvancementProxyDurableClaim>;
  schedule(
    request: AdvancementProxyTurnRequest,
  ): Promise<AdvancementProxyScheduleResult>;
}

export type AdvancementPresentationEvent =
  | {
      readonly conversationId: string;
      readonly runId: string;
      readonly seq: 0;
      readonly event: "advancement:review_deferred";
      readonly payload: {
        readonly advancementSessionId: string;
        readonly cause: "infrastructure" | "aborted";
        readonly reason: string;
      };
    }
  | {
      readonly conversationId: string;
      readonly runId: string;
      readonly seq: 0;
      readonly event: "advancement:run_reviewed";
      readonly payload: {
        readonly advancementSessionId: string;
        readonly review: AdvancementRunReview;
        readonly reviewRound: number;
      };
    }
  | {
      readonly conversationId: string;
      readonly runId: string;
      readonly seq?: 1;
      readonly event: "advancement:proxy_enqueued";
      readonly payload: {
        readonly advancementSessionId: string;
        readonly proxyMessageId: string;
        readonly reviewId: string;
      };
    }
  | {
      readonly conversationId: string;
      readonly runId: string;
      readonly seq: 1;
      readonly event: "advancement:completed" | "advancement:exited";
      readonly payload: {
        readonly advancementSessionId: string;
        readonly reviewId: string;
        readonly exit: AdvancementExit;
        readonly closure: AdvancementClosureReport;
      };
    }
  | {
      readonly conversationId: string;
      readonly runId: string;
      readonly event: "advancement:proxy_recovered";
      readonly payload: {
        readonly advancementSessionId: string;
        readonly proxyMessageId: string;
        readonly scheduleStatus: "immediate" | "queued";
      };
    }
  | {
      readonly conversationId: string;
      readonly runId: string;
      readonly event: "advancement:recovery_failed";
      readonly payload: {
        readonly status: "not-found" | "full" | "busy" | "missing-proxy" | "failed";
        readonly advancementSessionId?: string;
        readonly proxyMessageId?: string;
        readonly message?: string;
      };
    };

/** 面向 surface 的投影是输出端口，不属于 owner 服务的传输语义。 */
export interface AdvancementEventSink {
  emit(event: AdvancementPresentationEvent): void;
}
