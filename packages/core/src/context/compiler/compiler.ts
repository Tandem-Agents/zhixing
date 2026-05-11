/**
 * ContextCompiler — 视图层 Stage 链 runner
 *
 * 每次 LLM call 之前调用一次 compile，按注册顺序串行跑各 Stage：
 *   stage[i].render 的输出成为 stage[i+1] 的输入；
 *   最后一站的输出 + 聚合 StateDelta 由 caller 用于实际 LLM 调用与持久化。
 *
 * 设计原则：
 * - 空 Stage 链 = pass-through（输入直接成为输出）
 * - Stage 链对 RenderContext 是只读的；副作用通过 StateDelta 输出由 caller 应用
 * - 单 Stage 抛错 → 跳过此 stage，下一 stage 看到上一 stage 的输出（graceful degradation）
 * - Stage 顺序与依赖由 caller 注册时决定；compiler 本身对 stage 语义无假设
 */

import type { Message } from "../../types/messages.js";
import type { ToolDefinition } from "../../types/tools.js";
import type { RenderState, Stage, StateDelta } from "./types.js";

export interface CompileInput {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly state: Readonly<RenderState>;
}

export interface CompileOutput {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  /** 各 Stage 输出的 StateDelta 浅合并结果；空链或无 stage 输出 delta 时为空对象 */
  readonly stateDelta: StateDelta;
}

export class ContextCompiler {
  private readonly stages: readonly Stage[];

  constructor(stages: readonly Stage[] = []) {
    this.stages = stages;
  }

  async compile(input: CompileInput): Promise<CompileOutput> {
    let messages = input.messages;
    let tools = input.tools;
    const aggregatedDelta: StateDelta = {};

    for (const stage of this.stages) {
      try {
        const output = await stage.render({
          messages,
          tools,
          state: input.state,
        });
        messages = output.messages;
        tools = output.tools;
        if (output.stateDelta) {
          // StateDelta 当前为占位 type；浅 spread 即可。
          // 扩展具体字段时按字段类型决定 merge 策略。
          Object.assign(aggregatedDelta, output.stateDelta);
        }
      } catch {
        // Stage 失败时跳过，让链路继续；下一 stage 看到上一 stage 的输出。
        // 失败可观测性（事件 / 日志）由具体 stage 上线时按需引入——本框架仅提供
        // 安全门，不主张特定上报策略。
      }
    }

    return { messages, tools, stateDelta: aggregatedDelta };
  }
}
