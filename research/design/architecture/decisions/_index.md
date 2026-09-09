# 架构决策记录索引 (ADR Index)

> 所有重要架构决策的索引，按时间顺序排列

## 决策清单

| # | 标题 | 状态 | 日期 | 关键依据 |
|---|------|------|------|---------|
| 001 | [仓库组织与包边界](../../../../docs/engineering/repository-structure.md) | 已迁移 | 2026-04-06 | 单仓多包取舍与当前工程边界 |
| 002 | [Provider 层架构](../../../../docs/modules/providers/architecture.md) | 接受 | 2026-04-07 | OpenClaw + Claude Code 源码分析 |
| 003 | [公开配置架构](../../../../docs/modules/configuration/architecture.md) | 已归并 | 2026-04-07 | 单一来源、路径、读写与用途投影；有效选型理由已承接 |
| 005 | [CLI 架构](005-cli-architecture.md) | 接受 | 2026-04-07 | OpenClaw + Claude Code CLI 架构深度对比 |
| 006 | [安全架构](../../../../docs/modules/security/architecture.md) | 已归并 | 2026-04-12 | 当前安全机制与信任正文已归位 |
| 007 | [消息 Outbox 与因果排序](../../../../docs/modules/delivery/outbox.md) | 接受 | 2026-04-21 | Slack / Claude Code / Temporal / Akka 多生产者顺序治理对照 |
| 008 | [秘密存储架构](../../../../docs/modules/secrets/architecture.md) · [首次引导](../../../../docs/modules/secrets/onboarding.md) | 已归并 | 2026-05-01 | 有效取舍已承接，旧存储方案已替换；现状与差异见正文 |
| 009 | [命令系统统一](../../../../docs/modules/cli/command-system.md) | 已归并 | 2026-06-03 | 有效决策与取舍已并入当前命令系统正文 |

## 使用说明

- 新建 ADR 时使用 [`_templates/adr.md`](../../../_templates/adr.md) 模板
- 文件命名格式：`NNN-short-title.md`（如 `001-tech-stack-selection.md`）
- 每个 ADR 必须引用支撑其决策的认知研究
- 废弃的 ADR 不删除，标记状态为"废弃"并注明被哪个新 ADR 取代
