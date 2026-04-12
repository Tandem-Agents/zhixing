# 源码解析 (Source Analysis)

> 对 OpenClaw、Claude Code 等系统的深度源码分析，作为认知研究的事实基础

## 分析目标

本模块不是逐行注释源码，而是提取架构级别的洞察：

- **整体架构** — 系统由哪些组件构成？如何协作？
- **模块边界** — 模块间的依赖关系和通信方式
- **核心数据流** — 关键场景下数据如何流转
- **设计模式** — 使用了哪些值得借鉴的设计模式

## 分析索引

### OpenClaw

| 文档 | 内容 | 状态 |
|------|------|------|
| [架构概述](./openclaw/architecture-overview.md) | 整体架构鸟瞰图 | 🔲 待分析 |
| [模块地图](./openclaw/module-map.md) | 模块依赖关系 | 🔲 待分析 |
| [数据流分析](./openclaw/data-flow.md) | 核心场景的数据流转 | 🔲 待分析 |
| [设计模式](./openclaw/key-patterns.md) | 关键设计模式提取 | 🔲 待分析 |
| [安全系统](./openclaw/security-system.md) | 沙箱隔离 + 执行审批 + 工具策略 + 安全审计 | ✅ 已完成 |

### Claude Code

| 文档 | 内容 | 状态 |
|------|------|------|
| [架构概述](./claude-code/architecture-overview.md) | 基于公开分析的架构还原 | 🔲 待分析 |
| [设计模式](./claude-code/key-patterns.md) | 关键设计模式提取 | 🔲 待分析 |
| [安全系统](./claude-code/security-system.md) | 8 层纵深防御 + OS 级沙箱 + Auto 分类器 + Bash AST 安全 | ✅ 已完成 |

### Hermes Agent

> **仓库**: https://github.com/NousResearch/hermes-agent | **本地**: `E:\Dev\longxia\hermes-agent-main` | **文档**: https://hermes-agent.nousresearch.com/docs/ | **协议**: MIT

Nous Research 开发的自主进化型开源智能体，核心差异化在于 Skills 自主创建/迭代、分层记忆系统和 15 平台消息网关。Python 技术栈，48K+ Stars。
与 OpenClaw 同为独立部署型智能体，但架构理念和扩展机制存在显著差异，对知行的记忆系统、技能进化、多平台架构设计有重要参考价值。

| 文档 | 内容 | 状态 |
|------|------|------|
| 架构概述 | 整体架构鸟瞰图（三层入口 + AIAgent 核心 + 多后端） | 🔲 待分析 |
| Agent 循环 | 核心对话循环（run_agent.py ~9,200 行） | 🔲 待分析 |
| Skills 系统 | 自主创建/迭代/进化的技能系统（核心差异化） | 🔲 待分析 |
| 记忆系统 | 分层记忆架构（MEMORY.md + SQLite + FTS5 + 用户建模） | 🔲 待分析 |
| 消息网关 | 15 平台统一网关架构（gateway/run.py ~7,500 行） | 🔲 待分析 |
| 上下文压缩 | 上下文压缩 + Anthropic 前缀缓存策略 | 🔲 待分析 |
| 设计模式 | 关键设计模式提取（与 OpenClaw/Claude Code 交叉对比） | 🔲 待分析 |
| [安全系统](./hermes-agent/security-system.md) | Tirith 扫描 + 审批机制 + 文件/网络安全 + 代码执行沙箱 | ✅ 已完成 |

## 分析规范

- 使用 [`_templates/source-analysis.md`](../_templates/source-analysis.md) 模板
- OpenClaw 分析必须引用具体的源码文件路径
- Claude Code 分析必须标注信息来源的可信度
- 架构图使用 Mermaid 语法，便于维护和版本管理
