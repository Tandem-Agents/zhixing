# 认知域 09：协议与通信 (Protocol & Communication)

> 理解智能体系统内部和外部的通信机制

## 领域概述

协议层是智能体系统的"神经网络"。它定义了各组件如何通信、消息如何路由、以及如何与外部通讯渠道（微信、Telegram、Slack 等）集成。对于我们的"知行"项目，这也是连接 yuling-mobile 的关键架构层。

## 关键问题清单

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| 1 | Gateway 的角色和架构是什么？ | — | 🔲 待研究 |
| 2 | 内部组件间的通信协议是怎样的？ | — | 🔲 待研究 |
| 3 | 多通讯渠道的路由机制是怎样的？ | — | 🔲 待研究 |
| 4 | 实时通信（WebSocket 等）如何实现？ | — | 🔲 待研究 |
| 5 | ACP (Agent Communication Protocol) 是什么？ | — | 🔲 待研究 |

## 对应 OpenClaw 源码

- `src/gateway/` — 网关核心
- `src/channels/` — 通讯渠道管理
- `src/routing/` — 消息路由
- `src/acp/` — Agent Communication Protocol
- `docs.acp.md` — ACP 文档

## 建议研究顺序

先理解 Gateway 的整体架构和职责，再深入消息路由和通讯渠道集成。
