/**
 * 段切换 LLM 调用的 estimator calibration wrapper —— 透传 stream 同时捕获 usage 校准。
 *
 * 装配位置:`resilientCallLLM → wrapStreamWithWatchdog → wrapWithCalibration`(由外到内层
 * 叠加,与既有 stream wrapper 同形态)。每次段切换 LLM call 完成后用真实 inputTokens
 * 校准 estimator,让 calibration 系数随段切换路径同步收敛。
 *
 * 不走 EventBus(llm:request_end)的原因:段切换 LLM call 与主对话 LLM call emit
 * 同型事件,listener 无可靠方式区分归属;流包装层归属精确,只看自己经手的 stream。
 *
 * 校准条件与 main agent loop 严格一致:`!aborted && !errored && usage.inputTokens > 0`
 * —— abort / error / 空 usage 全部跳过,这些样本不可靠,会污染滑动平均。
 *
 * 实现采用 async generator:逐事件透传保 stream 行为完全一致(下游消费方看不出
 * wrapper 存在);usage 在 message_end 事件捕获;error event 标记 errored;迭代被
 * 中断(stream 抛错 / abort race 提前退出)时不进入 finally 后的校准代码,
 * 自然跳过不可靠样本。
 */

import type { ITokenEstimator } from "../types.js";
import type { Message } from "../../types/messages.js";
import type { StreamEvent, TokenUsage } from "../../types/llm.js";

export interface WrapWithCalibrationOptions {
  /** 估算器实例 —— 校准操作的目标(滑动平均会更新其内部系数) */
  readonly estimator: ITokenEstimator;
  /**
   * 段切换 LLM call 实际发送的 messages(已含压缩指令的缓存安全分叉)。
   * 校准与"LLM 实际处理的 size"对账,而非数据层 state.messages —— 后者会因压缩
   * 指令注入产生系统性偏差,让 calibration 系数无法收敛。
   */
  readonly messages: readonly Message[];
}

export async function* wrapWithCalibration(
  stream: AsyncIterable<StreamEvent>,
  options: WrapWithCalibrationOptions,
): AsyncIterable<StreamEvent> {
  let usage: TokenUsage | null = null;
  let errored = false;

  for await (const event of stream) {
    if (event.type === "message_end") {
      usage = event.usage;
    } else if (event.type === "error") {
      // provider error event —— 走 success variant 但携带 error 字段(与 main loop
      // 校准跳过 llmResult.error 路径同源:这次样本不可靠)
      errored = true;
    }
    yield event;
  }

  // 仅在成功完成且有有效 usage 时校准;abort / error / 空 usage 都跳过
  if (!errored && usage !== null && usage.inputTokens > 0) {
    const estimated = options.estimator.estimateMessages(options.messages);
    options.estimator.calibrate(estimated, usage.inputTokens);
  }
}
