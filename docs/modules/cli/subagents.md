# CLI 子任务展示

用户需要知道委派是否推进、哪些失败及总体成本，不需要阅读完整子推理或每次内部工具输出。成功项聚合，失败／中止明确可见；主答案仍应披露未取得的结果。执行、提交和生命周期见[子 Agent 架构](../subagents/architecture.md)。

## 当前责任链

新终端协商 bounded-v1 展示能力，经既有会话流接收有限子任务进度和 subagent artifact。默认 observer、模型结果及持久 transcript 不因此接收展示 payload。能力未接纳时应显示限制，不能把本地格式化成功当作协商成功。

N 的 TerminalProcessProjection 按 conversation、run、父 toolCallId 和 child 身份归并状态，U 只呈现有限过程 DTO。子运行结束不结束父运行；迟到事件不能串到新的父工具或会话。活跃子任务保留标签、状态、时长和工具摘要，终态合并已有结构化用量及必要诊断，不投递完整子输出。

旧 StatusBar、Task registry 展示壳、subtasks/presentation 和手写 scrollback 已退役；现在的状态与正文都由同一 U 根绘制。领域事实仍来自事件与结果，CLI 投影不是第二个执行状态机。

## 呈现合同

状态、数量与可定位身份优先于可省略描述；失败和中止不能被右侧裁剪吞掉。活动过程保持有限占用，结果作为正文块保留；页面回看、resize 和返回遵循[屏幕渲染](screen-rendering.md)，不得清掉历史来伪造适配。

批次完成应给出可理解的总计，成功项避免逐条刷屏；失败／中止保留短身份和诊断。子用量不能改变主阶段或主上下文水位，不将缺值当零。此前单行子任务详情和批次告警的用户信息义务仍须迁移核对，不能用新块类型存在证明全部旧反馈已闭合。

artifact 用于即时显示，不进入模型历史；运行层解析的结构化用量用于查询，CLI 不从私有 trailer 文本重新猜测统计。[用量展示](usage-display.md)统一描述 /usage 的拆分和成本边界。

## 接入与验证边界

交互终端的增强投影可承接子任务展示；默认 RPC 仍保持剥离，不应再把“默认投影不含 artifact”推断为新终端不可达。文本入口使用自己的追加式投影，不获取 U 或旧状态栏。非流式渠道不据此承诺展示子内部过程，失败披露仍是产品要求。

实现入口：[过程投影](../../../packages/cli/src/terminal/process-projection.ts)、[过程格式](../../../packages/cli/src/terminal/process-presentation.ts)、[展示输出](../../../packages/cli/src/terminal/output.ts)、[U 根](../../../packages/terminal-ui/src/root.tsx)、[RPC 流](../../../packages/rpc/src/session-turn-stream.ts)、[事件投影](../../../packages/rpc/src/session-events.ts)。

验证真实 RPC 增强／默认隔离、父子关联、迟到与重复终态、混合工具批次、未知用量、失败诊断、窄屏和文本降级；本地 EventBus 或格式化快照不能代替生产消费链。
