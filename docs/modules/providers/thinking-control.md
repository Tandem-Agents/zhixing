# 模型思考控制

思考控制跟随角色用途配置，模型原生能力决定可选项；不能把不同厂商的离散 effort、开关和 token budget 强行映射成一套强弱档位。未配置就不发送控制参数，避免系统替用户臆造模型参数。

## 职责与传输

`config.llm.<role>.thinking → Host 校验与 roleThinking → 主循环／单发调用／摘要请求 → ChatRequest.thinking → adapter 方言参数`

配置按 main/light/power 分别保存；`primaryRole` 选择当前主循环角色，不覆盖其他角色的思考设置。main 单发跟 main，默认单发与当前自动／手动段摘要使用 light thinking；旧独立 main 压缩链已退出，取舍差异见[模型角色](model-roles.md)。不能只接主循环漏掉其他请求构造点。

当前 `ThinkingControl` 由模型目录声明 none、toggle、effort（枚举原值）或 budget（可选范围），驱动配置编辑器和 `validateThinkingConfig`；`ThinkingConfig` 保存 off/on/effort/budget 的具体选择。共同结构只表达形态，不把一个厂商的档位解释成另一厂商的等价档位。

adapter 不读取配置文件，也不直接读取界面能力描述，而按 `ProviderQuirks.thinkingDialect` 转换已经传入的请求参数。元数据声明与协议方言分责，不能将旧稿“adapter 也直接由模型元数据驱动”当成现有结构。

## 当前发送形态

| 方言转换 | 当前实现 |
|---|---|
| DeepSeek | off/on 写 thinking.type；effort 额外写 reasoning_effort 原值 |
| Qwen | off/on 写 enable_thinking；budget 额外写 thinking_budget |
| GLM / Kimi | off/on 写 thinking.type；effort/budget 不发送 |
| Anthropic | 仅 budget 写 enabled + budget_tokens；on 不臆造预算，adaptive 未接入 |
| none 或不匹配形态 | 不生成思考参数 |

这是代码转换能力，不等于所有预设型号都已接通。当前只有 DeepSeek V4 Pro 目录明确给出 effort 控制；Anthropic 有发送和签名回传，但尚无逐模型控制目录。Qwen/GLM/Kimi 转换分支存在，其默认预设未声明相应 thinkingDialect，不能宣称默认使用这些预设就有完整控制体验。

## 配置与校验边界

配置编辑器在选择模型后使用目录控制形态提供列表或预算输入；无元数据不凭空展示控制项。onboarding 与 `/config` 复用编辑器能力，显示、校验和写入应保持一致。

宿主对已收录模型按 `validateThinkingConfig` 校验：不相容配置被忽略，Kernel 装配会告警；未收录模型目前直接传递配置，交由方言映射。因而“任何非法模型参数都已被拦截”并不成立。辅助角色回退后按生效模型进行校验，但未知模型的逐型号约束仍不可验证。

保留的设计要求是尊重原生形态、不发送已知无效参数、模型切换后不误用旧配置；当前元数据尚不完整，budget 与 max_tokens 的协议联动也没有统一校验。Anthropic 的 on 无预算与部分接口 budget 限制不能由共同形态校验自动证明正确。补齐这些要求需按具体型号与端点验证，不在文档迁移中新增能力或推定任意预算有效。

`supportsThinking` 粗标只说明思考能力信号，不代表用户可调参数；接收 reasoning/thinking 事件也不以该粗标为开关。带签名历史的协议保真见 [Anthropic 适配](anthropic-adapter.md)。

## 实现入口

- [类型与校验](../../../packages/core/src/types/llm.ts)、[预设](../../../packages/providers/src/presets.ts)、[方言转换](../../../packages/providers/src/adapters/thinking-params.ts)
- [Kernel 宿主装配](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)、[推进装配](../../../packages/cli/src/runtime/advancement-model-provider.ts)
- [配置编辑器](../../../packages/cli/src/config-editor/runner.ts)
