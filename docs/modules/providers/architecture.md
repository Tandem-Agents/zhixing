# Provider 与模型调用架构

知行需要接入不同服务商、聚合平台和私有部署，同时让智能执行不依赖某一家厂商。协议适配、模型元信息和产品角色各自负责不同问题，不能由一个 Provider 默认模型替用户决定全部用途。

## 核心边界

- **按协议而非服务商实现适配器。** 当前为 OpenAI-compatible 与 Anthropic Messages；同协议服务商通过预设和声明式 quirks 表达差异。已有协议不能表达的新协议才需要新适配器，不为每个服务商复制传输实现。
- **保留原生身份与参数语义。** 请求中的 model 是该服务商的标识，不做全局模型名改写；共同事件合同用于内部消费，不意味着把不同厂商的思考档位强行等价化。
- **连接信息不决定用途。** 预设描述连接、协议、方言和已知模型；角色层决定用哪一对 provider/model。模型目录既不是推荐表，也不是服务商可接受模型的白名单。
- **协议转换不拥有业务恢复。** 适配器转换请求、消息、工具、流事件和用量，传出错误；重试、看门狗、资源控制及运行终态由外围调用链负责。不能把自动换模型或隐藏失败作为协议适配的默认职责。
- **秘密只从宿主获得。** 设备本地 SecretStore 由产品组合根解锁，向工厂显式传入凭证投影。旧明文配置、环境变量键值与命令 helper 不是当前凭证来源；Provider 不自行扫描或读取持久化秘密。

## 当前装配与消费

```text
宿主的配置投影 + 设备本地凭证投影
  → resolveLLMRoles：解析角色与连接信息
  → createProviderRoles：选择协议适配器、绑定模型、复用实例
  → Host model-provider binding：解析预算、输入能力、注意力阈值与思考配置
  → Kernel / 推进运行体：按产品用途调用，执行资源与恢复规则
  → LLMProvider.chat → 协议 SDK → StreamEvent
```

`resolveProvider` 合并预设与显式凭证条目，`create-provider.ts` 按 protocol 选择适配器。单 Provider 工厂与角色工厂共用此路径；Provider 可被独立使用，不必知道 main/light/power。

当前 CLI 宿主的 `createHostKernelModelProviderFactory` 为普通会话和工作场景投影生效模型信息，`createHostAdvancementModelProviderFactory` 为推进职责提供调用与评议 binding；两者消费同一 Provider 解析层，承担不同的产品用途。orchestrator 消费注入结果，不再以旧 `run-agent.ts` 接线或自行读取配置为架构依据。

主循环与段摘要的显式重试、流空闲保护在 orchestrator 调用链装配；不同调用点的保护不能仅因共享 Provider 就视为完全相同。适配器本身没有业务重试循环，但 SDK 的内部默认行为也不能据此推断为已关闭。会话提交、恢复与资源终态不是本模块的所有权。

## 取舍与范围

按协议组织保留多服务商接入能力，避免每厂商复制实现；预设降低连接配置成本，用户仍可使用自定义连接与目录外模型。协议差异集中处理，不引入与个人部署无关的 OAuth 伪装、认证轮换或通用插件平台。

旧演进路线中的 Anthropic、缓存标记、思考传输和预算解析已有实现；旧 Phase 顺序不再是待执行计划。自动跨模型 failover、非流式回退、远程模型发现及精细缓存策略不能因旧稿列过就视为现有能力或本次承诺。

专题权威分别为[模型元信息](model-metadata.md)、[模型角色](model-roles.md)、[思考控制](thinking-control.md)和 [Anthropic 适配](anthropic-adapter.md)。[秘密存储](../secrets/architecture.md)、[首次引导](../secrets/onboarding.md)、[容错与模型调用恢复](../resilience/architecture.md)是相邻职责，不由 Provider 协议层重复定义。

## 实现入口

- [Provider 解析](../../../packages/providers/src/resolve.ts)、[工厂](../../../packages/providers/src/create-provider.ts)、[预设](../../../packages/providers/src/presets.ts)
- [Kernel 宿主装配](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)、[推进宿主装配](../../../packages/cli/src/runtime/advancement-model-provider.ts)
- [运行体装配与调用保护](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)
