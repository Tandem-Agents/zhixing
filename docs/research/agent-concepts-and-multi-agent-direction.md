# 多智能体机制梳理

现状核对：2026-09-16。

## 多智能体机制

| 概念 | 核心职责与边界 | 依据 |
|---|---|---|
| SubAgent / Task | 隔离上下文的短期委派；当前只读，不支持递归或独立恢复。 | [文档](../modules/subagents/architecture.md) · [实现](../../packages/orchestrator/src/tools/task.ts) |
| 文件化编排 | 用有限 DAG 按依赖组织 Agent 节点，控制并行与预算；内部基础设施。 | [文档](../modules/orchestration/architecture.md) · [实现](../../packages/orchestrator/src/orchestration/runner.ts) |
| 多视角评议 | 多视角独立分析 → 交叉吸收 → 统一结论；当前不使用工具。 | [文档](../modules/conversation/perspectives.md) · [实现](../../packages/core/src/conversation/perspectives-application.ts) |
| 任务推进闭环 | 执行侧做事，独立推进侧按已确认 Rubric 验收、续推或结束。 | [文档](../../research/design/drafts/task-advancement-rubric-architecture.md) · [实现](../../packages/orchestrator/src/advancement/runtime.ts) |

## 实现关系

- **Task 与编排节点共用子执行**；多视角评议建立在编排之上，不是三套独立底座。
- **推进侧使用独立评审链**，不通过 Task 或编排执行验收。

## 相关能力：跨会话委托

目标会话承接任务并回传结果，包括隔离的 Anchor 能力接入委托。这是跨会话协作，不等同于 SubAgent；工作场景本身不属于多智能体机制。[文档](../modules/mcp/onboarding-and-management.md) · [实现](../../packages/core/src/workscene/continuation.ts)

## 方向思考：让对话能够协作

启发来自 Codex 的跨对话协作体验：**不必先设计固定的“多智能体团队”，而是提供对话之间读取、发送消息和发起任务等基础能力，让用户自由组织协作。** 各对话保有自身上下文，通过沟通形成分工、审查或其他协作关系；在授权范围内，协作方式由用户与任务需要决定，而非由产品预设的角色和流程限定。重点是基础能力的可组合性，而不是预设更多多智能体功能。

能力依据：[Codex 跨会话协作能力调研](codex-cross-thread-collaboration.md)。

产品与目标架构：[对话间通信](../modules/conversation/collaboration.md)。
