# 模型角色与推荐

服务商连接解决“如何调用”，角色解决“用来做什么”。角色与推荐单向引用 provider/model；连接层不能反过来携带角色用途或自荐默认模型。

## 角色与调用隔离

- `main` 必填，用于普通主对话及质量敏感的单发任务。
- `light` 可选，用于默认单发文本、段切换摘要和 WebFetch 蒸馏等辅助处理。
- `power` 可选，用于工作场景主对话。

角色名称表达用途，不强制模型强弱或厂商。`primaryRole` 决定当前主循环使用 main 还是 power；单发 main/light 分流不随工作场景整体改绑。Task 子 Agent 继承父运行体的主角色模型。推进运行体另由宿主装配 main/light 调用，不能把会话角色工厂当成全部产品业务的编排器。

主对话摘要是后续认知输入，模型选择不能只按成本取舍；此前将 `LLMSummarize` 从 light 升为 main 正是为了保证摘要质量。该独立压缩路径已退出。当前自动切段与手动 `/compact` 都经 SegmentManager，以 `roles.light.model` 和 light thinking 构造摘要请求，实际通过 `roles[primaryRole].provider.chat` 发送：普通会话使用 main 的连接，工作场景使用 power 的连接，而不是 light 的连接。light 与主角色配置不同 Provider 时，其模型标识与思考参数仍会发往主角色的端点，可能不被该端点识别或支持，不能描述为完整的 light 角色调用。当前角色选择与此前 main 压缩的质量取舍存在差异，机制见[上下文架构](../context/architecture.md)。

辅助调用的首要价值是独立请求上下文：不将完整工具材料和一次性处理过程直接灌入主对话历史，避免无关材料在后续轮次持续占用注意力和输入开销；即使用同一模型也保留此价值。任务专门化与成本节约是可选收益。独立调用并不保证提示注入被消除，摘要输出仍需遵守不可信材料边界，不能当成安全净化证明。

## 解析、回退与实例

`resolveLLMRoles` 从 `llm.main/light/power` 与显式凭证投影解析，不创建实例；`createProviderRoles` 再创建适配器并绑定 model。`LLMRole.chat` 将绑定的 model 写入请求，避免各消费者重复指定造成串用。

- main 缺失或必要连接信息不可解析时失败，不伪造可用角色。
- 可选角色缺省，使用 main 的连接与模型，不提示异常、不偷偷探测其他厂商。
- 可选角色显式指向另一 Provider，但发生 `ProviderConfigError`，回落 main 并返回结构化 degradation；Kernel 宿主装配可见告警。非配置异常不吞掉。
- 与 main 使用同一 Provider ID 的角色复用其实例，model 仍各自绑定；实例共享不是共享 conversation。当前工厂不保证任意两个非 main 同 ID 角色也统一去重，消费者不得依赖实例 `===`。

可选角色不应阻塞正常产品流程；现有回退覆盖的是配置解析失败，不等于远端请求失败后自动换模型。相同 Provider 下错误 model ID 也不会因目录校验被提前识别。

`ROLE_SPECS` 定义角色身份、必填性、兜底与界面文案；显式 `LLMRoles` 接口保持调用可读性，类型断言核对键集。界面等机械层消费注册表，但解析与工厂仍显式列出三个角色，不能承诺新增一行即全部自动完成。

## 推荐属于产品选择

推荐钉死一对 `(provider, model)`，避免让用户再决定用哪家服务商运行同名模型；同一底层模型在不同服务商也可能使用不同 ID，单独推荐模型名不足以形成可用选择。Provider 只给连接信息和可选项，不持有 `defaultModel` 推荐语义。

`ROLE_RECOMMENDATIONS` 是推荐唯一来源；当前 main 指向 DeepSeek V4 Pro，light 指向 DeepSeek V4 Flash，power 无推荐。

推荐表以可缺省的角色映射表达，配置模板与编辑器消费同一表。模板提供可编辑的初始选择；运行期未配辅助角色仍回落 main，两者不冲突。无推荐就是无推荐，不由 Provider 补一个隐含模型。模型列表提供目录项与用户自定义项，推荐标签表达当前角色的推荐；无目录也允许自定义模型。

推荐的 Provider ID 有编译期约束，model 不以是否属于 knownModels 为合法性条件；这不保证网络、凭证或型号实际可用。默认值显示、预览检查与完成写入必须同源，不能出现显示可完成但点击结果不同。

用户配置是角色选择的基础入口，已删除旧 CLI `--provider/--model` 覆盖。当前远端 Executor 仍有经运行选择传入的 `mainModelOverride`，由 Host 合成生效配置再解析；这是执行选模入口，不是恢复 CLI 覆盖，也不能将“配置基础来源”误写成运行时绝无模型选择覆盖。

## 消费与能力缺失

角色作为会话级能力共享，不让每个工具自行读取配置或创建连接。工具可通过 `ctx.llm` 调用；能力缺失时必须明确返回可用的退化结果或错误，不能无操作却报告成功。WebFetch 在缺少角色或没有蒸馏 prompt 时返回原材料路径；工具自身仍负责其输入和失败合同。

当前消费者共享模型调用能力，不统一包装业务任务：对话摘要处理消息历史，网页蒸馏处理材料与查询，一次性文本任务又有自己的提示词、输出和质量约束。统一的 `LLMService.summarize/classify/extract` 容易丢失任务差异或迫使调用方绕过封装；各任务直接使用角色能力，分别负责自身业务合同。

## 实现入口

- [角色定义](../../../packages/providers/src/role-spec.ts)、[推荐](../../../packages/providers/src/role-recommendations.ts)、[解析](../../../packages/providers/src/resolve.ts)、[实例工厂](../../../packages/providers/src/create-provider.ts)
- [Kernel 宿主装配](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)、[Executor 选择消费](../../../packages/cli/src/serve/executor-role-runtime.ts)、[推进装配](../../../packages/cli/src/runtime/advancement-model-provider.ts)
- [运行体消费](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)、[WebFetch](../../../packages/tools-builtin/src/web-fetch.ts)
