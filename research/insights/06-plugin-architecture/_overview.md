# 认知域 06：插件架构 (Plugin Architecture)

> 理解智能体如何通过插件系统实现能力的无限扩展

## 领域概述

插件架构决定了智能体的可扩展性。一个好的插件系统让核心保持精简，同时允许社区和第三方无限扩展能力。OpenClaw 的核心设计哲学是"Core stays lean; optional capability should usually ship as plugins"。

## 关键问题清单

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| 1 | 插件的生命周期是怎样的？发现、加载、注册、执行 | — | 🔲 待研究 |
| 2 | 插件 SDK 的 API 边界是如何定义的？ | — | 🔲 待研究 |
| 3 | 插件与核心之间的通信机制是什么？ | — | 🔲 待研究 |
| 4 | Channel 插件（通讯渠道）的抽象是怎样的？ | — | 🔲 待研究 |
| 5 | Provider 插件（模型提供商）的抽象是怎样的？ | — | 🔲 待研究 |

## 对应 OpenClaw 源码

- `src/plugins/` — 插件发现、校验、加载、注册
- `src/plugin-sdk/` — 插件公共 SDK（公开 API 边界）
- `src/channels/` — 通讯渠道核心实现
- `extensions/` — 内置扩展插件

## 建议研究顺序

先理解插件的整体生命周期，再分别深入 Channel 和 Provider 两种核心插件类型的抽象设计。
