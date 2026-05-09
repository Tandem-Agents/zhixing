/**
 * ContextCompiler 视图层 stage 接口定义
 *
 * Stage 是每次 LLM call 之前对 messages / tools 做语义编排的纯函数式单元。
 * ContextCompiler 按注册顺序串行跑各 Stage。
 */

import type { Message } from "../../types/messages.js";
import type { ToolDefinition } from "../../types/tools.js";

/**
 * 视图层渲染时的可演化辅助状态（只读视图）。
 *
 * Stage 不直接修改 state——通过 StateDelta 输出更新意图，由 caller 应用到持久化层。
 *
 * 当前为占位 type；按需扩展具体字段（如工具能力分层、任务系统状态等）。
 */
export interface RenderState {
  // 后续按需扩展具体字段
}

/**
 * Stage 渲染输入。
 *
 * messages / tools 由 stage 链上一站产出（首站收到 caller 注入的初始值），
 * state 由 caller 在调用 ContextCompiler 时注入，整链路只读。
 */
export interface RenderContext {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly state: Readonly<RenderState>;
}

/**
 * 状态更新意图。Stage 输出，caller 在 LLM call 完成后应用到持久化层。
 *
 * 当前为占位 type；按需扩展具体字段。
 */
export interface StateDelta {
  // 后续按需扩展具体字段
}

/**
 * Stage 渲染产出。下一 Stage 看到的 messages / tools 即此输出。
 *
 * 多数 stage 是纯渲染，无 stateDelta；演化辅助状态的 stage 通过 stateDelta 表达副作用，
 * 由 caller 应用——保证 stage 链本身对输入是只读、可重入、可重试的。
 */
export interface StageOutput {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly stateDelta?: StateDelta;
}

/**
 * 视图层 Stage 契约。
 *
 * 单一职责：对 RenderContext 做语义编排，输出新版本 messages / tools。
 * render 必须对 RenderContext 任何字段只读；副作用通过 StateDelta 表达。
 *
 * 同步与异步均支持：sync stage 直接返 StageOutput；async stage（如内部触发 LLM call）
 * 返 Promise<StageOutput>。ContextCompiler 统一 await。
 *
 * 失败语义：抛错则被 ContextCompiler 跳过，下一 stage 看到上一 stage 的输出。
 */
export interface Stage {
  readonly id: string;
  render(ctx: RenderContext): Promise<StageOutput> | StageOutput;
}
