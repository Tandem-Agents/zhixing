# 认知域 03：上下文管理 (Context Management)

> 理解智能体如何在有限的上下文窗口中最大化信息利用率

## 领域概述

上下文窗口是 LLM 最核心的约束。所有信息——系统提示、对话历史、工具描述、工具结果、文件内容——都必须在这个窗口内。上下文管理的质量直接决定了智能体的"智商"——同样的模型，上下文管理好的系统表现远优于管理差的系统。

## 关键问题清单

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| 1 | Token 估算如何实现？不同产品的策略有何异同？ | source-analysis 两篇 | ✅ 已研究 |
| 2 | 当上下文超出窗口限制时，如何截断或压缩？ | source-analysis 两篇 | ✅ 已研究 |
| 3 | 对话历史如何管理？是否有摘要/压缩机制？ | source-analysis 两篇 | ✅ 已研究 |
| 4 | 知行的上下文引擎应该怎么设计？ | design/specifications/context-engine.md | ✅ 方案已设计 |
| 5 | Prompt Cache 如何工作？对上下文管理有什么约束？ | — | 🔲 待研究 |

## 核心发现

### Token 估算

- **三个产品都不用 tiktoken**——轻量级启发式估算 + API 返回值校准是业界共识
- **chars/4 是通用基线**，但对 CJK 文本严重低估（中文约 1-2 token/字）
- **API `usage` 是最可靠的数据源**，用于校准启发式估算

### 压缩策略

- **Claude Code 有 5 层递进压缩**——从免费（截断）到昂贵（LLM 摘要），行业最复杂
- **OpenClaw 主要委托闭源包**——自研 Safeguard 模式是增强，不是替代
- **成本优先级联是共识**——先做免费操作，最后才调 LLM
- **熔断保护是必需的**——Claude Code 因缺少检查导致过单会话数千次失败调用

### 知行策略

- **3 层而非 5 层**：L1 ToolResult 截断 → L2 早期消息丢弃 → L3 LLM 摘要
- **主动监控**：每轮检查预算，不等 413 才反应
- **CJK 一等公民**：核心估算路径直接处理
- **自适应精度**：追踪估算误差，动态调整比率
- **百分比阈值**：自适应不同窗口大小

## 对应源码分析

- [OpenClaw 上下文管理](../../source-analysis/openclaw/context-management.md)
- [Claude Code 上下文管理](../../source-analysis/claude-code/context-management.md)

## 设计产出

- [知行上下文引擎设计方案](../../design/specifications/context-engine.md)
- [L3 LLM 摘要压缩方案](../../design/specifications/llm-summarization.md) — 7 段模板 + 质量校验 + 续写机制
- [会话持久化方案](../../design/specifications/session-persistence.md) — JSONL + Turn 级粒度 + 无索引设计

## 建议研究顺序

~~先理解上下文的组装结构（什么东西在上下文里），再研究截断/压缩策略，最后关注 Prompt Cache 优化。~~

核心研究已完成，含竞品摘要 prompt 模板对比 + 会话持久化对比。后续关注：Prompt Cache 优化策略（需要实际使用数据支撑）。
