import { randomUUID } from "node:crypto";
import type {
  AuthorityCallContext,
  ImmediateRootResourceLease,
  ImmediateRootWorkload,
  ModelCallResourceMeter,
  ReservationOrigin,
  ResourceLease,
} from "@zhixing/core/contracts";
import type { ChatRequest, LLMProvider, StreamEvent } from "@zhixing/core";
import type { SessionRuntimeTextCallOptions } from "@zhixing/owner-kernel";
import { meteredProviderCall } from "@zhixing/orchestrator/runtime";

/** control 类轻推理的治理端口窄面——由锚点 governor 履约（同进程消费，不经派发） */
export interface ControlLlmGovernor {
  acquireRoot(
    workload: ImmediateRootWorkload,
    budget: ResourceLease["budget"],
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<ImmediateRootResourceLease>;
  reserveUsage(
    lease: ResourceLease,
    usage: { usageId: string; tokens?: number; calls?: number; costMinor?: number },
    ctx: AuthorityCallContext,
  ): Promise<void>;
  consume(
    lease: ResourceLease,
    usage: { usageId: string; tokens?: number; calls?: number; costMinor?: number },
    ctx: AuthorityCallContext,
  ): Promise<void>;
  settle(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void>;
  release(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void>;
}

export type GovernedTextCall = (
  prompt: string,
  role?: "main" | "light",
  opts?: SessionRuntimeTextCallOptions,
) => Promise<string>;

export interface GovernControlTextCallOptions {
  readonly governor: ControlLlmGovernor;
  /** 入口派生的 origin——entry 与 admissionClass 按冻结映射自洽 */
  readonly origin: ReservationOrigin;
  /** control work 身份前缀（如 "llm-complete" / "turn-maintenance"） */
  readonly workPrefix: string;
  /** 单次调用敞口上界；缺省单发一调用 + 保守 token 上界 */
  readonly budget?: ResourceLease["budget"];
  readonly deadlineMs?: number;
  readonly clock?: () => Date;
  readonly workIdFactory?: () => string;
}

const DEFAULT_CONTROL_BUDGET: ResourceLease["budget"] = {
  maxCalls: 1,
  maxTokens: 300_000,
};
const DEFAULT_DEADLINE_MS = 120_000;

export interface GovernedControlMetering {
  readonly meter: ModelCallResourceMeter;
  readonly nextCallIndex: () => number;
}

interface ControlWorkSession {
  readonly metering: GovernedControlMetering;
  /** 收束会话：保守 consume 未收束预占 → settle → release；hadError 时终结失败不再抛（原错优先） */
  finalize(hadError: boolean): Promise<void>;
}

/** 开启一次 control 工作会话：acquireRoot 过公平准入并构造该租约的计量序列。 */
async function openControlWorkSession(
  options: GovernControlTextCallOptions,
): Promise<ControlWorkSession> {
  const budget = options.budget ?? DEFAULT_CONTROL_BUDGET;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const clock = options.clock ?? (() => new Date());
  const workIdFactory = options.workIdFactory ?? (() => randomUUID());

  const workId = `${options.workPrefix}:${workIdFactory()}`;
  const workload: ImmediateRootWorkload = {
    kind: "control",
    id: workId,
    attempt: 1,
  };
  const ctx: AuthorityCallContext = {
    principal: { kind: "host", component: "control-llm" },
    requestId: `control-llm:${workId}`,
    deadlineAt: new Date(clock().getTime() + deadlineMs).toISOString(),
  };
  const lease = await options.governor.acquireRoot(
    workload,
    budget,
    options.origin,
    ctx,
  );
  // 未收束预占——调用中断（结果未知）时按上限保守 consume 计终值
  const pending = new Map<string, number>();
  const meter: ModelCallResourceMeter = {
    reserve: async ({ callIndex, tokenUpperBound }) => {
      const usageId = `usage:${lease.reservationId}:model:${callIndex}`;
      await options.governor.reserveUsage(
        lease,
        { usageId, tokens: tokenUpperBound, calls: 1 },
        ctx,
      );
      pending.set(usageId, tokenUpperBound);
      return { usageId };
    },
    consume: async ({ usageId, tokens }) => {
      await options.governor.consume(
        lease,
        { usageId, ...(tokens === 0 ? {} : { tokens }), calls: 1 },
        ctx,
      );
      pending.delete(usageId);
    },
  };
  let callIndex = 0;
  return {
    metering: { meter, nextCallIndex: () => ++callIndex },
    async finalize(hadError: boolean): Promise<void> {
      try {
        for (const [usageId, upperBound] of pending) {
          await options.governor.consume(
            lease,
            { usageId, tokens: upperBound, calls: 1 },
            ctx,
          );
        }
        await options.governor.settle(lease, ctx);
        await options.governor.release(lease, ctx);
      } catch (settlementError) {
        if (!hadError) throw settlementError;
        // 原始调用错误优先透出；终结失败由过期回收兜底，不吞原错
      }
    },
  };
}

/**
 * control 类外调的统一治理骨架：acquireRoot 过公平准入 → 在计量序列内执行调用
 * （外调前耐久预占、响应后按实际用量消费）→ 调用结果未知时按预占上限保守收束 →
 * finally 内 settle + release——与资源治理规格的 control 终结行一致。
 */
export async function governControlWork<T>(
  options: GovernControlTextCallOptions,
  work: (metering: GovernedControlMetering) => Promise<T>,
): Promise<T> {
  const session = await openControlWorkSession(options);
  let hadError = false;
  try {
    return await work(session.metering);
  } catch (error) {
    hadError = true;
    throw error;
  } finally {
    await session.finalize(hadError);
  }
}

/**
 * 把裸单发文本调用包成受治理的 control 工作——governControlWork 的文本特化，
 * metering 经调用选项传入底层计量通道。
 */
export function governControlTextCall(
  options: GovernControlTextCallOptions,
  callText: GovernedTextCall,
): GovernedTextCall {
  return (prompt, role, opts) =>
    governControlWork(options, (metering) =>
      callText(prompt, role, { ...opts, modelCallMetering: metering }),
    );
}

/**
 * 把裸 LLM provider 包成逐调用受治理的 provider：每次 `chat` 都是一个独立
 * control 工作（acquireRoot → 流式预占/消费 → settle/release），供 advancement
 * 等以 provider 形态消费 LLM 的生产装配单点接入治理。真流式透传——generator
 * 的 finally 承接终结，提前中断（return/throw）同样收束。
 */
export function governControlProvider(
  options: GovernControlTextCallOptions & {
    readonly defaultMaxOutputTokens: number;
  },
  provider: LLMProvider,
): LLMProvider {
  return {
    id: provider.id,
    models: provider.models,
    chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      async function* governed(): AsyncGenerator<StreamEvent, void, undefined> {
        const session = await openControlWorkSession(options);
        let hadError = false;
        try {
          const metered = meteredProviderCall({
            call: (providerRequest) => provider.chat(providerRequest),
            meter: session.metering.meter,
            nextCallIndex: session.metering.nextCallIndex,
            defaultMaxOutputTokens: options.defaultMaxOutputTokens,
          });
          yield* metered(request);
        } catch (error) {
          hadError = true;
          throw error;
        } finally {
          await session.finalize(hadError);
        }
      }
      return governed();
    },
    ...(provider.countTokens
      ? {
          countTokens: (messages, model) => provider.countTokens!(messages, model),
        }
      : {}),
  };
}
