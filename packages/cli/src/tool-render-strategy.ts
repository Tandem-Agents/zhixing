/**
 * 工具在 cli 端的渲染策略表 —— cli 包内"哪个工具由谁渲染"的单一事实源。
 *
 * 背景:
 *   tool-executor 对每个工具调用同时产生两路输出 ——
 *     - yield tool_start/tool_end → onYield → renderer.handleEvent → 主路径单行 ⟡ 卡片
 *     - emit tool:call_start/end  → EventBus listener → 专用订阅器(如状态条)
 *   多数工具(read/write/bash/grep 等)只走主路径 ⟡ 卡片即可;少数工具
 *   (如 Task)需要展开"父任务 + 子 agent 多步进度"的层次状态,由专用订阅器
 *   接管 —— 此时主路径若仍输出 ⟡ 卡片,会与状态条形成双重渲染视觉混乱。
 *
 * 设计:
 *   - 单一事实源:renderer.handleEvent 跳过哪些工具,与 setupSubAgentStatus
 *     接管哪些工具,共享同一映射表,任何加表 / 改表两侧逻辑自动一致,
 *     不存在两侧策略漂移的可能。
 *   - 关注点正确归属:呈现策略归 cli 包 —— 同一工具在不同环境(REPL /
 *     serve daemon / RPC client)可能有不同呈现需求,工具元信息只描述
 *     "能力 / 边界 / 安全",不应承担"如何渲染"的职责。
 *   - 可扩展:新增策略只需在 ToolRenderStrategy 加 variant + 表项,
 *     消费方按 strategy 派发,无需触动其他逻辑。
 */

/**
 * 工具呈现策略枚举。
 *
 * - `default`:           主路径 renderer.handleEvent 渲染单行 ⟡ 卡片
 *                        (read / write / bash / grep / glob 等多数工具)
 * - `sub-agent-status`:  主路径不渲染,setupSubAgentStatus 接管层次化状态条
 *                        (Task 工具:展开父任务 + 子 agent 工具进度)
 */
export type ToolRenderStrategy = "default" | "sub-agent-status";

/**
 * 工具名 → 渲染策略 的注册表。未在表中的工具按 default 策略渲染。
 *
 * 双层不变量(编译期 + 运行期):
 *   - 编译期:`Readonly<Record>` 类型禁止赋值/删除字段
 *   - 运行期:`Object.freeze` 让任何 mutate 在 strict mode 下抛 TypeError
 *
 * 为什么强制 freeze:本表是"哪个工具走非默认渲染"的全局事实源,
 * 任何运行期 mutate 都会破坏 `renderer.handleEvent` 与 `setupSubAgentStatus`
 * 的双侧渲染契约,引入双重渲染回归。Readonly 类型只能拦编译期失误,
 * freeze 是对运行期(动态属性写入 / Object.assign / Reflect.set 等)的兜底防御。
 */
export const TOOL_RENDER_STRATEGY: Readonly<Record<string, ToolRenderStrategy>> =
  Object.freeze({
    Task: "sub-agent-status",
  } as const);

/**
 * 查询工具的渲染策略,未注册返回 default。
 *
 * 这是消费方应使用的唯一查询入口 —— 不要直接读 TOOL_RENDER_STRATEGY 表
 * (会丢兜底 default 语义,且让"未注册即 default"的契约重复散落在多处)。
 */
export function getToolRenderStrategy(toolName: string): ToolRenderStrategy {
  return TOOL_RENDER_STRATEGY[toolName] ?? "default";
}
