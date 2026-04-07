# 认知域 02：工具系统 (Tool System)

> 理解智能体如何感知和操作外部世界 —— 工具的全生命周期

## 领域概述

工具系统是智能体的"手脚"。它涵盖工具如何被定义和注册、如何向 LLM 描述自身能力、如何被安全地执行、以及执行结果如何返回给 LLM。工具系统的设计直接决定了智能体的能力边界和安全性。

## 关键问题清单

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| 1 | 工具是如何定义和注册的？工具描述的 Schema 是什么？ | — | ✅ 已研究 |
| 2 | 工具是如何传递给 LLM 的？描述格式和策略？ | — | ✅ 已研究 |
| 3 | 工具执行的沙箱化是如何实现的？ | [q05](../../_private/questions/q05-tool-system-security.md) | ✅ 已研究 |
| 4 | 工具执行结果如何序列化并返回给 LLM？ | — | ✅ 已研究 |
| 5 | 内置工具 vs 插件工具 vs MCP 工具的区别？ | [q05](../../_private/questions/q05-tool-system-security.md) | ✅ 已研究 |

## 核心发现

- OpenClaw 工具来自四个来源（Pi 内置 / OpenClaw 核心 / 插件 / MCP），运行时合并后经多层策略管道过滤
- Claude Code 用 14 步 `checkPermissionsAndCallTool()` 管线处理每次工具调用
- 两者都采用 fail-closed 默认值——未声明安全属性的工具按最危险处理
- 工具结果管理是必须的——不做大小限制，一次 `cat` 大文件就能撑爆上下文

## 知行设计决策

- 统一 `ToolRegistry` 管理四类工具（内置/插件/MCP/动态）
- 5 阶段 15 步中间件管线，渐进实现
- 协议/实现分离——工具定义与执行环境解耦
- 结果分层预算（per-tool + session 级）
- 详见 [ADR-004](../../design/architecture/decisions/004-tool-system-architecture.md)

## 对应源码分析

- OpenClaw: `src/agents/pi-tools.ts`, `src/agents/openclaw-tools.ts`, `src/agents/sandbox/`
- Claude Code: `checkPermissionsAndCallTool()`, `buildTool()`, `StreamingToolExecutor`
