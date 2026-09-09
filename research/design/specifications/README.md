# 功能规格 (Specifications)

> 具体功能模块的实现规格说明，连接架构设计与代码实现

## 状态：进行中

## 规格索引

| # | 功能模块 | 文档 | 状态 |
|---|---------|------|------|
| 001 | Anthropic Messages 适配器 | [anthropic-adapter.md](anthropic-adapter.md) | 待审阅 |
| 002 | Provider 层演进路线 | [provider-layer-evolution.md](provider-layer-evolution.md) | 待审阅 |
| 005 | 安全系统 | [security-system.md](security-system.md) | 待审阅 |
| 006 | 安全确认交互 | [confirmation-ux.md](confirmation-ux.md) | 待审阅 |
| 007 | 输入补全与命令系统 | [输入补全](../../../docs/modules/cli/input-completion.md) · [命令系统](../../../docs/modules/cli/command-system.md) | 已迁移 |
| 008 | Server Gateway | [server-gateway.md](server-gateway.md) | 待审阅 |
| 009 | 对话模型（Conversation / SessionRuntime / Transcript） | [conversation-model.md](conversation-model.md) | 设计中 |
| 010 | 上下文管理架构 | [现行文档](../../../docs/modules/context/architecture.md) | 已迁移 |
| 011 | 网络出口原语（@zhixing/network） | [network-egress.md](network-egress.md) | 已实施 |
| 012 | 内置工具集（@zhixing/tools-builtin） | [tools-builtin.md](tools-builtin.md) | 已实施 |
| 013 | 可中断 Agent Loop（中断协议 + idle 看门狗 + 协议清理） | [interruptible-agent-loop-execution.md](interruptible-agent-loop-execution.md) | 设计中 |
| 014 | 子 Agent 体系（Task 工具 + AgentRoleProfile + ChildBroker + hierarchical EventBus） | [subagent-execution.md](subagent-execution.md) | 设计中 |
| 015 | 用户秘密存储与首次引导（SecretStore + 旧明文迁移 + ready 状态 + 程序级向导） | [credentials-and-onboarding.md](credentials-and-onboarding.md) | 已实施 |
| 016 | RuntimeSession 与配置热重载（REPL 内 `/config` + blue-green swap + 协同生命周期聚合） | [runtime-session-hot-reload.md](runtime-session-hot-reload.md) | 设计中 |
| 017 | CLI 视觉设计语言 | [视觉语言](../../../docs/modules/cli/visual-language.md) | 已迁移 |
| 018 | 输入区视觉规范 | [输入区视觉](../../../docs/modules/cli/input-visual.md) | 已迁移 |
| 019 | 轻量工具循环（来源无关原语：代码发起 + 注入工具集 + 多轮 LLM 决策，事实焊死/判断信任） | [lightweight-tool-loop.md](lightweight-tool-loop.md) | 设计中 |
| 020 | MCP Host（船坞）（连接层 + 映射层 + 事实驱动接入 + 搜索引导） | [mcp-host.md](mcp-host.md) | 部分实施 |
| 021 | 运行体生命周期钩子 | [运行体生命周期钩子](../../../docs/modules/conversation/runtime-lifecycle.md) | 已迁移 |

## 历史资料

以下文档只作历史追溯，不作为当前规格依据：

| 主题 | 文档 | 说明 |
|---|---|---|
| 早期常驻服务 / 调度 / 投递 / Memory maintenance 方案 | [persistent-service.md](persistent-service.md) | `HISTORICAL`；现行生产合同以 distributed-runtime 执行规格及对应模块现行文档为准 |
| 早期 prompt / `ZHIXING.md` 方案 | [archive/prompt-system.md](archive/prompt-system.md) | 当前 system prompt 以 `packages/orchestrator/src/runtime/system-prompt.ts`、[运行体生命周期钩子](../../../docs/modules/conversation/runtime-lifecycle.md) 与 [上下文管理架构](../../../docs/modules/context/architecture.md) 为准；当前 `ZHIXING.md` guidance 机制见 [ZHIXING.md 分层 guidance 架构](../drafts/zhixing-md-layered-context-architecture.md) |

## 编写规范

- 每个规格文档应明确：输入、输出、核心流程、边界条件、性能要求
- 必须引用相关的 ADR 和认知研究
- 粒度适中：一个规格覆盖一个可独立实现和验证的功能单元
