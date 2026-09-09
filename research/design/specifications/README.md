# 功能规格 (Specifications)

> 具体功能模块的实现规格说明，连接架构设计与代码实现

## 状态：进行中

## 规格索引

| # | 功能模块 | 文档 | 状态 |
|---|---------|------|------|
| 001 | Anthropic Messages 适配器 | [当前正文](../../../docs/modules/providers/anthropic-adapter.md) | 已迁移 |
| 002 | Provider 与模型调用架构 | [当前正文](../../../docs/modules/providers/architecture.md) | 已归并 |
| 005 | 安全系统 | [安全架构](../../../docs/modules/security/architecture.md) · [信任与管理](../../../docs/modules/security/trust.md) | 已归位 |
| 006 | 安全确认交互 | [架构](../../../docs/modules/confirmation/architecture.md) · [接入与交互](../../../docs/modules/confirmation/surfaces.md) | 已迁移 |
| 007 | 输入补全与命令系统 | [输入补全](../../../docs/modules/cli/input-completion.md) · [命令系统](../../../docs/modules/cli/command-system.md) | 已迁移 |
| 008 | Server Gateway | [server-gateway.md](server-gateway.md) | 待审阅 |
| 009 | 对话模型（Conversation / SessionRuntime / Transcript） | [conversation-model.md](conversation-model.md) | 设计中 |
| 010 | 上下文管理架构 | [现行文档](../../../docs/modules/context/architecture.md) | 已迁移 |
| 011 | 网络出口原语（@zhixing/network） | [网络出口架构](../../../docs/modules/network/architecture.md) | 已归位 |
| 014 | 子 Agent 执行与展示 | [执行架构](../../../docs/modules/subagents/architecture.md) · [CLI 展示](../../../docs/modules/cli/subagents.md) | 已归位 |
| 015 | 用户秘密存储与首次引导 | [秘密存储](../../../docs/modules/secrets/architecture.md) · [首次引导](../../../docs/modules/secrets/onboarding.md) | 已迁移，现状与差异见正文 |
| 016 | 运行期配置应用 | [宿主换代、恢复与失败边界](../../../docs/modules/configuration/runtime-application.md) | 已迁移，现状与差异见正文 |
| 017 | CLI 视觉设计语言 | [视觉语言](../../../docs/modules/cli/visual-language.md) | 已迁移 |
| 018 | 输入区视觉规范 | [输入区视觉](../../../docs/modules/cli/input-visual.md) | 已迁移 |
| 019 | 轻量工具循环（程序发起、工具调度与场景校验） | [当前正文](../../../docs/modules/tools/lightweight-tool-loop.md) | 已迁移 |
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
