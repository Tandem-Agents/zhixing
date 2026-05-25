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
| [架构概述](./openclaw/architecture-overview.md) | 架构与方案设计总览（**v2026.5.25**：薄核+厚编排+可插拔 harness；三层回退；网关 ws+node:http 非 express/hono；pi-* 依赖改 scope `@earendil-works`，Google transport 转 provider 插件） | ✅ 已重核 2026-05-25 (2026.5.25) |
| [Skill 系统](./openclaw/skill-system.md) | 技能子系统深读（`SKILL.md` 六来源聚合 + 仅索引进 system + read 工具渐进披露 + session 快照缓存 + 安装期扫描；**无自主进化**） | ✅ 已完成 2026-05-25 |
| [模块地图](./openclaw/module-map.md) | 模块依赖关系 | 🔲 待分析 |
| [数据流分析](./openclaw/data-flow.md) | 核心场景的数据流转 | 🔲 待分析 |
| [设计模式](./openclaw/key-patterns.md) | 关键设计模式提取 | 🔲 待分析 |
| [安全系统](./openclaw/security-system.md) | 沙箱隔离 + 执行审批 + 工具策略 + 安全审计 | ✅ 已完成 |
| [常驻服务](./openclaw/persistent-service.md) | Gateway + Daemon + Cron + Heartbeat + Channel Plugin + WebSocket RPC | ✅ 已完成 |
| [MCP 架构](./openclaw/mcp-architecture.md) | 三子系统（embedded Pi 作 client / CLI-runner 注入下游 CLI / 作 server）+ `<server>__<tool>` 命名 + 危险 env 过滤 | ✅ 已完成 |

### Claude Code

| 文档 | 内容 | 状态 |
|------|------|------|
| [架构概述](./claude-code/architecture-overview.md) | 架构与方案设计总览（**已从社区转述升级为本地三件套实证**：deobf 实为早期 CLI v0.1.0/claude-3-opus，旧文「query()/4层压缩/14步管线/Bash AST/五层 settings」本地均无法证实；reverse 给出模型真实收到的 prompt/schema） | ✅ 已重核 2026-05-25 |
| [设计模式](./claude-code/key-patterns.md) | 关键设计模式提取 | 🔲 待分析 |
| [安全系统](./claude-code/security-system.md) | 8 层纵深防御 + OS 级沙箱 + Auto 分类器 + Bash AST 安全 | ✅ 已完成 |
| [常驻服务](./claude-code/persistent-service.md) | 无 Gateway 的架构抉择 + MCP + Daemon + DirectConnect + 多实例协调 | ✅ 已完成 |
| [MCP 架构](./claude-code/mcp-architecture.md) | 官方 SDK host/server + 7 transport + 7 scope + `mcp__server__tool` + OAuth/XAA + prompts→slash / resources→@提及 | ✅ 已完成 |

### Hermes Agent

> **仓库**: https://github.com/NousResearch/hermes-agent | **本地**: `E:\Dev\longxia\_refs\hermes-agent-main` | **文档**: https://hermes-agent.nousresearch.com/docs/ | **协议**: MIT

Nous Research 开发的自主进化型开源智能体，核心差异化在于 Skills 自主创建/迭代、分层记忆系统和 15 平台消息网关。Python 技术栈，48K+ Stars。
与 OpenClaw 同为独立部署型智能体，但架构理念和扩展机制存在显著差异，对知行的记忆系统、技能进化、多平台架构设计有重要参考价值。

| 文档 | 内容 | 状态 |
|------|------|------|
| [架构概述](./hermes-agent/architecture-overview.md) | 架构与方案设计总览（**v0.14.0**：多入口收敛到 `AIAgent` 主循环，但运行期逻辑已下沉 `agent/` ~70 子模块、`run_agent.py` 仅 4410 行 forwarder；provider 双层适配 + 插件化；技能-记忆「回合后台 fork 复盘」+ 自治 Curator；新增 Kanban/LSP/Codex-runtime/`hermes proxy`） | ✅ 已重核 2026-05-25 (0.14.0) |
| Agent 循环 | 核心对话循环（真实实现已迁至 `agent/conversation_loop.py`，主循环 while @644）——已并入上面的架构总览 | 🔲 待独立成篇 |
| [Skill 系统](./hermes-agent/skill-system.md) | 技能子系统深读（仅索引进 system + `skill_view` 渐进披露 + 两层缓存；**三层进化闭环**：后台复盘 fork + 使用遥测状态机 + 自治 curator；write-origin provenance 信任边界） | ✅ 已完成 2026-05-25 |
| 记忆系统 | 分层记忆架构（MEMORY.md + SQLite + FTS5 + 用户建模） | 🔲 待分析 |
| [常驻服务/消息网关](./hermes-agent/persistent-service.md) | 17 平台 asyncio 网关 + BasePlatformAdapter + Cron + OS 服务 | ✅ 已完成 |
| 上下文压缩 | 上下文压缩 + Anthropic 前缀缓存策略 | 🔲 待分析 |
| 设计模式 | 关键设计模式提取（与 OpenClaw/Claude Code 交叉对比） | 🔲 待分析 |
| [安全系统](./hermes-agent/security-system.md) | Tirith 扫描 + 审批机制 + 文件/网络安全 + 代码执行沙箱 | ✅ 已完成 |
| [MCP 架构](./hermes-agent/mcp-architecture.md) | 单文件 client + 后台 asyncio loop + 官方 Python SDK + discovery-first CLI + 消息桥 server | ✅ 已完成 |

### 跨产品专题

> 同一主题在多个参考项目间的横向对比，为知行的对应设计提供事实依据。

| 文档 | 内容 | 状态 |
|------|------|------|
| [动态上下文注入](./dynamic-context-injection.md) | openclaw / hermes / claude-code 的 per-turn 动态注入对比 | ✅ 已完成 |
| [Web 搜索工具](./web-search-tool.md) | 三方 web_search 实现对比（服务端 hosted / 客户端多 provider）+ 对知行启示 | ✅ 已完成 |
| [Skill 系统横向对比](./skill-system-comparison.md) | openclaw vs hermes（含 claude-code 参照）：进上下文趋同（索引+渐进披露+缓存）vs 进化/信任/分发分歧 | ✅ 已完成 2026-05-25 |

## 分析规范

- 使用 [`_templates/source-analysis.md`](../_templates/source-analysis.md) 模板
- OpenClaw 分析必须引用具体的源码文件路径
- Claude Code 分析必须标注信息来源的可信度
- 架构图使用 Mermaid 语法，便于维护和版本管理
