# 认知域 01：核心循环 (Agent Loop)

> 理解智能体最本质的运行机制 —— LLM 与外部世界的交互循环

## 领域概述

核心循环是智能体系统的心脏。它定义了 LLM 如何接收输入、决定是否调用工具、处理工具结果、并最终生成回复的完整过程。理解核心循环是理解一切其他模块的前提。

## 关键问题清单

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| 1 | 什么是 Agent Loop？它的完整生命周期是怎样的？ | [q01](../../_private/questions/q01-core-intelligence-framework.md) | ✅ 已研究 |
| 2 | 单轮 Tool Call 的完整流程是什么？ | [OpenClaw 分析](../../source-analysis/openclaw/agent-loop.md) | ✅ 已研究 |
| 3 | 多轮 Tool Call 如何编排？循环何时终止？ | [q02](../../_private/questions/q02-agent-loop-design.md) | ✅ 已研究 |
| 4 | 流式输出如何与 Agent Loop 配合？ | [Claude Code 分析](../../source-analysis/claude-code/agent-loop.md) | ✅ 已研究 |
| 5 | 错误处理和重试机制是怎样的？ | [Claude Code 分析](../../source-analysis/claude-code/agent-loop.md) | 🔶 已了解机制，实现延后 |
| 6 | 人机交互（审批/确认）如何嵌入循环？ | — | 🔲 待研究 |

## 对应源码分析

- [OpenClaw Agent Loop 分析](../../source-analysis/openclaw/agent-loop.md) — Pi-Agent-Core 内层 + 外层编排
- [Claude Code Agent Loop 分析](../../source-analysis/claude-code/agent-loop.md) — query() 异步生成器

## 设计决策

Agent Loop 设计方案已确定，见 [q02-Agent Loop 设计](../../_private/questions/q02-agent-loop-design.md)。
核心决策：AsyncGenerator + while(true) + 拆分辅助函数，不可变状态转换。
