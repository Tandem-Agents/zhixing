# ADR-002: Provider 层架构

> **状态**: 接受 | **日期**: 2026-04-07

## 背景

知行需要接入多种 LLM 服务商（国内外），且需要支持用户自定义 Provider（私有部署、聚合平台等）。核心问题是：

1. 按什么维度组织适配器？（每服务商一个 vs 每协议一个）
2. 如何管理多服务商的配置和凭据？
3. 如何处理同协议下不同服务商的行为差异？

## 决策

**按协议（Protocol）组织适配器，而非按服务商。** 配合预设注册表实现零配置接入常用服务商，同时支持用户完全自定义。

具体方案：

1. 只实现两个 Protocol 适配器：`openai-compatible`（覆盖 90%+ 服务商）和 `anthropic-messages`
2. 内置预设注册表包含常用服务商的默认配置（baseUrl、envKey、默认 model、quirks）
3. 用户配置通过 JSON 文件，支持三种场景：用预设、覆盖预设、完全自定义
4. API Key 统一解析三种格式：`env:VAR`、`helper:cmd`、明文
5. 同协议下的服务商差异通过声明式 Quirks 系统处理

## 依据

- 基于源码分析: [OpenClaw Provider/Transport 层](../../../source-analysis/openclaw/architecture-overview.md#8-llm-providertransport-层)
- 基于源码分析: [Claude Code Provider 层](../../../source-analysis/claude-code/architecture-overview.md#4-provider-层--只支持-anthropic)
- 基于认知研究: [q03-Provider 架构](../../../_private/questions/q03-provider-architecture.md)

## 考虑过的替代方案

### 方案 A: 每服务商一个适配器

- 优势: 每个适配器独立，可以精确处理差异
- 劣势: 爆炸式增长——每接入一个新服务商都要写代码；大量重复逻辑
- 未采用原因: 90% 的服务商走同一个协议，按服务商拆分浪费开发资源

### 方案 B: 只支持 Anthropic（Claude Code 方式）

- 优势: 极简，不需要多 Provider 架构
- 劣势: 国内用户无法直接使用；社区已经证明这是 Claude Code 最大的痛点
- 未采用原因: 知行面向的用户群体需要国内服务商支持

### 方案 C: 完全照搬 OpenClaw 方案

- 优势: 经过验证的成熟方案
- 劣势: 过于复杂——Auth Profile 轮换、生成的 env var 映射、provider discovery、extension 体系等对个人部署产品不必要
- 未采用原因: 复杂度与我们的场景不匹配

## 影响

- **积极影响**:
  - 新增 OpenAI 兼容服务商零代码（加一条预设记录）
  - 用户配置极简（内置预设只需 apiKey）
  - 聚合平台（硅基流动等）天然支持
  - 自定义 Provider 一个 JSON 对象搞定
- **消极影响/代价**:
  - Quirks 系统需要持续维护（不同服务商的差异点）
  - 两个 Protocol 适配器需要分别测试
- **约束**:
  - 新增非 OpenAI/Anthropic 协议的服务商需要新增 Protocol 适配器（如 Google Generative AI）
  - 模型名必须作为 provider 级别的配置透传，不做全局归一化

## 相关决策

- 依赖: [ADR-001 Monorepo 结构](001-monorepo-structure.md)
- 被依赖: 后续的配置系统设计、CLI 参数设计
