/**
 * SegmentSummarizeLLMFn 默认工厂 —— 从已包装的 stream factory 构造段切换调用函数。
 *
 * 设计要点：
 *   - 接受**已包装**的 `streamFactory: (req) => AsyncIterable<StreamEvent>` 而不是
 *     raw provider —— 调用方（orchestrator wiring）负责把 `withRetry` /
 *     `wrapStreamWithWatchdog` / `abortRace` 等基础设施叠加进去
 *   - 这样段切换 LLM call 自动继承主对话 LLM call 的容错与中断保护，避免
 *     "段切换路径绕过统一容错"的架构债
 *
 * 关键不变量（违反任一都会让 cache 全部失效）：
 *   - systemPrompt + tools + messages 完整透传给底层 stream factory
 *     —— 任何省略 / 重排 / 改字节都会让 cache key 错位
 *   - 用主对话同 provider / 同 model / 同账号 —— 跨实例 cache 不共享
 *
 * 流式响应消耗为单一 text 字符串返回（与现有压缩 LLM 调用约定一致）。
 */

import type { ChatRequest, StreamEvent } from "../../types/llm.js";
import type { SegmentSummarizeLLMFn } from "./types.js";

/**
 * Stream factory 类型 —— 接受 ChatRequest 返回流。
 *
 * 调用方应当通过 `withRetry` / `wrapStreamWithWatchdog` 等基础设施包装后
 * 传入此工厂，让段切换继承同款保护链。
 */
export type SegmentStreamFactory = (
  request: ChatRequest,
) => AsyncIterable<StreamEvent>;

export function createSegmentSummarizeFn(
  streamFactory: SegmentStreamFactory,
  model: string,
): SegmentSummarizeLLMFn {
  return async (req) => {
    let text = "";
    const stream = streamFactory({
      model,
      systemPrompt: req.systemPrompt,
      // readonly ToolSpec[] → mutable ToolSpec[]：ChatRequest 接收可变数组，
      // 浅拷贝消除类型 widening，数据形态不变。
      tools: [...req.tools],
      messages: [...req.messages],
      abortSignal: req.abortSignal,
    });
    for await (const event of stream) {
      if (event.type === "text_delta" && event.text) {
        text += event.text;
      }
      // 流以 error 事件终止 = 本次调用失败：抛出真实根因，让上层拿到错误
      // 本体（段管理器据此走自己的重试、应急地板把根因带给诊断与用户），
      // 而不是把错误静默成空文本、退化为"摘要解析失败"的间接症状。
      if (event.type === "error") {
        throw event.error;
      }
    }
    return text;
  };
}
