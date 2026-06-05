# 功能规格 (Specifications)

> 具体功能模块的实现规格说明，连接架构设计与代码实现

## 状态：进行中

## 规格索引

| # | 功能模块 | 文档 | 状态 |
|---|---------|------|------|
| 001 | Anthropic Messages 适配器 | [anthropic-adapter.md](anthropic-adapter.md) | 待审阅 |
| 002 | Provider 层演进路线 | [provider-layer-evolution.md](provider-layer-evolution.md) | 待审阅 |
| 003 | 记忆系统 | [memory-system.md](memory-system.md) | 待审阅 |
| 004 | 智能体运行时（常驻服务 + 智能协调） | [persistent-service.md](persistent-service.md) | 待审阅 |
| 005 | 安全系统 | [security-system.md](security-system.md) | 待审阅 |
| 006 | 安全确认交互 | [confirmation-ux.md](confirmation-ux.md) | 待审阅 |
| 007 | 输入补全 | [input-typeahead.md](input-typeahead.md) | 待审阅 |
| 008 | Server Gateway | [server-gateway.md](server-gateway.md) | 待审阅 |
| 009 | 对话模型（Conversation / SessionRuntime / Transcript） | [conversation-model.md](conversation-model.md) | 设计中 |
| 010 | 上下文架构（v1.2 已废弃；新单一来源见 context-management-v3-redesign.md） | [context-architecture.md](context-architecture.md) | ⚠️ 已废弃 |
| 011 | 网络出口原语（@zhixing/network） | [network-egress.md](network-egress.md) | 已实施 |
| 012 | 内置工具集（@zhixing/tools-builtin） | [tools-builtin.md](tools-builtin.md) | 已实施 |
| 013 | 可中断 Agent Loop（中断协议 + idle 看门狗 + 协议清理） | [interruptible-agent-loop-execution.md](interruptible-agent-loop-execution.md) | 设计中 |
| 014 | 子 Agent 体系（Task 工具 + AgentRoleProfile + ChildBroker + hierarchical EventBus） | [subagent-execution.md](subagent-execution.md) | 设计中 |
| 015 | 用户凭证存储与首次引导（credentials.json + 加载链 + builtin 规则隔离 + 程序级向导） | [credentials-and-onboarding.md](credentials-and-onboarding.md) | 设计中 |
| 016 | RuntimeSession 与配置热重载（REPL 内 `/config` + blue-green swap + 协同生命周期聚合） | [runtime-session-hot-reload.md](runtime-session-hot-reload.md) | 设计中 |
| 017 | CLI 视觉设计语言（七条核心原则 + 视觉元素规范，覆盖配置编辑器 + REPL + 未来 TUI） | [cli-ui-design-language.md](cli-ui-design-language.md) | 设计中 |
| 018 | 输入区视觉规范（box chrome + 多行扩展 + typeahead 选中行点阵纹理同源） | [input-zone-visual.md](input-zone-visual.md) | 设计中 |
| 019 | 轻量工具循环（来源无关原语：代码发起 + 注入工具集 + 多轮 LLM 决策，事实焊死/判断信任） | [lightweight-tool-loop.md](lightweight-tool-loop.md) | 设计中 |
| 020 | MCP Host（船坞）（连接层 + 映射层 + 事实驱动接入 + 搜索引导） | [mcp-host.md](mcp-host.md) | 部分实施 |
| 021 | 主对话运行体生命周期钩子（实例建立/run 前/run 后/实例销毁 四阶段 + cache 安全 system prompt 重建 + skill 索引边界重建） | [agent-runtime-lifecycle.md](agent-runtime-lifecycle.md) | 设计中 |

## 编写规范

- 每个规格文档应明确：输入、输出、核心流程、边界条件、性能要求
- 必须引用相关的 ADR 和认知研究
- 粒度适中：一个规格覆盖一个可独立实现和验证的功能单元
