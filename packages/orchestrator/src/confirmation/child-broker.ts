/**
 * 子 agent confirmation broker resolver 路由
 *
 * 子 agent 派生 broker 不同于主 broker —— 它通常无 UI listener (子无终端),
 * 必须通过 `nonInteractiveResolver` 决定"无人响应"时的兜底行为。
 *
 * 本模块只提供 policy → resolver 的纯映射,不持有状态、不创建 broker:
 *   - `runChildAgent` 调本函数取 resolver,再 `new ConfirmationBroker({ ..., nonInteractiveResolver })`
 *   - 测试可独立验证策略路径,与 broker 装配解耦
 *
 * 安全姿态契约:
 *   `SubAgentConfirmationPolicy` 联合类型仅含**生产安全**字面值(见
 *   [budget.ts](../subagent/budget.ts) 类型定义)。本函数所有可能返回值都是
 *   "fail-deny" 语义的 resolver。任何"auto-approve all"语义的 resolver
 *   (如 `failToAllowResolver`)**不通过本路径暴露** —— 测试场景需要 auto-approve
 *   时直接构造 `new ConfirmationBroker({ nonInteractiveResolver: failToAllowResolver })`,
 *   该刻意的"显式构造"动作即是最好的 misuse 防御。
 *
 * 设计取舍:
 *   - 不在 broker 内嵌 "policy" 字段:broker 是底层基础设施,不该感知"子 agent 策略"语义
 *     (与"子 broker 也只是一个 ConfirmationBroker 实例,不需要新设计 ChildBroker 类"对齐)
 *
 * 签名设计契约:
 *   `policy` 参数**必填,无字面默认值**。default 由 `resolveSubAgentBudget`
 *   单一真相源(`DEFAULT_SUB_CONFIRMATION_POLICY` in `subagent/budget.ts`)统一提供,
 *   避免本函数与 budget.ts 各自维护字面 default 导致 silent 行为不一致 ——
 *   未来调整默认策略只改 `subagent/budget.ts` 一处。
 *
 * v2+ 引入 `inherit-or-prompt` 策略时,在 `SubAgentConfirmationPolicy` 字面量
 * 加新值,本函数补 case 分支即可(TypeScript exhaustive check 强制要求,不会漏)。
 */

import { failToDenyResolver, type NonInteractiveResolver } from "@zhixing/core";
import type { SubAgentConfirmationPolicy } from "../subagent/budget.js";

export function resolveSubAgentResolver(
  policy: SubAgentConfirmationPolicy,
): NonInteractiveResolver {
  switch (policy) {
    case "inherit-or-deny":
      return failToDenyResolver;
  }
}
