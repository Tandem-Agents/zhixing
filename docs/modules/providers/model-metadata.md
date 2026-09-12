# 模型元信息与预算解析

模型能否请求、元信息是否已知、适合多长上下文，是三个不同问题。目录未收录不能误报模型不可用，也不能伪造 `unknown` 模型或借目录第一项的预算冒充当前模型。

## 目录与数据归属

`ProviderPreset.knownModels → ResolvedProvider.declaredModels → LLMProvider.models` 共用 `ModelInfo`，适配器直接复用目录。目录允许为空，只声明已知元信息，不穷举服务商支持的模型；请求始终使用实际选择的 model 字符串。

目录由预算解析、模型选择界面、输入能力与思考配置共同消费；它提供已知元信息，不限制可请求的模型范围。

当前 DeepSeek、硅基流动预设已有目录，其他预设可以没有。只维护会影响真实使用的元信息，不为重复协议兜底或凑齐型号建设无价值目录。推荐不受目录是否收录约束，见[模型角色](model-roles.md)。

## 预算优先级

`resolveModelInfo` 按以下顺序解析 `contextWindow / maxOutputTokens`：

1. 当前 Provider 的 `modelOverrides[model]`，按字段覆盖其下层基值。
2. declared catalog 中 model ID 精确匹配的条目。
3. 调用方注入的协议族默认。
4. core 防御性默认：32,000 / 4,096，并返回 `USING_FALLBACK` 警告。

协议默认由 providers 持有：OpenAI-compatible 为 128,000 / 4,096，Anthropic Messages 为 200,000 / 8,192。这些是当前工程兜底，不是目录外任意模型的真实能力保证；存在明确元信息时使用目录或覆盖值。

core 只接收预算形状，不依赖 providers 或协议字符串。Host binding 按实际 `primaryRole` 的协议、目录与覆盖值注入；普通 main 与工作场景 power 不能混用预算。主链正常注入协议默认时不会进入最后的防御性分支。

`modelOverrides` 属于 Provider 条目，由当前显式凭证投影携带，不写入公开 config。它与 `config.jsonc` 中的 `modelCapabilityOverrides` 不是同一个配置。

## 不同能力不可混为一谈

| 数据 | 当前来源与含义 |
|---|---|
| 总窗口／输出上限 | 上述预算链；描述容量，不保证长上下文质量 |
| 注意力阈值 | `modelCapabilityOverrides` → 内置 `MODEL_CAPABILITIES` → UNKNOWN 兜底；表达 optimal/risk，由上下文管理消费 |
| 图片输入 | 当前 Provider 的 model 输入覆盖 → 精确目录 `supportsImages` → false；不是从协议名称猜测支持 |
| 思考控制 | 目录 `thinkingControl` 描述可配形态，角色保存选择，适配器按方言发送；见[思考控制](thinking-control.md) |

预算和图片能力按 Provider 内 model ID 精确匹配；注意力阈值解析会归一化模型标识以共享同型号知识，不能把这种归一化用于实际请求改名。

解析出的最大输出与每次调用实际采用的输出限额也不等价。Host 对各角色另给协议级默认输出限额；单发调用、主循环与资源约束按各自路径消费，不能声称整个系统所有请求都自动使用目录最大值。

[上下文架构](../context/architecture.md)负责如何使用窗口和阈值，本文件只负责元信息来源、优先级与交界。远程 catalog、provider 级额外兜底和可插拔模型目录仍不属于当前实现。

## 实现入口

- [预算解析](../../../packages/core/src/context/model-info-resolver.ts)、[协议默认](../../../packages/providers/src/protocol-defaults.ts)
- [注意力阈值](../../../packages/providers/src/model-capability.ts)、[输入能力](../../../packages/core/src/types/user-input.ts)
- [宿主解析与注入](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)
