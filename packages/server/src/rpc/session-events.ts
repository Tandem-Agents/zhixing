/**
 * 会话事件投影 —— per-run bus 带外事件 → RPC 通知(`session.event`)的转发装饰器。
 *
 * 与主通道(`session.delta` 承载 AgentYield 产出流)并行的第二条腿:渲染提示类
 * 带外事件(重试 / 段切换 / 中断 / 上下文水位等)经统一信封跨进程投影,接入面
 * 还原为本地 bus 事件喂渲染订阅。
 *
 * wire 纪律(不是"全事件谱原样序列化"):
 * - 默认只投 UI 订阅集——渲染与状态条实际消费的小 payload 事件;
 * - 诊断级大 payload(`llm:request_start` 的完整 messages / tools / systemPrompt、
 *   `segment:new_started` 的 windowCompact 全文)不上 wire——诊断 dump 随 runtime
 *   在宿主本地落盘;
 * - `meta.lineage` 必留(接入面渲染层区分子 agent 帧依赖它),`meta.turnOrigin`
 *   标注发起接入面(旁观端显示消息来源)。
 *
 * 无对话身份(ephemeral 任务 / 测试裸跑)的 run 不转发——带外投影只服务会话。
 */

import type {
  AgentEventMap,
  EventMeta,
  IEventBus,
  TurnContext,
} from "@zhixing/core";

/**
 * 转发装饰器的入参——与 orchestrator 的 per-run 装饰钩子(RunBusContext)结构
 * 兼容;server 不依赖 orchestrator(运行时实现经工厂注入),故以结构形参数声明。
 */
export interface RunEventSource {
  bus: IEventBus<AgentEventMap>;
  conversationId?: string;
  turnContext?: TurnContext;
}

// ─── wire 信封 ───

export type SessionEventScope = "run" | "control";

export interface SessionEventEnvelope {
  conversationId: string;
  /** 事件归属域。发端负责标记，接入面按此分流，避免各端重复维护事件分类。 */
  scope: SessionEventScope;
  /** 本 run 的标识——取 turn 上下文的 turnId;缺省(无 turn 语境)时为空串 */
  runId: string;
  /** run 内单调递增——接收端跨连接重建顺序 / 去重用 */
  seq: number;
  /** AgentEventMap 的事件名 */
  event: string;
  payload: unknown;
  meta: {
    /** emit 来源 bus 的 lineage 路径——渲染层区分主 agent / 子 agent 帧 */
    lineage?: string;
    /** 发起本 turn 的接入面身份——旁观端标注消息来源 */
    turnOrigin?: TurnContext["turnOrigin"];
  };
}

/** `session.event` 通知的发送函数——由装配方注入(组播给会话 observers) */
export type SessionEventBroadcast = (
  conversationId: string,
  envelope: SessionEventEnvelope,
) => void;

export interface ControlSessionEventInput {
  readonly conversationId: string;
  readonly runId: string;
  readonly seq?: number;
  readonly event: string;
  readonly payload: unknown;
}

/** control 面事件由发端标记 scope，接入面不再靠事件名前缀猜测归属。 */
export function createControlSessionEventEnvelope(
  input: ControlSessionEventInput,
): SessionEventEnvelope {
  return {
    conversationId: input.conversationId,
    scope: "control",
    runId: input.runId,
    seq: input.seq ?? 0,
    event: input.event,
    payload: input.payload,
    meta: {},
  };
}

// ─── UI 订阅集投影表 ───

type Projector<K extends keyof AgentEventMap> = (
  payload: AgentEventMap[K],
) => unknown;

/**
 * 默认投影 = UI 订阅集:键集合即转发白名单(不在表内的事件不上 wire),
 * 值为 payload 裁剪函数(恒等 = 小 payload 全量)。
 */
const UI_EVENT_PROJECTION: { [K in keyof AgentEventMap]?: Projector<K> } = {
  // run 边界——接入面据此建立 / 拆除 per-run 投影 bus;run_start 的 prompt
  // 同时是旁观端的 user 消息来源
  "agent:run_start": (p) => p,
  "agent:run_end": (p) => p,

  // LLM 调用摘要——只投状态条消费的摘要字段,完整 systemPrompt / messages /
  // tools 是诊断级大 payload,不上 wire
  "llm:request_start": (p) => ({
    model: p.model,
    messageCount: p.messageCount,
    hasTools: p.hasTools,
  }),

  // 上下文水位快照(turn 末尾 emit 一次)
  "context:tokens_snapshot": (p) => p,

  // 重试提示
  "retry:attempt": (p) => p,
  "retry:success": (p) => p,
  "retry:exhausted": (p) => p,

  // 段切换提示——new_started 裁掉 windowCompact 全文(窗口重构指令是
  // 接受协议的内部载荷,不是展示数据)
  "segment:transition_start": (p) => p,
  "segment:emergency_floor": (p) => p,
  "segment:new_started": (p) => ({
    segmentId: p.segmentId,
    bufferTurns: p.bufferTurns,
    tokensBefore: p.tokensBefore,
    tokensAfter: p.tokensAfter,
  }),
  "segment:transition_failed": (p) => p,

  // 中断两段提示
  "interrupt:warn": (p) => p,
  "interrupt:fired": (p) => p,

  // 安全管线提示
  "security:steward_review": (p) => p,
  "security:rule_sedimented": (p) => p,

  // 生命周期钩子提示
  "lifecycle:hook_failed": (p) => p,
  "lifecycle:prompt_rebuilt": (p) => p,
};

// ─── 转发装饰器 ───

/**
 * 创建带外事件转发装饰器(`DecorateRunBusFn` 形)——宿主侧 decorateRunBus
 * 钩子的转发实现,与本地渲染装饰器在装配处组合。
 *
 * per-run 一次装饰:按投影表订阅,事件到达即裁剪、装信封、组播;dispose
 * 随 run 结束解除全部订阅,杜绝 listener 跨 run 累积。
 */
export function createRunEventForwarder(
  broadcast: SessionEventBroadcast,
): (ctx: RunEventSource) => () => void {
  return ({ bus, conversationId, turnContext }) => {
    // 无对话身份的 run(ephemeral 任务 / 测试)不进带外投影
    if (!conversationId) return () => {};

    const runId = turnContext?.turnId ?? "";
    const turnOrigin = turnContext?.turnOrigin;
    let seq = 0;

    const unsubs = (
      Object.entries(UI_EVENT_PROJECTION) as Array<
        [keyof AgentEventMap, (payload: never) => unknown]
      >
    ).map(([event, project]) =>
      bus.on(event, ((payload: unknown, meta?: EventMeta) => {
        broadcast(conversationId, {
          conversationId,
          scope: "run",
          runId,
          seq: seq++,
          event,
          payload: project(payload as never),
          meta: { lineage: meta?.lineage, turnOrigin },
        });
      }) as never),
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  };
}
