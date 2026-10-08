# CLI 用量与上下文展示

本文负责用量信息在 CLI 中的含义、展示层次与数据交界；上下文管理算法由[上下文架构](../context/architecture.md)负责，模型预算解析和子 Agent 执行不在此重复定义。

## 产品意图

知行是助手，不是仪表盘。默认反馈工作是否在推进及何时结束，容量和消耗详情按需查看；信息用于理解状态和作出选择，不为展示而展示。自动上下文整理由系统负责，不能把正确运行的责任交给用户手动监控百分比。

反馈优先级是：是否仍在响应 → 上下文剩余容量 → 有可靠计价依据时的费用。默认少打扰，需要时提供参照与详情：同样的 token 数在不同容量窗口中意义不同，孤立数字不能表达容量压力。费用透明仍有价值，但 token 数、容量估算和实际费用不能互相冒充。

## 三类数据必须区分

| 数据 | 当前含义与来源 |
|---|---|
| 请求容量估算 | `context:tokens_snapshot.totalTokens` 表达下次请求的估算输入量，覆盖 system、实际消息及 tools；不是本轮累计流量 |
| API 消耗 | `llm:request_end.usage` 提供单次请求报告的用量；N 的过程投影按已结束请求累加；不能把容量估算混入实耗 |
| 缓存命中 | 过程投影保留主请求的 `cacheReadTokens`；不是当前估算快照中保证可命中的部分，也不是费用节省金额 |

容量占比以 `ContextBudget.currentTokens / effectiveWindow` 计算，有效容量扣除了受上限约束的输出预留，不等于模型标称窗口。缺值与零值须区分；未拿到统计不能展示为“零消耗”。费用还依赖计价与计费口径，不能仅由缓存 token 或容量下降推导。

## 当前过程投影与信息行

N 的 [TerminalProcessProjection](../../../packages/cli/src/terminal/process-projection.ts)消费主运行事件，分别维护请求用量、上下文估算、缓存和过程提示；U 的共同根显示过程 DTO，不装配旧 StatusBar 或 ContextIndicator。run 开始清理上一运行状态，请求结束使用供应方报告的 usage，输入量按 getTotalInputTokens 统一口径。

上下文快照与 API 消耗必须分开。缺失值显示未知或不显示，不能借保留旧值冒充新运行统计。事件投影按运行和 lineage 关联，子调用用量不替换主上下文水位。旧指示器的 dispose 残留和静态尾段布局不再是当前生命周期。

## 按需查询

`/usage` 与 `/context` 经 TerminalInformationCommands 调用 ConversationController，再通过会话 RPC 与领域应用取得宿主投影；CLI 只渲染结果，不自建计量事实或解析工具文本作为权威统计。宿主适配调用 owner 的 existing 查询；查询失败显示“用量信息不可用”或“上下文信息不可用”，不伪造空账单。

- **`/usage`**：展示容量占比及当前量／有效容量、标称窗口、会话轮次和可用的估算校准系数；有结构化子任务用量时追加状态、token、工具调用、耗时、短标识及总计，分隔线适配终端宽度。主区当前不是本轮／会话累计输入输出账单，子任务合计也不能宣称是全会话总成本。
- **`/context`**：展示有效容量、占比条与阈值标尺。当前没有按系统提示、历史、工具结果分解的构成分析。渲染器固定标尺为 75%／85%／95%，警示时提供 `/compact` 提示；这些是展示口径，不能据此宣称自动压缩必在 85% 发生。当前自动切段由模型注意力阈值与 SegmentManager 裁决，见上下文架构。

子任务用量以查询返回的结构化 `subUsages` 为输入，不恢复旧的 CLI 从 `<usage>` trailer 猜测统计的路径。子任务记录的生成、归属和生命周期仍由子 Agent 与会话责任链承担。

## 上下文整理反馈

自动段切换通过事件显示开始、完成或失败：开始提示正在整理与当前 token 量，完成显示前后量及下降百分比；这只是容量变化，不是账单节省。失败不能同时显示成功；应急地板成功前先说明机械截断及其代价，不能冒充正常摘要。手动 `/compact` 走命令反馈，不能假定所有压缩入口都由同一条 UI 事件呈现。

## 设计与实现差异

用量查询需要按本轮与累计清晰归属输入／输出及缓存用量、按需解释上下文构成，并在计价依据可靠时提供费用明细。这些目标尚未完整落地：当前 `/usage` 主区不是累计账单，`/context` 没有构成分析，费用查询 `/cost` 未实现；不能把示例金额或“缓存节省”当作真实结果。

当前没有 `display.turnSummary`、`contextShowThreshold`、`showCost` 配置项，也不提供可编程状态行接口。

## 实现与核对入口

- [命令与错误反馈](../../../packages/cli/src/terminal/information-commands.ts)、[会话控制](../../../packages/cli/src/runtime/conversation-controller.ts)、[RPC](../../../packages/server/src/rpc/methods/session.ts)、[宿主查询适配](../../../packages/cli/src/serve/conversation-usage-application.ts)。
- [应用装配](../../../packages/cli/src/terminal/application.ts)、[过程投影](../../../packages/cli/src/terminal/process-projection.ts)、[查询格式](../../../packages/cli/src/terminal/information-presentation.ts)、[预算口径](../../../packages/core/src/context/budget.ts)。

直接核对估算与实耗分离、多请求累加与结算、主子 lineage 隔离、cache 缺值与更新、跨 run 显示生命周期、查询失败不伪造结果、子任务拆分及窄屏可读性、整理成功／失败／降级互不冒充。对应命令、过程投影、信息格式与宿主查询测试提供局部证据。
