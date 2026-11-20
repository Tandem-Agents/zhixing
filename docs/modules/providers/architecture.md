# Provider 与模型调用架构

知行需要接入不同服务商、聚合平台与本地/私有部署，同时让智能执行不依赖某一家厂商。供给层（服务商连接）、协议适配层、模型资料层、产品用途层与会话覆盖层各自负责不同问题，互不越权。

## 核心边界

- **按受控协议而非服务商实现适配器。** 当前实现四类受控协议：`openai-compatible`、`openai-responses`、`anthropic-messages` 与 `google-interactions`。同协议服务商通过单一策展目录中的预设与声明式方言（`usageDialect` / `thinkingDialect`）表达差异，不为每个服务商复制传输实现；未实现协议由能力门控显式标为“需升级知行”，不冒充可用。
- **供给层与用途层单向分层。** v2 公开配置将 `llm.connections`（名称、预设修订、协议、固定端点、认证引用、代理/私网策略、自定义型号、规格覆盖与隐藏列表）与 `llm.main / light / power` 用途默认解耦，用途仅单向引用连接，连接层不自荐用途默认。
- **保留原生身份、有界协议状态与来源隔离。** 请求中的 `model` 是该连接的原生标识，不做全局模型名改写；有界协议私有推理态与非秘密来源身份（`sourceConnectionId + sourceOriginKey`）贯通消息、转录与执行封套。同来源同协议保真重传（含 OpenAI Responses 窄发送视图前缀稳定与 Google Interactions 无状态重传）；跨连接、同连接改址/换适配、跨协议或来源不明旧记录默认不转发私有推理载荷，避免签名泄露或误发 400。
- **单源模型资料与可信维护更新。** 内置 11 项预设、型号规格、用途推荐与经验注意力阈值统一派生自单一 `CuratedCatalogBundle`，经 `ModelCatalogPort` 窄读口供给后端与终端；运行时由 `ModelCatalogManager` 通过受限 TUF 客户端原子更新，支持断网/损坏安全回落、跨进程单写与能力门控隔离，且绝不静默改写既有连接固定端点或用户偏好。
- **受控网络与秘密隔离。** 设备本地 `SecretStore` 按逻辑 `secretRef` 保存 `api-key` / `header` 凭据（免密连接无需密钥），`config.jsonc` 不存明文秘密；草稿凭据仅在编辑进程本地用于只读发现与自愿验证，不跨普通 RPC。网络出口统一经单跳受控传输与明确来源限定的私网许可。

## 当前装配与消费

```text
单一策展目录 (ModelCatalogManager → ModelCatalogPort) + 隔离发现缓存 (ModelDiscoveryCache)
  + 公开配置 v2 (llm.connections + main/light/power) + 设备本地 SecretStore (modelSecrets)
  → ModelRuntimePort：统一解析、窄激活（不断开未变通道）、退役清退与显式撤权中止
  → resolveLLMRoles / createProviderRoles：按四类受控协议装配适配器、方言与三层合成规格
  → Kernel / 推进 / Executor 宿主装配：叠加 Session owner 持久化的 SessionModelSelection
  → LLMProvider.chat → 受控协议 SDK / 单跳传输 → StreamEvent + 统一脱敏错误分类
```

- **保存与生效裁决**：纯模型域修改经 `server.apply-model-configuration` 走 `ModelRuntimePort` 本机窄激活，不中断无关消息通道；混合变更（如同时改动全局 `network.proxy` 或工作区）走单次完整宿主换代，且先执行撤权/强制停用止血；无宿主首配由编辑进程本地完成。
- **连接删除与凭据清退**：删除前预览受影响用途与共用凭据，主模型改绑同次完成；普通退场登记至 `configuration/model-retirements/v1` 待在途归零/重启幂等清理，显式撤权立即持久解绑、禁止新调用并中止在途调用。
- **终端与状态面同源**：`/config` 模型页统一组织为“服务商连接 / 用途默认 / 模型资料与更新”三块；交互 `/model` 提供总览、搜索、本会话切模、显式设用途默认、原位调参与已隐藏型号恢复；文本 `/model`、`/status`、`ReplLocalView` 与状态栏消费同一 `projectEffectiveModelDisplay` 生效投影。

## 取舍与专题权威

按协议分层兼顾多厂商接入与协议保真，其代价是需持续维护各协议的流式、工具与推理态边界；通过单一策展目录、可审维护流与 TUF 静态分发将同协议变化与客户端升级解耦，详见[模型目录维护手册](catalog-maintenance-runbook.md)。

专题权威分别为[模型元信息](model-metadata.md)、[模型角色](model-roles.md)、[思考控制](thinking-control.md)和 [Anthropic 适配](anthropic-adapter.md)。[秘密存储](../secrets/architecture.md)、[首次引导](../secrets/onboarding.md)、[容错与模型调用恢复](../resilience/architecture.md)是相邻职责，不由 Provider 协议层重复定义。

## 实现入口

- [v2 配置与解析](../../../packages/providers/src/resolve.ts)、[四协议工厂](../../../packages/providers/src/create-provider.ts)、[受控目录读口](../../../packages/providers/src/catalog-port.ts)
- [目录协调器与 TUF](../../../packages/providers/src/catalog/catalog-manager.ts)、[三层合成引擎](../../../packages/providers/src/catalog/synthesis.ts)、[原生发现与隔离缓存](../../../packages/providers/src/discovery/native-discovery.ts)
- [模型运行端口与窄激活](../../../packages/cli/src/runtime/model-runtime-port.ts)、[Kernel 宿主装配](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)、[统一生效投影](../../../packages/cli/src/runtime/model-display-projection.ts)
- [交互 `/model` 控制器](../../../packages/cli/src/terminal/model-command.ts)、[`/config` 模型面板](../../../packages/cli/src/config-editor/sections/model.ts)
