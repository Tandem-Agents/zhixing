/**
 * 可中断 Agent Loop 协议层类型。
 *
 * 设计与背景:research/design/specifications/interruptible-agent-loop-execution.md
 */

// ─── AbortReason 判别联合 ───
//
// 用判别联合而非字符串 reason:`switch (reason.kind)` 在 strict 模式下能穷尽
// 检查;每种 kind 自带强类型 metadata;新增 kind 时所有未覆盖分支编译报错。
// 字符串 reason 拼写错误编译期发现不了,且元数据要么挂在松散的 record 里
// 要么塞进 message 字符串,下游解析脆弱。

export interface UserCancelReason {
  readonly kind: "user-cancel";
  readonly source: "esc" | "ctrl-c" | "sigint" | "rpc";
  /** monotonic ms,source 侧记录按键瞬间 */
  readonly pressedAt: number;
}

export interface IdleTimeoutReason {
  readonly kind: "idle-timeout";
  /** 触发的阈值(ms) */
  readonly timeoutMs: number;
  /** 触发前已收到的 stream chunk 数 */
  readonly chunksReceived: number;
  /** 距上次 chunk 经过的时间(ms) */
  readonly elapsedSinceLastChunkMs: number;
}

export interface ParentAbortReason {
  readonly kind: "parent-abort";
  /**
   * 父 controller 的 abort reason。父若非本模块控制(如裸 AbortController.abort()
   * 不带 reason)可能为 null,下游需做"未知 reason"分支处理。
   */
  readonly parentReason: AbortReason | null;
}

export interface ExternalSignalReason {
  readonly kind: "external";
  /** 调用方可标注用于诊断,如 "scheduler-task-timeout" */
  readonly origin?: string;
}

export type AbortReason =
  | UserCancelReason
  | IdleTimeoutReason
  | ParentAbortReason
  | ExternalSignalReason;

// ─── WatchdogPolicy ───

export interface WatchdogPolicy {
  /**
   * stream chunk 间最大间隔(ms)。`<= 0` 仅禁用 idle-timer,abort 响应能力
   * (race 基础层)仍生效。
   */
  readonly idleTimeoutMs: number;
  /**
   * 警告阈值比例,在 (0, 1) 开区间内。触发后 EventBus 发 `interrupt:warn`,
   * 不立即 abort。`createWatchdogPolicy` 工厂会拒绝端点和越界值;直接构造
   * 对象使用属于编程错误。
   */
  readonly warnThresholdRatio: number;
}

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  idleTimeoutMs: 60_000,
  warnThresholdRatio: 0.5,
};

/**
 * 构造 `WatchdogPolicy` 并验证两个字段的退化输入。把配置错误在启动期暴露,
 * 而不是等运行期发生在用户面前。
 *
 * `idleTimeoutMs`:必须是非负有限数。`0` 是 documented feature(禁用 idle-timer,
 * race 基础层仍生效),NaN 会让下游 `setTimeout` 当作 `0` 立刻触发,Infinity 会被
 * 隐式 clamp 到 32-bit 上限(~25 天)给调用方误导,负数语义不明。
 *
 * `warnThresholdRatio`:必须在开区间 (0, 1)。端点 `0` 让 warn 与 stream 起点同时
 * 触发,失去预警意义;端点 `1` 让 warn 与 abort 同刻触发,用户来不及反应。
 */
export function createWatchdogPolicy(opts: Partial<WatchdogPolicy> = {}): WatchdogPolicy {
  const policy: WatchdogPolicy = { ...DEFAULT_WATCHDOG_POLICY, ...opts };

  if (!Number.isFinite(policy.idleTimeoutMs) || policy.idleTimeoutMs < 0) {
    throw new TypeError(
      `WatchdogPolicy.idleTimeoutMs must be a non-negative finite number ` +
        `(use 0 to disable idle-timer), got ${policy.idleTimeoutMs}`,
    );
  }

  if (
    !Number.isFinite(policy.warnThresholdRatio) ||
    policy.warnThresholdRatio <= 0 ||
    policy.warnThresholdRatio >= 1
  ) {
    throw new TypeError(
      `WatchdogPolicy.warnThresholdRatio must be in (0, 1), got ${policy.warnThresholdRatio}`,
    );
  }

  return policy;
}
