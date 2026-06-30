---
name: project-onboarding
description: 当用户需要让 agent 快速了解当前项目核心、熟悉仓库结构、建立继续开发或审查前的项目上下文时使用。
metadata:
  stepped-skill.version: "0.1"
  stepped-skill.entry: "steps/01-project-overview.md"
---

# 项目上手

使用本 Skill 帮助 agent 在当前仓库中快速建立项目核心上下文。

## Fallback Workflow

如果 step 文件不可用，按以下低保真路径线性完成工作：

1. 阅读项目级说明、根目录元数据和主要目录结构，建立项目整体地图。
2. 继续查找并阅读与项目核心架构最相关的设计或研究文档。
3. 输出一份简洁的项目上手摘要，说明项目目标、核心模块、关键架构概念、常用命令和仍不确定的信息。

这个 fallback 是完整但低保真的路径。可读取 step 文件时，应使用 step 文件，因为精确的阶段资料和高保真说明位于对应 step 中。

## Stepped Skill Protocol

本 Skill 使用 Stepped Skill Protocol v0.1。

从 `steps/01-project-overview.md` 开始。

循环：

1. 完成当前 step。
2. 记录当前 step 要求的 handoff。
3. 读取 `Next` 指向的路径。
4. 当 `Next` 为 `END` 时停止。
