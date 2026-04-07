# 架构决策记录索引 (ADR Index)

> 所有重要架构决策的索引，按时间顺序排列

## 决策清单

| # | 标题 | 状态 | 日期 | 关键依据 |
|---|------|------|------|---------|
| 001 | [Monorepo 项目结构](001-monorepo-structure.md) | 接受 | 2026-04-06 | OpenClaw 实践 + 业界标准 |
| 002 | [Provider 层架构](002-provider-architecture.md) | 接受 | 2026-04-07 | OpenClaw + Claude Code 源码分析 |
| 003 | [配置系统](003-config-system.md) | 接受 | 2026-04-07 | OpenClaw + Claude Code 配置系统对比分析 |
| 004 | [工具系统架构](004-tool-system-architecture.md) | 接受 | 2026-04-07 | OpenClaw + Claude Code 工具系统深度分析 |
| 005 | [CLI 架构](005-cli-architecture.md) | 接受 | 2026-04-07 | OpenClaw + Claude Code CLI 架构深度对比 |

## 使用说明

- 新建 ADR 时使用 [`_templates/adr.md`](../../../_templates/adr.md) 模板
- 文件命名格式：`NNN-short-title.md`（如 `001-tech-stack-selection.md`）
- 每个 ADR 必须引用支撑其决策的认知研究
- 废弃的 ADR 不删除，标记状态为"废弃"并注明被哪个新 ADR 取代
