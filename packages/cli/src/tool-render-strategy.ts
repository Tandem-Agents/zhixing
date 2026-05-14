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
 * - `default`:           探索类工具(read / glob / grep / bash / web_fetch 等)。
 *                        走 ToolBatchCoordinator 折叠为「⟡ 已使用 N 个工具」批次摘要。
 *                        探索是 AI「思考过程」,批量折叠为次级视觉。
 * - `side-effect`:       副作用类工具(write / edit / schedule)——改变持久状态。
 *                        **永不折叠**,独立成行 ✎ 锚展示,让用户随时知道「AI 改了
 *                        我什么」。
 *
 *                        **二义性工具排除**(按 input.action 决定读/写性质的工具
 *                        统一归 default,避免静态 strategy 错误归类把"AI 在查"
 *                        与"AI 在改"混在一起):
 *                          - bash:    `ls` 读 vs `npm install` 写
 *                          - memory:  `search / list` 读 vs `save / update / delete` 写
 *                                     (实测 LLM 高频 list / search,把 memory 整体
 *                                     归 side-effect 会让真正 save 的视觉信号被
 *                                     5 倍 list/search 的 ✎ 行稀释,违反"副作用必须
 *                                     可见"产品原则)
 *                          - web_fetch: stateless 网络请求归探索,非副作用
 * - `sub-agent-status`:  主路径不渲染,status-bar 接管层次化状态条(Task 工具)。
 *
 * 设计意图——LLM 行为相位「探索→决策→行动→验证」与渲染锚的语义映射:
 *   - ◆ AI 决策/答案(text_delta)
 *   - ⟡ 探索批次(default → batch coordinator)
 *   - ✎ 副作用(side-effect → 单行突出)
 *   - ◆ 红色 失败破窗(任意策略的 isError tool_end)
 * 用户扫一眼 scrollback 即可重构 AI 工作流,这是知行 agent UX 的产品基石。
 */
export type ToolRenderStrategy =
  | "default"
  | "side-effect"
  | "sub-agent-status";

/**
 * 工具名 → 渲染策略 的注册表。未在表中的工具按 default 策略渲染。
 *
 * 双层不变量(编译期 + 运行期):
 *   - 编译期:`Readonly<Record>` 类型禁止赋值/删除字段
 *   - 运行期:`Object.freeze` 让任何 mutate 在 strict mode 下抛 TypeError
 *
 * 为什么强制 freeze:本表是「哪个工具走非默认渲染」的全局事实源,任何运行期 mutate
 * 都会破坏多侧消费方(renderer.handleEvent / batch coordinator / status-bar)的渲染
 * 契约,引入双重渲染回归。Readonly 类型只能拦编译期失误,freeze 是对运行期
 * (动态属性写入 / Object.assign / Reflect.set 等)的兜底防御。
 *
 * **副作用白名单维护准则**:
 *   - 只加「100% 改变持久状态」的工具(write/edit/schedule 是清晰副作用)
 *   - 不加二义性工具(bash 命令既能 ls 也能 npm install,静态分类必错)
 *   - 不加 stateless 工具(web_fetch 网络请求归探索,非副作用)
 *   - 加表需同步更新本文件 byte-equal 锚点断言 + 文档,强迫意识到"产品决策"
 */
export const TOOL_RENDER_STRATEGY: Readonly<Record<string, ToolRenderStrategy>> =
  Object.freeze({
    Task: "sub-agent-status",
    write: "side-effect",
    edit: "side-effect",
    schedule: "side-effect",
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
