# 知行文档 / Zhixing Documentation

本页只负责导航，不重复定义产品合同。面向使用者的快速开始以仓库根 README 为准；更深的架构和交付资料按其各自文档负责。

This page is an index only. Use the root README as the user quick-start authority; architecture and delivery documents retain their own scopes.

## 使用者 / Users

- [中文快速开始](../README.md)
- [English quick start](../README.en.md)
- [CLI 命令与 REPL 使用说明](../packages/cli/README.md)
- [安装、维护与发布指南](../research/design/modules/distributed-runtime/release-and-maintenance-guide.md)
- [架构概览](../research/design/architecture/overview.md)
- [0.1.0 发布说明 / Release notes](./delivery/releases/0.1.0.md)

## 贡献者 / Contributors

- [贡献指南 / Contributing guide](../CONTRIBUTING.md)
- [行为准则 / Code of Conduct](../CODE_OF_CONDUCT.md)
- [安全政策 / Security policy](../SECURITY.md)
- [缺陷与需求反馈 / Bug and feature requests](https://github.com/Tandem-Agents/zhixing/issues)
- [首个公开版本交付计划](./delivery/first-public-release.md)
- [验证手册](../research/design/workbench/verification-runbook.md)
- [路径解析与资源隔离](engineering/path-and-resource-isolation.md)
- [仓库组织与包边界](engineering/repository-structure.md)
- [状态、重放与合同一致性的工程经验](engineering/state-replay-contract-lessons.md)
- [架构演进记录索引](../research/design/architecture/evolutions/README.md)

疑似漏洞的当前支持与私密报告状态只以[安全政策 / Security policy](../SECURITY.md)为准；不要在公开渠道披露漏洞细节或敏感数据。

## 架构与研究 / Architecture and research

- [生命周期概念定义与规范](architecture/lifecycle-concepts.md)
- [运行体生命周期钩子](modules/conversation/runtime-lifecycle.md)
- [对话持久化与注意力窗口架构](modules/conversation/persistence.md)
- [上下文管理架构](modules/context/architecture.md)
- [逐轮上下文注入](modules/context/turn-context-injection.md)
- [会话任务列表](modules/conversation/task-list.md)
- [CLI 总体架构](modules/cli/architecture.md)
- [CLI 视觉设计语言](modules/cli/visual-language.md)
- [输入区视觉](modules/cli/input-visual.md)
- [CLI 屏幕渲染与能力边界](modules/cli/screen-rendering.md)
- [CLI Markdown 流式渲染](modules/cli/markdown-rendering.md)
- [输入补全架构](modules/cli/input-completion.md)
- [CLI 命令系统](modules/cli/command-system.md)
- [CLI 选择模块](modules/cli/selection.md)
- [CLI 文本粘贴](modules/cli/text-paste.md)
- [会话材料输入](modules/conversation/material-input.md)
- [CLI 材料输入](modules/cli/material-input.md)
- [CLI 代码编辑差异展示](modules/cli/edit-diff.md)
- [CLI 用量与上下文展示](modules/cli/usage-display.md)
- [grep 搜索架构](modules/tools/grep.md)
- [工具体系架构](modules/tools/architecture.md)
- [工具与权限集成](modules/tools/permission-integration.md)
- [安全架构与防护边界](modules/security/architecture.md)
- [信任、授权与管理](modules/security/trust.md)
- [秘密存储架构](modules/secrets/architecture.md)
- [首次引导与配置编辑](modules/secrets/onboarding.md)
- [公开配置架构](modules/configuration/architecture.md)
- [运行期配置应用](modules/configuration/runtime-application.md)
- [WebFetch 内容获取](modules/tools/web-fetch.md)
- [文件化编排架构](modules/orchestration/architecture.md)
- [子 Agent 执行架构](modules/subagents/architecture.md)
- [CLI 子任务展示](modules/cli/subagents.md)
- [中断执行架构](modules/interruption/architecture.md)
- [取消控制与反馈](modules/interruption/control-and-feedback.md)
- [确认交互架构](modules/confirmation/architecture.md)
- [确认接入与交互](modules/confirmation/surfaces.md)
- [多视角评议](modules/conversation/perspectives.md)
- [技能架构](modules/skills/architecture.md)
- [技能创作与接入](modules/skills/authoring-and-admission.md)
- [技能自主进化（未实现设计）](modules/skills/evolution.md)
- [SSP 采纳与集成边界](modules/skills/ssp-adoption.md)
- [工作场景架构](modules/workscene/architecture.md)
- [工作场景管理与智能创建](modules/workscene/management.md)
- [Provider 与模型调用架构](modules/providers/architecture.md)
- [模型元信息与预算解析](modules/providers/model-metadata.md)
- [模型角色与推荐](modules/providers/model-roles.md)
- [Anthropic Messages 适配](modules/providers/anthropic-adapter.md)
- [模型思考控制](modules/providers/thinking-control.md)
- [容错与模型调用恢复](modules/resilience/architecture.md)
- [轻量工具循环](modules/tools/lightweight-tool-loop.md)
- [MCP Host 架构](modules/mcp/architecture.md)
- [MCP 接入与管理](modules/mcp/onboarding-and-management.md)
- [网络出口架构](modules/network/architecture.md)
- [消息 Outbox 与因果排序](modules/delivery/outbox.md)
- [飞书通道架构与能力边界](modules/feishu/architecture.md)
- [IM 通道接入选型研究](research/channel-platforms.md)
- [架构概览 / Architecture overview](../research/design/architecture/overview.md)
- [架构演进 / Architecture evolutions](../research/design/architecture/evolutions/README.md)

研究和历史演进文档用于解释背景与决策，不替代当前 README、CLI 说明或维护指南中的可执行用户合同。

Research and historical evolution documents explain context and decisions; they do not replace the executable user contract in the current README, CLI guide, or maintenance guide.

经验检索：[失败复盘与可复用教训](postmortems/README.md)，按问题信号查找诊断、决策与效率经验。

事件调查：[提示注入诱导凭证外发](incidents/2026-06-30-prompt-injection-credential-exfil-incident.md)，记录经过、证据与未决来源。

## 许可 / License

[MIT License](../LICENSE)

## 文档迁移过渡状态

当前文档体系由 `docs/` 与旧 `research/` 共同支撑：`docs/` 承载新建及已按现状校准归位的文档；`research/` 尚有有效设计，也混有过时内容，不能因目录位置一概采信或判废。同一职责已迁移的，以新正文为准；未迁移的仍须结合有效需求与当前实现判断。

迁移正按单元经用户审核逐步进行，可随时暂停以处理其他工作，不作为其他事项的前置条件。恢复时先读取[迁移任务文档](tasks/research-documentation-cleanup.md)中的规则、处理记录与待处理检查点，再核对实际文件及最近审核结果，从未完成项继续；进度只在任务文档维护，本段仅说明临时状态。
