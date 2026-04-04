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

### Claude Code

| 文档 | 内容 | 状态 |
|------|------|------|
| [架构概述](./claude-code/architecture-overview.md) | 基于公开分析的架构还原 | 🔲 待分析 |
| [设计模式](./claude-code/key-patterns.md) | 关键设计模式提取 | 🔲 待分析 |

## 分析规范

- 使用 [`_templates/source-analysis.md`](../_templates/source-analysis.md) 模板
- OpenClaw 分析必须引用具体的源码文件路径
- Claude Code 分析必须标注信息来源的可信度
- 架构图使用 Mermaid 语法，便于维护和版本管理
