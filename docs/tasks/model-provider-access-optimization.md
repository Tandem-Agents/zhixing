# 模型与服务商接入体系优化

## 需求与目标

对模型与 AI 服务商接入体系进行系统性优化，贯通底层架构、功能实现、用户使用体验和当前终端入口，同时解决知行作为供给方如何维护接入能力、响应服务商及模型更新的问题。

先核实真实现状，再研究一流知识与实践，最后结合[愿景](../vision.md)、[架构演进方向](../architecture/evolution-direction.md)和现行[整体架构](../architecture/overview.md)设计适合知行的体系。目标是吸收经过核实的有效原理并取得更好的用户与维护结果，不照抄现成产品，也不以“当前实现较旧”预先判定所有部分都必须重写。

## 接入体系现状

以下依据 `develop@bfedc5af` 的生产源码及相关模块合同，由双方分别核查后合并。这里说明当前实现，不把目录声明当作服务商最新线上能力，也不以后台接口存在代替普通用户可以完成操作。

### 架构与功能

| 层面 | 当前实现与边界 |
| --- | --- |
| 调用合同与协议 | core 的 `LLMProvider` 提供流式 `chat`、已知 `models` 及可选预备/计数能力；providers 按协议组织 OpenAI Chat Completions 兼容适配和 Anthropic Messages 适配，归一文本、思考、工具与用量事件。尚无 Responses、Gemini 原生协议等适配。两 SDK 已显式关闭内部重试，外围负责重试、看门狗和资源结算；没有跨模型自动 failover。 |
| 服务商覆盖 | 后端静态预设有 DeepSeek、MiniMax、硅基流动、千问、Kimi、GLM、OpenAI、Anthropic 八家；终端注册表只开放 DeepSeek 和硅基流动。底层可表达自定义 baseUrl/protocol/quirks，但普通配置入口没有录入这些字段或新增服务商的完整路径。 |
| 配置与认证 | 公开配置保存 main/light/power 的 provider/model/thinking 选择等；API Key 与 baseUrl、协议、方言、用户模型列表和部分能力覆盖同存在设备 SecretStore 条目中。旧公开 providers 配置被拒绝。当前产品接入要求非空 API Key，没有无 Key、OAuth/云身份等接入流程；不能把手改秘密文件或旧格式迁移当作日常配置办法。 |
| 模型知识与角色 | 静态模型目录仅四条，注意力阈值表仅两条；推荐 main 为 DeepSeek V4 Pro、light 为 V4 Flash，power 无推荐。main 必填，light/power 缺省沿用 main，显式配置错误可告警回落；这不是网络请求失败后的自动切换。目录外模型 ID 可请求，但不自动获得准确能力信息。 |
| 元数据的消费 | 窗口/输出容量、注意力质量阈值、图片能力、思考控制来自不同表或覆盖项。预算按覆盖→精确目录→协议默认→防御默认解析；实际请求未显式指定输出上限时，运行装配另用协议默认 4096/8192，并不自动采用目录最大输出值。当前内置目录没有 `supportsImages: true`，无显式覆盖时图片预检为 false。覆盖接口存在，但相关终端编辑入口缺失。 |
| 思考与历史适配 | 多种思考方言已有底层转换，但千问/GLM/Kimi 默认预设未声明对应方言；思考 UI 只查内置目录，目前仅 DeepSeek V4 Pro 提供相应选项。Anthropic 和目录外模型不能由当前向导完整配置思考；其手工公开 thinking 配置缺少已知元数据时直接透传。兼容适配器对含思考的历史发送 `reasoning_content`，未按目标方言筛选；跨服务商是否拒绝仍须按具体端点核验，不能预先称已发生 400。 |

两个直接影响后续设计的接合问题也已从代码核实：一是自动切段与手动 `/compact` 使用 light 的模型 ID，却经 main/power 当前主角色的 Provider 发送，跨服务商时模型与端点可能不配对；二是模型投影未携带 `network.proxy`，模型的受控传输直接调用全局 fetch，产品显式代理设置未由该链消费。后者不等于否定系统级代理或其他运行环境的可能性。

依据：[调用合同](../../packages/core/src/types/llm.ts)、[Provider 工厂](../../packages/providers/src/create-provider.ts)、[解析](../../packages/providers/src/resolve.ts)、[预设](../../packages/providers/src/presets.ts)、[宿主模型绑定](../../packages/cli/src/runtime/kernel-runtime-bindings.ts)、[主循环及段摘要](../../packages/orchestrator/src/runtime/create-agent-runtime.ts)、[模型传输](../../packages/providers/src/adapters/delivery-transport.ts)。

### 用户使用与配置生效

首次引导和 `/config` 共用配置编辑器：选择角色 → 选择两家服务商之一 → 填 API Key、选模型或手填完整 ID → 对有目录声明的模型配置思考 → 完成配置。编辑先留在内存，最终保存才进入配置与秘密 owner；取消不提交本次编辑。必填检查只看 main 的 provider/model/key 是否存在，没有日常接入前的连通、凭据、模型权限或能力验证，配错通常到首次请求才暴露。

`/model` 当前只显示配置中 main 的模型和服务商两行信息，不提供快捷切换，也不完整展示其他角色及其能力。自定义模型列表有添加、无删除入口；已填 API Key 不能通过提交空值清除，亦无完整移除服务商流程。非交互文本入口不能完成专用配置编辑，旧 CLI `--provider/--model` 覆盖也已移除。已知网络、超时、认证、限流和服务端错误有中文说明，其他类别仍可能返回原始异常；不能笼统保证所有错误都有可操作指引。

保存和应用是不同结果。无变更及仅 Channel 变更可不整体重载；模型、角色或思考设置等其他配置变更，会等待当前终端运行结束，再请求宿主 drain 停机、重连和重新装配。用户不必手动重启，但未变通道也随宿主重装，内存态授权不能靠恢复对话证明已保留。旧宿主先退出，随后才重连，新配置启动失败时没有完整的保旧实例回滚保证。

依据：[终端服务商列表](../../packages/cli/src/registries/providers.ts)、[模型面板](../../packages/cli/src/config-editor/model/list.ts)、[输入与修改](../../packages/cli/src/config-editor/model/input.ts)、[必填检查](../../packages/cli/src/runtime/model-configuration-check.ts)、[模型显示投影](../../packages/cli/src/runtime/runtime-configuration-provider.ts)、[配置应用](../../packages/cli/src/runtime/configuration-application.ts)、[错误反馈](../../packages/cli/src/terminal/model-failure.ts)。

### 供给方维护与更新

| 外部变化或维护事项 | 当前处理路径 |
| --- | --- |
| 已配置服务商增加同协议模型 | 用户可手填新 model ID；协议和端点确实接受时，无须为“识别名称”发布新版知行。目录缺失的能力、思考选项和预算不会因此自动补齐。 |
| 知行更新内置服务商/模型目录、能力、推荐或展示入口 | 修改 TypeScript 预设、能力表、推荐或终端注册表，构建并发布程序；没有独立目录数据包、远程发现、目录版本/回退与退役通知机制。 |
| 用户修改已暴露配置 | 通过现有编辑与保存机制，按前述宿主换代方式应用；这是运行配置变更，不等于升级知行软件版本。 |
| 新协议、认证或参数语义 | 修改相应适配、类型、装配和入口，作为代码变更交付；当前没有现成的 Provider 受管扩展类型。 |

因此问题不是“任何模型更新都必须升级系统”，而是已有同协议自定义模型入口与静态目录、能力知识、配置入口及运行应用之间缺少完整衔接。现有按协议适配、显式凭据注入、模型角色和耐久保存等基础仍可用，其是否保留或调整须经后续研究与设计判断。

**核验边界：** 本阶段核实了源码、调用/配置消费链及模块合同，未读取用户秘密或调用真实服务商；没有用源码阅读冒充当前各厂商账号、线上协议及终端全旅程实测。目录中的具体能力数值、跨服务商回放的线上结果和前沿能力在第二阶段继续核读一手资料，影响设计时再做有针对性的核验。

## 调研所得

> 调研独立审查标准（定稿）
>
> 1. 答全需求。结合实际案例讲清底层架构、功能实现、终端用户体验和供给方维护更新。服务商上新模型或改变协议时，说明维护者改什么、用户何时感知、何时需要升级程序及其原因。
> 2. 证据扎实。每条足以影响设计方向的判断均可追到亲自核读的一手材料，注明适用版本、条件和证明范围。区分来源的主张、实现或实测支持的事实，以及自己的推断。
> 3. 找到一流标杆。围绕决定性问题先广泛探索，再择优深入。对可能改变结论的同类产品、原生能力、历史或跨领域实践，比较或说明排除依据。指出标杆在哪个维度领先、强在哪里、凭什么选它比较。
> 4. 讲透机制与取舍。把强方案放进同一个有难度的场景，从维护者和终端用户两侧说明工作机制、结果差异和各自代价。用最强可信反例检验关键结论，说明什么条件改变会使判断反转。
> 5. 形成可用于超越的洞察。指出一流方案留下的具体问题及原因、知行可能改善谁的什么结果、成立条件和验证方法。有依据地说明某项成熟做法值得保留、强行改变会付出什么代价，同样成立。实际超越程度留待实现验证。
>
> 五项必须同时满足。双方先各自审查同一份调研正文、独立记录依据，再交换质询。尚有足以改变设计方向的遗漏、薄弱证据或未处置反例，就按调研技能定向补研并复核。局部例证的限制如实收紧。以上标准固定，不因已有结论或后续方案而调整。

本轮围绕三个问题重新研究。**服务商和模型怎样进入用户可选范围，终端怎样帮助用户选择，维护者怎样把变化持续送到用户。** 下列产品行为按 2026-11-18 官方文档陈述，底层机制另以源码核实，公开采样只证明所发布的资料。关于知行的改善属于据此作出的判断。源码基线为 Hermes `0e8e4216`、OpenCode `79bd2c6f`、Pi `e675a0d7`、models.dev `7b22cc90` 与 OpenClaw catalog `beef19a9`，原生 Claude 列表按 `2026-10-21` API 版本核读。

### 研究范围与标杆

OpenClaw 与 Hermes 同属可自行部署的个人智能体。OpenClaw 将供给维护、推荐审核与用户完整列表连成一条可核对的链，适合作整体参照；Hermes 用小型独立 manifest 更新精选及默认，适合检验降低维护成本的路线。OpenCode 重点看社区目录怎样与用户配置合成，Pi 重点看兼容服务商自定义和旧客户端目录更新。LLM 提供轻量的模型插件及手填路径作为竞争方案。models.dev 与服务商原生列表用于核对信息来源。

选样依据是对服务商供给、型号选择和资料维护的直接贡献。 Claude Code 的特定型号最低版本和 Codex CLI 仅保留 Responses 的做法，作为单生态产品的局部对照。它们覆盖的服务范围较窄，本文以多服务商个人智能体的供给链作主要比较。企业网关限于已有统一接入的部署情形，SDK 限于适配能力边界。跨领域核读了 RFC 6557 的外部事实维护与 TUF 的可信更新原理，借鉴限于资料发布责任及来源验证，接入范围和模型推荐仍须以模型领域的证据判断。[Codex 协议范围](https://github.com/openai/codex/blob/4389a526d51a5a7600e0648436a7142a304f0188/codex-rs/model-provider-info/src/lib.rs#L112-L114) · [Claude Code 型号版本要求](https://code.claude.com/docs/en/model-config.md) · [LLM 配置与插件](https://llm.datasette.io/en/stable/other-models.html) · [RFC 6557](https://www.rfc-editor.org/rfc/rfc6557) · [TUF 1.0.37](https://theupdateframework.github.io/specification/v1.0.37/)

### 底层怎样支撑用户的选择

**服务商支持与模型资料分别有归属。** Hermes 以 `ProviderProfile` 向配置向导、模型列表和底层请求提供服务商定义，减少各层各维护一张名单的偏差。 OpenClaw 由 provider 插件声明端点、协议、静态模型与发现方式，公共目录仅补已安装服务商的模型信息。OpenCode 将目录读取与执行包装载分开，兼容服务商还能由用户配置补入。Pi、LLM 也允许为已支持的兼容 API 配置新端点和型号。新增一家兼容服务商可只补声明与配置，独有协议则需要适配代码，交付位置可以是程序或受支持的扩展。目录里加一个名字不足以完成全部接入。[OpenClaw 模块合同](https://docs.openclaw.ai/plugins/manifest/models.md) · [Hermes 服务商定义](https://github.com/NousResearch/hermes-agent/blob/0e8e42164063bf426af328ef94e2001dcaf9db1f/providers/README.md) · [OpenCode 目录实现](https://github.com/anomalyco/opencode/blob/79bd2c6f11fd5ad011dbe5a1c31343c46e1e5294/packages/core/src/models-dev.ts) · [Pi 自定义服务](https://github.com/earendil-works/pi/blob/e675a0d7f4150fcee66dabbbf890913f6aef9a8b/packages/coding-agent/docs/models.md)

**连接信息需要可以编辑，凭据需要受保护。** Pi 将端点、型号和凭据来源放在同一私有配置中，OpenClaw 则要协调用户声明与生成目录，防止旧值覆盖当前设置。对知行而言，研究价值在于让用户能够增改服务商地址、型号与规格，同时沿用本机秘密保护能力。Ollama 本地 API 本身无需密钥，Pi 的兼容入口却要求占位 Key；OpenClaw 当前只有特定兼容适配支持显式免密。该差异来自接入层约束，不能拿必填密钥代替所有连接的配置规则。[OpenClaw 自定义连接](https://docs.openclaw.ai/concepts/model-providers/custom-providers.md) · [Ollama 原生认证](https://docs.ollama.com/api/authentication)

**型号身份、承载规格与推荐是不同资料。** models.dev 的实验性 v2 把模型本体与服务商承载分开，继承共同信息、覆盖实际差异。原生 DeepSeek 列表已提供名称、窗口、输入模态和按协议划分的能力，Claude 还提供生命周期，字段仍可能缺省。推荐则由产品维护者选择依据和用途。2026-11-18 的公开快照显示，同一 Qwen 型号在不同端点有不同输出上限和工具声明，因此展示规格须对应实际服务商，缺失字段需要保留未知含义。该快照只证明端点公开声明，未验证调用成功率或实际输出能力。[models.dev 数据结构与校验](https://github.com/anomalyco/models.dev/blob/7b22cc903b46d459e83ec6420d702426f34f813c/README.md) · [DeepSeek 列表](https://api-docs.deepseek.com/api/list-models/) · [Claude 列表](https://platform.claude.com/docs/en/api/models/list) · [承载差异快照](../../collab/threads/20261118-model-provider-access-6f20/public-endpoint-observation.json)

**终端消费准备好的目录视图。** OpenClaw 让模型资料发布后供多个入口读取，刷新在后台进行。Hermes 的 `model_catalog.py` 管精选 manifest 的版本、缓存与更新，默认型号读取只查缓存。这样打开选择器可以先展示已有内容，维护者的网络刷新与用户选项读取各有节奏。按核读版本，OpenClaw 在启动后尝试刷新，默认检查间隔为六小时，Hermes 的默认缓存期为二十分钟，Pi 为四小时。联网可达且校验通过后，新资料才进入列表，OpenClaw 已打开的选择器可随发布更新，Hermes 后台取得的新列表在下次打开时呈现；断网或失败继续用缓存或随包基线。已支持兼容端也可手填 ID 补位。检查间隔不能当作送达保证。[Hermes 固定源码](https://github.com/NousResearch/hermes-agent/blob/0e8e42164063bf426af328ef94e2001dcaf9db1f/hermes_cli/model_catalog.py) · [OpenClaw 目录消费](https://docs.openclaw.ai/concepts/models) · [Pi 缓存刷新](https://github.com/earendil-works/pi/blob/e675a0d7f4150fcee66dabbbf890913f6aef9a8b/packages/coding-agent/src/core/remote-catalog-provider.ts)

### 同一次上新，维护者和用户各经历什么

设服务商已有 M1，后来发布同协议 M2，调整推荐，再停供 M1。用户原来选着 M1。以下按文档与实现推演同一变化，比较列表、推荐和既有选择的结果。

| 方案 | 维护者的动作与用户看到的结果 | 成立条件与代价 |
| --- | --- | --- |
| **OpenClaw 的完整目录与独立推荐** | 插件资料及获准上游数据进入独立发布。推荐单独审阅，再匹配各服务商实际型号。终端先列当前项和推荐，其余在完整列表中。去掉推荐不会同时删除可选型号或改写既有默认。 | 推荐与库存各有维护责任。旧型号被标记 deprecated 后通常隐藏，显式配置的当前项仍可呈现，用户需要区分“已选”和“仍可用”。 |
| **Hermes 的精选 manifest** | 维护者改 JSON 后随文档站发布，兼容客户端刷新精选项与默认标记。默认用于用户尚未明确选型的情况。 | 该机制当前明确用于 OpenRouter 和 Nous，价格窗口另取。精选退出本身不能证明服务商已停供。公开文件的只读观测确认了精选条目与默认标记。 |
| **OpenCode 的社区目录与用户覆盖** | models.dev 更新模型资料，客户端刷新并合入本地覆盖。用户能增加自定义型号或禁用条目，独立设置默认。 | 当前默认不可用时可选择最新可用支持型号，用户需要理解这种默认行为。未知自定义型号可能使用乐观的能力和容量假设，元数据准确性仍要核实。 |
| **Pi 的版本兼容目录与手填补位** | 发布与客户端兼容的目录，用户也可直接补入新 ID 和覆盖规格。 | 用户无需等目录收录就能表达选择，但需知道准确资料。合并目录时的一次遗漏不能独自证明型号退役。模型少、环境固定时，手工维护的成本可以更低。 |

以上各行的机制分别见对应一手材料。Hermes 的数量仅证明该时点公开名单，不代表实际服务可用性。三种不同的变化——退出推荐、从列表隐藏、服务商正式停供——必须按各自证据解释。[OpenClaw 推荐维护](https://docs.openclaw.ai/concepts/recommended-models) · [Hermes 发布方法](https://hermes-agent.nousresearch.com/docs/reference/model-catalog) · [本轮公开名单观测](../../collab/threads/20261118-model-provider-access-6f20/restart-catalog-observation.json) · [OpenCode 选项及覆盖](https://opencode.ai/docs/models) · [Pi 目录版本选择](https://github.com/earendil-works/pi/blob/e675a0d7f4150fcee66dabbbf890913f6aef9a8b/scripts/model-catalog-protocol.ts)

自定义端点也检验接入方案的边界。Pi 配置兼容 URL 与型号即可补选项，Ollama 路径仍需占位 Key；OpenClaw 的免密支持依适配而定，兼容代理还会抑制官方专用参数或头，避免把原厂专属行为直接带到其他服务。维护者需区分“协议已支持但资料未收录”与“适配尚未支持”，用户据此获得手填、修改参数或升级的明确路径。[OpenClaw 兼容规则](https://docs.openclaw.ai/concepts/model-providers/custom-providers.md)

### 终端体验中值得保留的做法

- **先找到服务商，再找到合适型号。** OpenClaw 在服务商下突出当前项与推荐，完整列表及搜索保留长尾选择。Pi 提供型号搜索与用户自选的快捷切换集合，LLM 提供按词搜索和别名。服务商少时直接全列更简单，目录大时精选与完整列表共同存在更容易使用。[OpenClaw 终端选择](https://docs.openclaw.ai/concepts/models) · [LLM 搜索与别名](https://llm.datasette.io/en/stable/usage.html)
- **清楚表示这次改了什么。** OpenClaw 添加服务商凭据时保留既有默认，用户另行决定是否选用新服务。Pi 的普通选择与显式保存新默认分开，OpenCode 的会话选择也不改配置默认。这为知行区分当前选用与用途默认提供成熟参考，若把添加服务商、刷新目录和改选合成一步，用户原来的成本与型号选择会被间接改动；分开这些动作保留了选择的可预期性。[OpenClaw 添加服务商规则](https://docs.openclaw.ai/concepts/model-providers/quick-rules.md) · [Pi 选择合同](https://github.com/earendil-works/pi/blob/e675a0d7f4150fcee66dabbbf890913f6aef9a8b/packages/coding-agent/docs/models.md)
- **给目录外选择一条完整入口。** Pi 的手工配置可补型号或覆盖既有元信息，OpenCode 同样支持用户条目，并说明未知模型的能力可能来自默认假设。用户可以录入准确 ID、所属服务商及必要规格。知行现有自定义 ID 入口可作为基础，自定义覆盖的移除也有区别。Pi 的覆盖附着于既有型号，OpenCode 可用 `disabled` 隐藏条目，移除一条本地配置仍可能重新露出上游目录项。因此编辑、移除用户条目与隐藏供应方条目需要各自明确的结果，不能只提供一个含义模糊的删除动作。[OpenCode 自定义选项](https://opencode.ai/docs/models)

列表还需要按用途筛选。Hermes 的 `chat_catalog.py` 识别明确的生图、生视频条目，未知信息保留；这一实现也含名称启发式，不能据此保证准确识别所有模型类型。知行可借鉴明确类型与未知状态分开处理，避免把未识别型号直接藏掉。[Hermes 类型过滤](https://github.com/NousResearch/hermes-agent/blob/0e8e42164063bf426af328ef94e2001dcaf9db1f/hermes_cli/chat_catalog.py)

思考等可选参数也属于选模体验。OpenCode 从具体型号的能力资料生成相应档位，用户可明确覆盖；Pi 只展示该型号支持的思考等级。Hermes 的切换实现还会按目标型号重新解析思考设置，源码注释记录了沿用旧档位造成错误的原因。其价值是让选择器与实际参数一致，维护者在已支持语义内更新资料即可调整选项。[OpenCode 参数选项](https://opencode.ai/docs/models) · [Hermes 参数重新解析](https://github.com/NousResearch/hermes-agent/blob/0e8e42164063bf426af328ef94e2001dcaf9db1f/hermes_cli/cli_model_switch_mixin.py#L33-L43)

### 维护更新的边界与可用于知行的认识

同一协议下的新型号也可能改变参数规则，例如 Claude 4.7 及以后拒绝旧式 `enabled + budget_tokens`。维护者须核对已有适配能否表达新规则，能表达时可更新资料及可选控件，缺实现时再交付适配代码。新协议、自定义认证同理。若用户已有受信网关，适配也可能由网关承担，代价是增加该服务的依赖。[原生参数变化](https://platform.claude.com/docs/en/build-with-claude/extended-thinking.md)

模型上新、规格修正、推荐调整通常可以走数据发布。**资料格式变化和新的适配行为要单独判断兼容性。** OpenClaw 发布端同时维护不同格式的目录，用已发布客户端检查候选数据是否被拒绝或丢行，失败保持上一版。错误数据若已被客户端接受，恢复旧内容时还要赋予新的发布代际，否则客户端可能忽略它。Pi 按最低客户端版本选兼容目录。两者都说明，独立更新需要兼容与恢复机制支撑。[OpenClaw 发布校验](https://github.com/openclaw/catalog/blob/beef19a982f76dece117876e971f1294db5ab008/scripts/released-readers.mjs) · [错误内容恢复](https://github.com/openclaw/catalog/blob/beef19a982f76dece117876e971f1294db5ab008/scripts/rollback.mjs)

**丰富的原生列表是独立目录的强竞争方案。** 若只接一家、原生列表已提供所需规格及推荐，缓存该列表就可能足够。面向多服务商时，字段缺省、推荐取向不同及自定义端点缺发现接口，才使受维护目录和手填覆盖有独立价值。隔离环境的固定小目录适合本地维护；组织已有统一网关时可只维护该接入点；专有协议变化快于宿主发版时，独立适配扩展更有价值。单协议专用产品也可集中维护一种协议，代价是减少可选服务商。

结合知行当前预设、界面注册、型号资料与用途推荐分散维护的现状，可以得到三个有依据的改善方向，具体设计留待第三部分审查。

| 改善谁的什么结果 | 依据、代价与检验方法 |
| --- | --- |
| **维护者增加支持后，用户能及时看到一致的选项** | Hermes 精选仅覆盖两家、规格另取，OpenClaw 独立目录只扩已安装服务商，说明供给仍有边界。知行应让服务商支持、型号资料与终端展示沿同一发布事实核对。复用兼容数据更新的成熟做法，代价是目录校验和版本维护。用“新增型号、修正规格、旧型号退役、坏更新恢复”分别检查维护者改什么、用户看到什么，确认已有选择得到明确解释。 |
| **用户能理解推荐并找到自己的选择** | OpenClaw 依据模型能力评价和人工判断更新推荐，Hermes 强调有能力的低成本默认，二者体现不同产品取向。知行的 main/light/power 有不同用途，推荐须说明用途和依据。检验推荐变化后用户是否仍能找到自己的型号、理解推荐原因、保持或修改用途默认。 |
| **用户减少猜测与手工查资料** | OpenCode 对未知型号的能力假设能省录入，却把准确性负担留给用户。知行可优先消费可靠的原生信息，用目录补充，允许明确覆盖并呈现未知。完整目录与当前选择都应保留可解释的来源。用同名不同承载、缺失能力字段、自定义型号、刷新失败四种材料核验，检查界面是否拼错规格、藏掉已有选择或把未知显示成确定支持。 |

这些是有证据支持的研究判断。成熟产品已经实现的选择与更新机制值得沿用，知行的实际改善幅度仍需后续实现和终端验证。

## 体系设计

> 设计与独立审查标准
>
> 1. **供给完整、选择有据。** 明确内置服务商、模型覆盖规则、自定义接入边界及按用途推荐的依据，纳入和排除均能对应需求与调研。向用户提供的选项须有真实适配与资料支撑，型号、服务商、能力和限制对应准确，未知信息如实表达。覆盖常用选择的同时，保留有依据的自定义选择途径。
> 2. **架构连贯、简单可靠。** 结合知行愿景、架构演进方向和生产代码，明确适配、目录、连接配置、凭据、用户选择与终端的职责、数据流和覆盖规则。保证凭据保护、配置正确性及已有配置的兼容或迁移。易变接入与稳定底座独立演进，同类变化尽量在所属职责内完成；每项新增机制都须说明必要性与维护代价，关键决定足以指导实现。
> 3. **终端体验完整且省心。** 查看、配置、选择、参数调整、编辑与移除均有具体交互和结果，当前选择、推荐、用途默认及不可用原因清楚可辨，失败后有可操作的修正路径。系统承担可可靠完成的资料获取与配置工作。用典型操作说明用户减少了哪些查找、判断、输入和重复步骤，同时保留查看完整列表与主动修改的控制权。
> 4. **维护更新闭环且省力。** 对新增服务商、型号上新、规格或推荐变化、模型退役、错误发布，分别写清维护者改什么、如何校验发布、用户何时感知、何时需要升级，以及旧版本、断网和失败时如何处理。在保证资料准确、更新可信和可恢复的前提下，让已支持能力内的变化尽量独立更新，明确减少哪些重复维护、跨层修改和整包发版工作。
> 5. **改进达到一流，取舍有据可验。** 与现状及调研中的适用强方案比较，说明所选方案在用户操作负担、供给维护成本和架构复杂度上的具体收益与代价，论证为何更适合知行。成熟优势须有据保留；能以更简单可靠的方式取得相同结果时，应采用该方式。每个主要改进均给出验收场景、预期结果和失败判据，覆盖正常使用及会推翻方案的关键边界。
>
> 五项中的基础义务与卓越性要求必须同时满足。双方独立审查同一版设计，分别记录需求对应关系、取舍依据和验收结果，再交换意见。任一项存在影响需求达成的实质缺口，就修正并复验相关部分。

本节为待实施设计。目标是以单一服务商与模型数据源、可独立更新的目录机制、清晰可控的终端交互，以及不侵扰核心底座的运行装配边界，贯通模型与服务商接入全链路——让用户常见接入少查资料、日常选模少改设置、供给维护少发整包。稳定底座（配置/秘密配对保存、设备本地 `SecretStore`、会话权威与智能执行内核）继续沿用，变化收敛在接入资料、受控协议适配与模型装配端口。

---

### 1. 供给范围、协议边界与用途推荐

#### 1.1 协议范围与一手依据

本轮锁定四类受控协议作为完整供给目标；获准实现后可按协议分步编码验收以控制交付风险，但不因分步交付而削减最终供给承诺：

| 协议标识 | 适用范围与核心依据 | 适配要求与边界 |
| --- | --- | --- |
| `openai-compatible` | DeepSeek、通义千问、Kimi、智谱 GLM、MiniMax、硅基流动、OpenRouter、Ollama 及 vLLM / LM Studio / SGLang / 私有兼容网关 | 补齐 DeepSeek、千问、GLM、Kimi 的思考与 usage 方言；聚合与自定义兼容端不盲传原厂专属参数或认证头 |
| `openai-responses` | OpenAI 官方直连及兼容 Responses 的端点。[OpenAI 最新模型指南](https://developers.openai.com/api/docs/guides/latest-model) 与 [迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses) 明确自 GPT-6 Astra / GPT-6.1 Sol / GPT-6.2 Astra & Sol 起，工具调用要求 Responses 接口；仅留 Chat Completions 会缩减主流旗舰可用性 | 采用无状态调用（`store: false`），需要保留推理上下文时显式请求 `include: ["reasoning.encrypted_content"]`，保持客户端权威历史与零服务端留存兼容；并按 [前缀保持指南](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged.md) 通过第 5.6 节的窄发送视图投影维护工具往返前缀稳定 |
| `anthropic-messages` | Anthropic 官方直连及兼容 Messages 的端点。[Anthropic 扩展思考文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking.md) 明确 Claude 4.7+ 弃用旧式 `enabled + budget_tokens` | 保留既有 `budget_tokens` 与签名回传，按型号支持 `adaptive` / `effort` 思考形态 |
| `google-interactions` | Google Gemini 官方原生接入。[Google Interactions 概览](https://aistudio.google.com/docs/interactions-overview) 与 [无状态思考文档](https://aistudio.google.com/docs/thinking#stateless-mode) 确认 Interactions 已 GA 并为新接入推荐标准，支持 `store: false` 无状态调用，且将思考与签名隔离于独立 `thought` step | 展示实际支持型号与参数。**生态取舍**：仅实现旧 `generateContent` 的第三方代理不属于 Interactions，应按其实际支持的 OpenAI 兼容协议接入，不可误标为 `google-interactions` |

新协议或新参数执行语义仍通过受控适配代码交付，不通过目录脚本或运行期动态装包生成未实现行为。[现行适配边界](../modules/providers/architecture.md)

#### 1.2 纳入与排除边界

- **内置预设（11 项）**：覆盖现有后端已登记的 8 家，并补齐 OpenRouter（多厂商聚合）、Google Gemini（主流原生）与 Ollama（本机免密），统一由单一数据源供给后端解析与终端展示，消除“后端 8 家、终端仅 2 家”的分裂。
- **自定义兼容入口**：xAI、Groq、Mistral、Together、vLLM、LM Studio、SGLang 及私有兼容网关均由上述受控协议覆盖，通过自定义连接填入名称、端点、协议与认证即可接入，不为穷举厂商无限扩充预设表。
- **本轮明确排除**：云平台 IAM / STS 签名体系（AWS Bedrock、Google Vertex AI、Azure AD / Managed Identity）及需要托管平台账号流的 OAuth 桥接。原因：知行是运行在用户自有设备上的个人智能体，无平台账号体系，凭据归属本机 `SecretStore`；云 IAM 与 OAuth 涉及独立签名或会话刷新生命周期，超出当前 API Key / 自定义认证头 / 免密边界，确有需求另立专题评估。

#### 1.3 首批 11 项预设接入、发现与过滤合同

下列默认端点模板明确区分**兼容基路径相对拼接（`<baseUrl>/...`）**与**来源根路径拼接（`<origin>/...`）**；仅将经官方文档核实的发现接口声明为原生发现，未核实或因套餐/地域差异不保证存在的端点保留为可选兼容探测并默认依赖策展基线与手填（404/405 均按第 3.3 节公开反馈“不支持列表发现，未验证凭据”，不以静默回落冒充已验证能力）：

| 预设 | 连接模板与默认协议/方言 | 认证形态 | 发现器、URL 拼接基准与可证字段边界 |
| --- | --- | --- | --- |
| **DeepSeek** | `https://api.deepseek.com`；`openai-compatible`（`deepseek` 方言） | `Bearer` Key | 原生列表 `<baseUrl>/models`（[官方文档](https://api-docs.deepseek.com/api/list-models/)）；可证可用 ID 及接口返回的部分窗口/模态/能力字段，缺省由策展补齐 |
| **通义千问（百炼）** | 兼容推理 `https://dashscope.aliyuncs.com/compatible-mode/v1`（按量/Token Plan/Coding Plan 须与对应地域域名及 Key 配套，[通用接入](https://help.aliyun.com/zh/model-studio/use-chat-client-or-development-tool/)）；`openai-compatible`（`qwen` 方言） | `Bearer` Key | 已核实百炼业务空间/地域原生列表为来源根路径 `<origin>/api/v1/models`（含分页及 `capabilities`/`features`，[原生列表](https://help.aliyun.com/zh/model-studio/list-models)）；兼容路径 `/models` 不按全部国内外/套餐域泛化，未匹配已核实原生域时默认用策展基线 + 手填并保留可选兼容探测 |
| **Kimi（Moonshot）** | `https://api.moonshot.cn/v1`（国际 `https://api.moonshot.ai/v1`）；`openai-compatible`（`kimi` 方言） | `Bearer` Key | 原生列表 `<baseUrl>/models`（[官方文档](https://platform.moonshot.ai/docs/api/chat#list-models)）；可证可用 ID 及接口返回的上下文长度/视觉/推理能力字段，缺省留未知或由策展补齐 |
| **智谱 GLM** | `https://open.bigmodel.cn/api/paas/v4`（国际 `https://api.z.ai/api/paas/v4`）；`openai-compatible`（`glm` 方言） | `Bearer` Key | 公开文档未稳定承诺通用 REST 模型列表；默认用策展基线 + 手填，仅允许可选兼容探测 `<baseUrl>/models` |
| **MiniMax** | `https://api.minimax.chat/v1`（及对应地区/套餐域）；`openai-compatible`（保守方言） | `Bearer` Key | 公开兼容文档仅证实对话与参数接口，未证实通用模型列表（[兼容文档](https://platform.minimax.io/docs/api-reference/text-openai-api)）；默认用策展基线 + 手填，仅允许可选兼容探测 `<baseUrl>/models` |
| **OpenAI** | `https://api.openai.com/v1`；默认 `openai-responses`（可选 `openai-compatible`） | `Bearer` Key | 原生列表 `<baseUrl>/models`（[官方文档](https://platform.openai.com/docs/api-reference/models/list)）；仅可证可用 ID，容量、能力与参数规则以策展源核验为准 |
| **Anthropic** | `https://api.anthropic.com`；`anthropic-messages`（`anthropic` 方言） | `x-api-key` + `anthropic-version` | 原生列表 `<origin>/v1/models`（[官方文档](https://platform.claude.com/docs/en/api/models/list)）；可证精确 ID、显示名及官方声明的生命周期/能力字段，缺省保留未知 |
| **硅基流动** | `https://api.siliconflow.cn/v1`（国际 `https://api.siliconflow.com/v1`）；`openai-compatible`（不继承直连 cache 方言） | `Bearer` Key | 原生列表 `<baseUrl>/models`（支持 `type`/`sub_type` 查询筛选，[文档入口](https://docs.siliconflow.cn)）；按承载端精确 ID 展示，缺省规格以策展补齐或标未知 |
| **OpenRouter** | `https://openrouter.ai/api/v1`；`openai-compatible`（聚合端保守方言） | `Bearer` Key | 原生列表 `<baseUrl>/models`（支持 `output_modalities`，[文档入口](https://openrouter.ai/docs)）；返回承载端精确 ID、上下文长度、价格、模态与支持参数（第三方声明归资料层，不作硬约束） |
| **Google Gemini** | `https://generativelanguage.googleapis.com`；`google-interactions`（`store: false`） | `x-goog-api-key` | 原生列表 `<origin>/v1beta/models`（[官方文档](https://ai.google.dev/api/models)）；可证型号 ID、输入/输出 token 上限与支持方法，Interactions 适用型号与参数规则以策展源核对 |
| **Ollama** | 本机默认 `http://127.0.0.1:11434`（兼容推理 `<origin>/v1`）；`openai-compatible`（本机默认直连） | 默认免密，可选 `Bearer`/自定义头 | 原生列表 `<origin>/api/tags` + 按需 `POST <origin>/api/show`（[官方文档](https://docs.ollama.com/api/tags)）获取本地已拉取型号、上下文与能力声明；自定义兼容端亦可探测 `<baseUrl>/models` |

- **首批基线与非对话过滤规则**：第一版随包基线为每家提供经核验的对话型号、必要规格、参数说明与配置帮助链接（API Key / 型号列表页）。对话选择器**只过滤满足明确结构化断言的非对话条目**——即原生接口明确声明 `output_modalities` / `type` / `supportedGenerationMethods` 仅属 embedding、rerank、tts、image-only、video-only、moderation 等非对话用途，或策展源显式标注 `purpose !== "chat"`。未携带明确用途字段的发现型号与自定义型号一律保留在完整列表中并标明“资料不足/未知”，**禁止靠模型名称关键字启发式隐藏条目**。

#### 1.4 用途推荐与目录解耦

推荐独立于目录维护，每条记录 `role`（`main` / `light` / `power`）、`presetId`、精确 `modelId`、推荐理由、证据来源、核验日期与替换理由：`main` 侧重综合能力与稳定工具调用，`light` 侧重辅助摘要/轻任务的成本与响应，`power` 侧重复杂工作场景。仅在有证据支持且匹配当前连接或预设候选时展示推荐标记；缺少推荐不裁减可选范围，推荐更新绝不改写用户已保存的任何选择。

---

### 2. 核心架构、数据契约与跨协议投影

#### 2.1 职责归属边界

| 模块 / 权威 | 唯一职责 | 明确不拥有 |
| --- | --- | --- |
| `@zhixing-ai/providers` | 服务商预设、策展目录校验与合成、原生发现、受控单跳网络传输、四类协议适配、配置/秘密配对保存与迁移 | 会话权威、业务重试循环、终端渲染 |
| `@zhixing-ai/core` | `LLMProvider` 窄合同、消息/流事件有界推理状态字段、结构化选模意图、能力/预算窄类型 | 具体厂商 SDK、目录分发、配置文件路径 |
| CLI 组合根（`PersistentApplicationHost`） | 构造并持有单一的**模型运行态应用端口（`ModelRuntimePort`）**，统一执行保存后修订激活并向消费者发放不可变修订快照/租用绑定 | 运行期服务定位器（Kernel 不回查宿主） |
| Config / Secret owner | 公开 `config.jsonc` 与本机加密 `SecretStore` 的配对保存、前滚恢复、旧版迁移、秘密耐久清退与显式撤权状态 | 终端页面状态、业务会话状态机 |
| Session owner | 保存会话“跟随默认”或结构化选模覆盖，提交权威转录（含协议推理状态原样保真） | 密钥读写、连接定义 |
| 终端（S / N / U） | `/config` 与 `/model` 交互呈现、无宿主首配本地执行、N 进程隔离草稿秘密与草稿发现/验证 | 持久化第二权威、明文秘密跨普通 RPC 传递 |

**供给层与用途层边界。** 底层提供服务商连接、模型目录与调用能力；上层 `main`（主力）、`light`（轻量）、`power`（强力）按用途绑定连接和型号。用途层单向引用供给层，连接不携带用途或推荐；物理同包不改变这一分层。实施遵循[角色合同](../modules/providers/model-roles.md)：

- **必填与回退**：运行时 `main` 必填；`light / power` 可选，缺省沿用 `main`，显式配置解析错误时告警回退 `main`。这不包含网络请求失败后的自动换模。
- **独立配置**：三用途均可独立绑定连接、型号与参数，支持使用同一或不同服务商。
- **默认稳定**：新增连接、推荐更新及本会话临时覆盖不改写三用途默认。
- **迁移与删除**：按第 5.5 节将旧 `provider` 引用迁至 `connectionId`；删除 `main` 引用的连接须同次改绑，`light / power` 的对应引用可改绑或清除配置后沿用 `main`。

#### 2.2 跨层最小结构契约与不变量

1. **公开配置 `llm`（`schemaVersion = 2`）**：
   ```text
   llm: {
     schemaVersion: 2,
     connections: Record<ConnectionId, {
       name: string,
       presetId?: string, presetRevision?: string, ignoredPresetRevision?: string,
       adapter: "openai-compatible" | "openai-responses" | "anthropic-messages" | "google-interactions",
       endpoint: string,                                // 创建时固定已确认 HTTP(S) URL
       auth: { mode: "none" }
           | { mode: "api-key", secretRef: LogicalCredentialId }
           | { mode: "header", headerName: string, secretRef: LogicalCredentialId },
       network: { proxy: "inherit" | "direct", allowPrivateOrigin?: boolean },
       dialect?: { thinking?: ThinkingDialect, usage?: UsageDialect },
       customModels?: string[],
       modelOverrides?: Record<ModelId, ModelSpecOverride>, // 按精确 modelId 存物理容量/能力覆盖
       hiddenModels?: ModelId[]
     }>,
     main?: RoleSelection,                              // 生效运行必填，初始空模板可缺省直至首配保存；{ connectionId, model, params?, maxOutputPreference? }
     light?: RoleSelection,
     power?: RoleSelection,
     attentionPolicies?: Record<NormalizedModelKey, AttentionThresholds>, // 吸收旧 modelCapabilityOverrides
     migrationPending?: MigrationPendingItem[]          // 仅存未归属的非秘密旧覆盖，绝不存秘密或未确认 URL
   }
   ```
   - **连接固定不变量**：即使用预设创建，也落盘完整 `endpoint / adapter / auth`。预设后续改地址仅生成可查看更新建议，由用户明确采纳，绝不静默改写已有连接或挪用既有密钥；新增预设不自动创建用户连接。模型 ID 原样发送，显示名和搜索别名不改写身份。
   - **完整提交不变量**：编辑器提交完整 `llm` 段，省略某 `connectionId` 即表达删除意图；迁移写入器显式删除已收口的旧根级 `modelCapabilityOverrides`，不依赖省略字段删除。

2. **设备秘密记录（`SecretStore`）**：
   - 凭据值采用封闭形状 `{ v: 2, kind: "api-key" | "header", value: string }`；公开配置仅引用稳定逻辑凭据 ID，由 Secret owner 经活动 `MANIFEST_REF` 解析物理代际，其他凭据保存不使连接引用失效。
   - `MANIFEST_REF` 写入固定 `modelConfigVersion: 2`（含纯免密或凭据为空/未变场景，后续仅编辑 MCP/通道的轮换亦必须保留）；涉及 v2 的配对保存与迁移计划使用 `SavedEdit.v = 2`，阻止旧程序 `parseEdit`（仅认 `v === 1`）与旧 `parseManifest`（拒绝未知字段）误读或抹除新配置。
   - 固定管理记录 `configuration/model-retirements/v1` 存 `pendingSecretRetirements`（`operationId / connectionId / secretRef / mode: "retire" | "revoke" / sourceRevision`），由 `CredentialExposureAuthority` 豁免外部凭据就绪分类但保留管理权限保护，禁止被 `secretRef` 引用为模型密钥。

3. **策展目录、参数语义与能力门控**：
   - 目录包最小形状：`{ schemaVersion, catalogRevision, minCapabilities, presets[], models[], recommendations[] }`；未知可选说明字段可被旧端忽略，单条目声明本地未实现的 `requiredCapabilities` 时仅将该条目标为“需升级知行”，不整包作废。
   - 参数控件与目录仅引用本地适配器已注册的语义 ID 与控件形态（如 `thinking.toggle`、`thinking.effort`、`thinking.budget`、`output.maxTokensPreference`），区分 `auto/default` 与显式 `off`；新增已支持语义下的合法枚举可通过数据更新，新增控制语义必须由程序适配提供；目录和用户覆盖均不得注入任意请求字段路径或脚本。

4. **硬约束 → 资料 → 偏好三层覆盖规则**：
   - **硬约束（不可突破）**：本地适配能力、安全/认证边界、协议不变量，以及适用于当前连接且有权威原生信息或明确服务端证据确认的硬上限/否定能力。用户覆盖不能突破硬约束；冲突时保留用户输入与当前有效选择，展示冲突来源，提供刷新核实或选用更保守值的路径。
   - **资料（按字段独立合成，缺省不抹除已有值，`false` 保留否定含义）**：用户显式规格覆盖 → 当前连接有效原生字段（第三方兼容端未经核实声明归资料层，可修正并标冲突）→ 兼容已验证策展资料 → 随包基线 → 带来源的保守兜底或未知。注意力经验阈值、请求输出偏好与模型物理容量分键保存。
   - **偏好**：隐藏型号、常用选择与默认绑定独立保存，不受上游目录刷新覆盖。
   - **发现缓存隔离**：原生发现缓存按 `connectionId + endpoint + adapter + credentialRevision` 隔离；改地址或换凭据后废弃旧发现，兼容端改地址时原厂特有能力须重新核对。

#### 2.3 跨协议、跨连接与跨型号历史投影策略

严格分离三类历史内容：**用户输入材料**（文本、图片、文件引用）、**已提交可见事实**（助手文本、`tool_use`、`tool_result`）、**厂商协议私有推理状态**。会话权威历史原样耐久保留；`@zhixing-ai/core` 在 `ThinkingBlock` 上承载可选有界 `protocolState`（`{ protocol, sourceConnectionId, sourceOriginKey, sourceModel, payloadVersion, signature? | encryptedContent? | opaqueStep? }`），其中 `sourceOriginKey` 为足以辨别端点（origin + basePath）或适配变更的非秘密来源指纹。流事件与投影校验封闭检查大小和形状；**来源不明的旧记录一律按“来源不同”处理，绝不猜造签名或冒充同来源**。

发送投影**先核对同一可信来源（`sourceConnectionId` 与 `sourceOriginKey` 一致，或命中具体端点合同明文确认的兼容签名域），再判断协议与型号**；转换仅作用于请求发送前的适配器投影层：

| 切换场景 | 已结算普通轮次的推理状态 | 未完成工具往返内的推理状态 | 用户材料与不可满足合同时的处理 |
| --- | --- | --- | --- |
| **同来源同协议同型号** | 按协议合同保真重传（Anthropic `thinking+signature`、OpenAI Responses `reasoning.encrypted_content`、Google Interactions `thought` step、`openai-compatible` 匹配方言的 `reasoning_content`） | 严格保真重传；OpenAI Responses 经第 5.6 节窄发送视图与版本化指令投影保持同一窗口代际内工具往返前缀不变（确遇压缩/重建等真实前缀边界时按合法新代际处理，不伪造保真） | 目标不支持已有必要材料（如图片）时，切模/发送前明示不兼容原因，保留原选择与草稿，提供改选或开新对话 |
| **同来源同协议换型号** | Google Interactions 无状态模式按官方文档重传历史 `thought` step 由服务端处理兼容；Anthropic 仅重传有效签名块，无签名旧块按既有合同降级或省略；`openai-compatible` 仅当目标连接方言支持 `reasoning_content` 时发送，否则省略该私有字段（修补现行无条件发送问题） | 优先保真重传；若目标型号明确拒绝原型号签名或加密推理项且无法安全省略，则不强发 400 请求，明确提示改回原型号或开启新对话 | 同上 |
| **跨连接 / 同连接改址换适配 / 跨协议 / 来源不明旧记录** | **默认绝不转发私有推理载荷**（即使线协议与型号名相同，也不把官方连接 A 的加密推理项或签名发往兼容网关 B，或改址后的同连接 ID）；绝不伪造签名，绝不将加密或不透明载荷转为普通用户文本；仅投影已提交可见文本与工具调用/结果事实，**允许继续同一对话** | 若当前回合正处工具结果待回传阶段且目标端点强制要求原来源私有推理签名（无法合法投影），则阻断切换，保留原选择与草稿，提示完成当前工具回合、改回原连接/型号或开新对话 | 同上；绝不静默删除用户材料或旁路改写权威转录 |

---

### 3. 终端体验：首配、日常选模与纠错闭环

#### 3.1 入口分工与首次引导流转

- **`/config` 模型页**统一组织为三块：**服务商连接**、**用途默认（`main / light / power`）**、**模型资料与更新**。
- **首次引导与常规添加连接的默认绑定区分**：
  - **首次引导（确实缺失 `main` 配置时复用模型页）**：选内置预设（或自定义/本地 Ollama）→ 录入必要凭据（免密跳过密钥）→ 自动/手选或手填型号及合法参数 → **点击“完成”在同次保存中自动将该连接与所选模型绑定为 `main` 默认**（`light` / `power` 缺省沿用 `main`，无需跳页二次绑定；需要独立配置辅助用途时可在同页展开显式指定）。初始 `config.jsonc` 模板仅含说明与未配置态，不预写生效连接；取消不提交任何草稿。
  - **常规 `/config` 新增或修改连接（已有 `main` 配置）**：完成仅保存连接本身，**保持既有 `main / light / power` 默认不变**；改绑用途默认始终是独立的显式动作。
- **`/model` 日常入口**：承担总览、搜索、本对话选模与原位调参。顶部总览同步展示**当前会话生效模型**（连接、精确型号、当前参数与来源：`跟随 main` / `跟随工作场景 power` / `本会话覆盖`）以及 **`main / light / power` 三用途默认及跟随状态**；展开详情查看窗口容量、输入能力、价格口径与数据来源。
- **非交互与状态面一致**：非交互文本入口保留 `/model` 只读展示（同源输出当前生效选择、用途默认与状态，并给出交互配置路径）；`ReplLocalView`、`/status` 与 `/model` 消费同一生效投影，消除仅读启动期 `main` 配置的漂移。

#### 3.2 高频操作与用户减负

| 用户要做的事 | 具体交互、作用域与结果 | 相比现状减少的负担 |
| --- | --- | --- |
| 配置常用服务商 | 选预设 → 专用输入必要凭据（带直达申请/文档链接）→ 发现列表或从基线/手填选型号 → 保存连接；**仅在无 `main` 的首次引导中同次自动绑定主用途**，常规新增或修改连接保留既有用途默认，另由显式动作改绑默认 | 11 家预设共用统一入口，省去查地址/协议/方言和跨文件补登记，且新增备用连接不暗改既有默认 |
| 配置本地或自定义服务 | Ollama 自动探测本机型号且默认免密；自定义填连接名、协议、地址与认证（显式免密跳过密钥），无列表接口仍可选目录或手填精确 ID | 省去假 Key，目录未收录或网关禁列表接口时仍有闭环路径 |
| 日常查找与切模 | `/model` 按连接分组，当前项与适用推荐置顶，其余入完整列表；支持按名/ID/服务商搜索。普通确认**仅改当前对话主角色**；独立显式动作“设为用途默认（可选 `main/light/power`，普通对话默认聚焦 `main`、工作场景聚焦 `power`）”与“恢复跟随默认” | 省去进全局配置再改回的往返，且不暗改全局默认与其他用途 |
| 不换模型原位调参 / 换模重算参数 | 在 `/model` 顶部当前项（或已选条目）直接进入该模型的原生参数控件，明确选择作用域（**仅本会话**或**写入对应用途默认**）；换型号时按新型号合法枚举/范围重建控件，旧不兼容值说明原因并由用户确认新值或采用默认 | 不必重走选模流程即可调思考档位；免记厂商参数，杜绝旧档位残留 |
| 增改、覆盖恢复、隐藏与取消隐藏 | 自定义型号支持增改删；规格覆盖支持编辑与删除（删除前明示将恢复的上游来源与具体值）；供应方型号可独立“隐藏”（刷新不复活），在连接详情页与 `/model` 末尾提供**“已隐藏型号（N）”折叠入口**支持查看并一键“恢复显示” | 消除只增不减；用户清楚区分删自建、删覆盖与隐藏/恢复三种终态 |
| 删除连接与更新排障 | 删除连接先列出受影响的用途默认、活动会话、未完任务与在途运行（必需默认须同次改绑，在途由用户选等待结算或立即取消）；资料区显示来源、修订、检查时间与状态，提供立即刷新与自动检查开关；后台刷新保搜索词、焦点与当前选择，保存/刷新/生效分别反馈 | 避免误删断链；每一步成败可定位并从同一入口修正 |

#### 3.3 接入前发现、验证与错误分态反馈

在连接编辑页填完合法地址与必要凭据（或点击“刷新列表”、或进入免密本地预设如 Ollama）时，由编辑进程 N 自动触发一次只读原生发现；输入变更或取消立即 `abort` 并按草稿修订丢弃过时结果。严格区分**“已发现 / 可选 / 已保存 / 已验证”**四态：

| 探测结果 | 对候选列表的影响 | 对保存的影响 | 状态标识与修正路径 |
| --- | --- | --- | --- |
| 发现成功（非空 / 空列表） | 合并该连接候选（空列表明示“接口可达但返回空”，保留手填） | 允许保存 | 标为“列表接口可达”（不冒充已验证具体型号生成可用） |
| `404` / `405`（无列表接口） | 回落策展目录 + 手填精确 ID | **不阻止保存** | 标为“不支持列表发现，未验证凭据”，提供可选生成验证 |
| `401`（鉴权拒绝） | 保留目录/手填以防误判；**高亮警示凭据被拒绝** | 默认提示先修正；允许显式二次确认“先存待修”以免丢输入（不以在线成功阻塞本地配置保存，但连接标为“鉴权失败/待核对”，绝不冒充已验证） | 提供重填 Key、核对认证头或改地址入口，下次进入模型页持续提示 |
| `403`（权限/地区/网关拒绝） | 按结构化错误展示具体原因，不一律归为 Key 错 | 保留输入并可按确认保存，标为“受限/待确认” | 提供改选型号、检查配额/权限或切换代理策略入口 |
| 超时 / DNS / SSRF 拦截 | 显示脱敏目标、代理路线与原因，不清空已有目录 | 允许离线保存草稿，标为“连通未确认” | 提供切代理（`inherit/direct`）、确认私网许可或重试 |

- **可选生成式验证**：完全自愿，触发前说明发送内容、可能费用及仅证明本次生成可达；采用该型号合法参数（禁止固定 `max_tokens: 1` 探针），可随时取消。

#### 3.4 四类管理与修复闭环入口

1. **预设地址/协议更新建议**：预设变更官方地址或建议协议时，在 `/config` 模型页顶部与对应连接旁出现“预设更新建议”标记；进入并排对比**当前连接固定值 vs 预设建议值**，提供“采纳并重新发现（随本次保存生效）”或“忽略此修订”，绝不静默变更既有端点。
2. **迁移修复确认（`llm.migrationPending` 与未确认公开性质旧自定义地址）**：当旧版迁移产生待确认项，或旧 `SecretStore` 含无法自动确认公开性质的自定义 `baseUrl`/敏感字段阻止自动公开迁移时，在 `/config` 模型页顶部与启动异常提示中提供**“迁移修复待处理”专用入口**；在受保护编辑面逐项展示脱敏后的旧来源、未自动公开原因与处置选项（确认公开地址 / 改填新地址 / 确认或舍弃未归属旧覆盖），确认后同次保存收口，取消则完整保留原受保护记录与待处理态。
3. **封禁凭据（`compromised`）轮换**：连接页将该凭据显示为“已封禁 · 存在但不可读取（请录入新密钥轮换）”，不伪装为未填；保存新密钥后分别反馈“保存成功”与“轮换校验及解封结果”，校验未通过保留待验证状态、脱敏原因与重试/再换入口。
4. **不可用当前项保留**：已配但缺凭据、停供或需升级的当前项在 `/model` 与 `/config` 仍可见并解释原因与修正动作，不静默消失。

---

### 4. 维护更新与可信分发

#### 4.1 单一策展源、少人力生产流与兼容规约

- **单一策展源**：现有 `presets.ts`、`role-recommendations.ts`、`model-capability.ts` 与终端服务商注册表统一转为同一策展源的生成或解析消费者，消除四处手工同步。
- **可审核的资料生产流**：维护流水线优先定时或按需拉取可靠官方列表 API 与获准上游数据，生成**附字段来源与差异摘要的可审 diff**，经维护者人工复核后发布；无可靠机器来源的服务商与字段允许有证据的人工维护（不为 11 家分别建设易碎爬虫）。**事实目录修订与用途推荐复评按各自证据独立触发**，可共享原子发布修订，事实更新绝不顺带改动推荐或用户默认。
- **兼容通道与退出条件**：官方静态仓库按主 `catalogSchemaVersion` 维护发布通道，客户端按自身支持的最高 schema 与能力集合选取通道。同一 schema 内仅追加可选字段与已注册语义下的合法枚举。停止某旧兼容通道须满足三步可执行条件：① 发布说明明示最低支持版本与过渡窗口；② 在原通道最后修订写入可识别的升级提示；③ 过渡期满后再停止更新（旧端停更后仍可安全使用本地缓存或随包基线）。
- **六类外部变化全链路**：

| 变化类型 | 维护者动作与校验发布 | 用户感知与升级边界 |
| --- | --- | --- |
| 新增兼容服务商 | 补预设及基线资料，校验既有协议/认证/发现/UI 字段与旧端兼容夹具后发数据修订 | 刷新后可在新增连接时选用并确认地址/凭据；已有协议足够时无需程序发版 |
| 型号上新 | 核对精确 ID、承载规格与参数条件，更新目录（按需另评推荐），发兼容修订 | 新型号进入候选由用户自选；未收录可手填；需新适配语义时局部提示升级 |
| 规格或推荐变化 | 改对应字段、来源与推荐/替换理由，校验参数组合合法性后发布 | 详情、控件与推荐区更新，既有选择与默认不变；设置与新硬约束冲突时给修正入口 |
| 弃用或正式停供 | 依权威依据分别标注 `deprecated` / `retired` 与替代建议 | 弃用项默认折叠且当前项仍可见；停供项禁新选、旧选择保留原因与改选入口；单次发现缺席仅作观察 |
| 新协议、认证或参数语义 | 交付受控适配代码与能力声明、发新版程序，同时继续维护旧端兼容通道 | 旧端看到具体升级原因，单靠数据更新不虚构未实现行为 |
| 错误内容发布 | 保留正确历史内容，以更高修订号重新发布，走完整验签与兼容校验 | 已接纳坏数据的客户端获取修复修订；曾校验失败的客户端保持原完整快照 |

- **客户端刷新与单写约束**：启动优先用本地已接纳完整资料，后台默认每 6 小时检查一次（打开模型页且超时触发、支持立即刷新与关闭自动检查）；原生连接列表默认缓存 15 分钟（保存后、显式刷新或过期重查）。运行期由宿主协调器合并重复操作，关闭页面不中断已接纳操作；无宿主首配由编辑进程 N 承担本地刷新，取消或退出停止操作并释放锁。所有进程共用同一跨进程文件锁与耐久目录，持锁重读当前修订；下载与候选准备不阻塞列表，原子激活后各入口读同一修订；断网、失败或关自动检查均可继续使用既有资料并明示时间与状态。

#### 4.2 可信更新方案同条件对比与定案

远端目录虽不含可执行代码，仍直接影响新连接预设、容量/价格判断、参数控件与停供提示，在不可信镜像/CDN 上须满足四项安全保证：**来源真实与完整性、离线根轮换与在线密钥撤销、防回滚、在线防冻结**，同时遵守项目 `Node >= 24.0.0` 基线、受控网络出口、原始字节崩溃原子性与 `pnpm package:check` 干净打包门禁。以下在同一条件集下比较全部候选：

| 候选方案 | 四项安全保证 | Node `>=24.0.0` 与受控网络 | 崩溃原子性与打包改造代价 | 全寿命维护代价与风险 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A. `tuf-js@5.0.1` 受限四角色 + 外包校验 + 窄存储补丁内联** | 完整满足（标准 TUF 1.0.37；外包补齐 5.0.1 后续修复的严格 RFC 3339、独立 Ed25519、无委托） | 兼容 `>=24.0.0`（[6.0.2](https://raw.githubusercontent.com/theupdateframework/tuf-js/tuf-js@6.0.2/packages/client/package.json) 要求 `^24.15.0` 不覆盖 `24.0–24.14`）；支持注入受控 `Fetcher` | 仅对 `updater.ts` 持久化点打锁定窄补丁（接入拟从 `writeJsonAtomic` 抽取的 `writeBytesAtomic`），每轮新建 `Updater`，内联进 `@zhixing-ai/providers/dist` 并审计许可证 | 由上游持续维护的标准 TUF 客户端承担核心协议状态机（项目仍须对自身封装与窄补丁做完整一致性与安全验证，不将上游声誉冒充为独立审计背书）；需维护四角色周期续签 CI，待**同时满足**“项目最低 Node 升至上游兼容范围**且**上游提供可插拔异步持久化接口”时迁回无补丁上游版（已核读 `6.0.2` 仍直接写文件） | **选定（当前条件综合最优）** |
| **B. `@freedomofpress/tuf-browser@0.2.0`** | README 明示**未经独立安全审计**、缺自定义下载限制 | Node `>=20.19`，但 `src/tuf.ts:90` 直接调全局 `fetch`，无受控网络注入口 | 有异步 `FileBackend`，但须反向补丁网络与字节上限 | 早期 0.2.0 且未审计，“零依赖”文案与 `crypto-browser` 不一致 | **排除**（[仓库证据](https://github.com/freedomofpress/tuf-browser)） |
| **C. 自建受限 TUF / 根轮换硬过期校验器（Node `node:crypto`）** | 理论上可等价实现单仓库无委托子集 | 原生兼容 `>=24.0.0` 与受控网络 | 零三方打包与补丁，直接用 `writeBytesAtomic` | 须永久自维护安全关键协议状态机（规范化 JSON 验签、连续根轮换双阈值、重复 keyid、过期顺序、防回滚、崩溃恢复及 TUF 一致性向量），且硬抗冻结仍需周期续签 CI | **不选**：省掉单点窄补丁却背负整套自写加密协议安全维护债，净风险更高 |
| **D. 无周期续签的轻量 Ed25519 签名清单（单调修订 + 软过期）** | **不满足硬抗冻结**：防篡改与低于本地版本回滚，但无法拒绝镜像长期重放旧版合法清单 | 原生兼容 `>=24.0.0` 与受控网络 | 零三方打包与补丁 | 省去定时续签 CI，但离线根轮换与在线撤销仍需自维协议 | **仅作降级对照底线，不作默认**：不得把降低防冻结保证包装成等价简化 |

- **定案执行边界**：采用 **候选 A**（标准 [TUF 1.0.37](https://theupdateframework.github.io/specification/v1.0.37/) 单官方仓库、无委托四角色配置）。官方静态仓库 metadata/targets 地址与初始根随包绑定，首版须从真实部署地址走通获取、验签与恢复验收；发布流水线到期前周期续签信任元数据（不虚改模型核验日期），续签失败仅阻止接纳新候选，不影响本地已有资料使用。封装边界对缓存与网络元数据均校验严格 RFC 3339 期限、支持角色与独立 Ed25519 公钥，拒绝委托与其他签名方案（非法形状/日期前置拒绝，过期判断留给 TUF 对应阶段以支持从过期旧根连续轮换到合法新根）；目录恢复只回退目标内容，绝不倒退已接纳信任根和版本。
- **原始字节耐久与仓外交付门禁**：从现有 `packages/providers/src/internal/io.ts` 的 `writeJsonAtomic` 抽取 `writeBytesAtomic`（复用临时文件、fsync、rename、目录同步）保存原始 TUF Buffer 且不重序列化，`JSON` 写复用该原语；每轮刷新预载已校验元数据新建 `Updater` 并在结束后丢弃，每个持久化点必须 `await` 耐久提交，失败重试先恢复重读，目标包先下载至隔离候选路径验毕再原子激活。补丁版 TUF 客户端及相关受限实现**显式内联到 `@zhixing-ai/providers/dist`**（附锁定版本、来源与第三方许可证，遵守打包资产白名单与安装脚本审计），不依赖工作区 pnpm 补丁；终端打包入口、非打包 `zhixing serve` 与各公开包消费同一实现，经 `pnpm package:check` 仓外 npm 安装及真实 `serve` 入口验收。未来若项目最低 Node 提升至上游兼容范围且支持可插拔持久化，可迁回无补丁上游版以移除窄补丁。[写入原语](../../packages/providers/src/internal/io.ts) · [库写入与注入](https://raw.githubusercontent.com/theupdateframework/tuf-js/tuf-js@5.0.1/packages/client/src/updater.ts) · [单轮校验时钟](https://raw.githubusercontent.com/theupdateframework/tuf-js/tuf-js@5.0.1/packages/client/src/store.ts) · [5.0.1 要求](https://raw.githubusercontent.com/theupdateframework/tuf-js/tuf-js@5.0.1/packages/client/package.json) · [后续修正](https://github.com/theupdateframework/tuf-js/blob/main/packages/client/CHANGELOG.md) · [Provider 构建](../../packages/providers/tsup.config.ts) · [CLI 入口](../../packages/cli/src/entry.ts) · [仓外校验](../../scripts/package-check.mjs)

---

### 5. 运行生效、安全迁移与必要接合

#### 5.1 角色解析、输出预算与 `light` 摘要最小修复

角色解析严格拆分为两步，确保**所有 `light` 消费者（自动切段、手动 `/compact`、工具 `ctx.llm.light` 与 `ephemeralRuntime(light)`）始终得到同一已解析完整绑定**，不因工作场景 `power` 或本会话临时选模而分裂：

- **步骤 1（用途默认解析，沿用现行 [model-roles.md](../modules/providers/model-roles.md) 合同）**：`resolvedMain = llm.main`（必填）；`resolvedPower = llm.power ?? resolvedMain`；`resolvedLight = llm.light ?? resolvedMain`。`llm.power` 或 `llm.light` 显式配置出错（`ProviderConfigError`）时按既有可见降级合同告警并回落 `resolvedMain`。
- **步骤 2（会话覆盖与各消费者绑定）**：

| 调用场景 | 生效模型解析规则 | 关键约束与接合点 |
| --- | --- | --- |
| 普通对话主循环 | `sessionOverride ?? resolvedMain` | `sessionOverride` 仅作用于当前对话主循环及未指定角色的子执行 |
| 工作场景主循环 | `sessionOverride ?? resolvedPower` | 当 `main=A、power=B、light 未配` 且无会话覆盖时，工作场景主循环用 `B`，但 `resolvedLight` 仍为 `A` |
| 自动切段与手动 `/compact` 摘要 | 统一使用 `resolvedLight` 完整绑定（与 `ctx.llm.light` 同源，不因工作场景 `power` 或主循环 `sessionOverride` 改绑） | **修补现状跨服务商错配**：在 [create-agent-runtime.ts](../../packages/orchestrator/src/runtime/create-agent-runtime.ts) 既有 `makeSegmentStreamFactory` 窄注入口同时为自动切段与 `forceCompact` 注入 `roles.light.provider.chat`、对应输出预算与保护链，保持主模型注意力窗口阈值，不改 `SegmentManager` 算法职责 |
| 工具 `ctx.llm` / `ephemeralRuntime` 单发 | 显式请求 `light` 走 `resolvedLight`，显式请求 `main` 走 `resolvedMain`；未指定角色的子执行（如 Task 子 Agent）继承当前主循环生效绑定（含 `sessionOverride`） | 杜绝跨角色混用连接、参数或使摘要与工具 `light` 分裂 |
| 契约推进与定时任务 | 推进 `completion/reviewer` 改为每次实际调用从 `ModelRuntimePort` 读当前用途策略（不新建任务级冻结模型字段）；定时任务显式选择按原意执行，旧裸型号保留“覆盖目标设备当前 `main` 连接的精确型号”语义 | 派发前解析为完整非秘密选择，不靠型号名猜测另一服务商 |

- **输出上限解析**：候选输出量依次取 `显式请求 → 用户用途偏好 → 型号策展建议 → 协议兜底（标明来源）`，再受有效型号容量、独立硬上限、剩余窗口与资源许可裁剪；与原生思考预算冲突时请求前明示调整项，绝不放大用户限制；现行 `4096/8192` 仅保留为明确兜底。[用途合同](../modules/providers/model-roles.md)

#### 5.2 保存后应用裁决与单一不可变修订端口

1. **保存与恢复基线**：新配置先本地准备与校验，经现有 `editConfiguration(expected, next)` 核对基线并配对保存；接纳前失败不变更生效来源，接纳后中断由原 owner 前滚恢复并重读。[保存实现](../../packages/providers/src/configuration-edit.ts)
2. **一次编辑的单一应用优先级裁决**（扩展现有 [configuration-application.ts](../../packages/cli/src/runtime/configuration-application.ts) 通道局部应用先例，避免双套并行状态机）：
   - 通道配置/凭据变更仍先独立局部发布并保留各自成败反馈；
   - 剔除通道后**仅模型配置或模型凭据变化** → 执行**模型窄激活**：终端向宿主模型激活管理入口发仅含 `savedRevision` 与 `operationId` 的通知，宿主自行从本机配置/秘密 owner 重读并幂等补应用（启动恢复或新模型准入见修订差亦可补应用，不依赖保存进程存活）。未变通道与工具连接不断链；候选装配失败保留旧可用实例并反馈“已保存、待应用”（重启从耐久配置恢复，不伪称已回退）；
   - 同次编辑包含**任何需整机重装的变更**（如 `network.proxy`、工作区根、设备角色拓扑等）→ 等待本终端 `activeTurnPromise` 后执行**单次完整宿主换代**统一承接该已保存配对（**禁止先模型窄激活再整机重装**），并保留已执行的通道反馈。[应用合同](../modules/configuration/runtime-application.md)
3. **单一不可变修订发放端口（`ModelRuntimePort`）**：由组合根构造并持有一个 `ModelRuntimePort`，对外仅发放不可变修订快照或租用绑定，每次准入或推进调用按同一修订读取，不让 Kernel 回查宿主，不让各消费者自持独立可变配置源。与当前选择无关的目录上新只更新可选列表；在途工作保持已准入绑定，空闲实例随新修订重建。全消费面同步清单如下：
   - 推理与任务消费：`KernelModelProviderFactory`、`ephemeralRuntime`、`ExecutorRuntimeSubstrate`、推进工厂（主控、独立执行宿主及单机共进程 `createLocalConversationOwner`）；
   - 就绪、历史与预热消费：`ExecutorReadiness` 与凭据暴露投影、`setupAuthorityRuntime` 值班迁移就绪、`createConversationStorageInfrastructure` 历史装填只读预算（装填开始时固定，不改写历史事实）、`prepareModelProviderAfterUsable` 当前适配预热（不长期捕获旧配置与密钥）。[实际装配入口](../../packages/runtime-host/src/runtime-host.ts) · [模型工厂](../../packages/cli/src/runtime/kernel-runtime-bindings.ts) · [推进工厂](../../packages/cli/src/runtime/advancement-model-provider.ts) · [宿主消费面](../../packages/cli/src/serve/command.ts) · [执行器装配](../../packages/cli/src/serve/executor-role-runtime.ts)
4. **免密就绪与跨设备派发**：新增按连接的就绪描述（标明连接修订、认证模式与适配能力），免密连接发布“无需秘密且配置就绪”，需凭据连接另附逻辑凭据绑定；首次必填检查与 `requiredBindingsForRuntime` 同源核对，不再把每个 provider 等同非空 `apiKey`，也不为免密造假凭据。旧磁盘 `executor-capability-directory.json` 保持可读，缺新连接描述时按旧能力或未知呈现，不推断免密或新协议就绪。跨设备派发传完整非秘密选模意图（跟随目标指定用途默认，或目标连接引用 + 精确型号 + 参数覆盖），同步演进/门控 `ExecutionManifest.protocolVersion` 与执行器能力声明；若当前会话连接仅存本机，明确提示选兼容设备或在目标配置连接，不猜同名替代；秘密永留执行设备。[就绪源](../../packages/cli/src/serve/executor-readiness.ts) · [派发门禁](../../packages/cli/src/setup-delivery.ts) · [凭据暴露投影](../../packages/cli/src/serve/credential-exposure-authority.ts)

#### 5.3 连接删除耐久清退、显式撤权、封禁轮换与无宿主首配

- **连接删除耐久清退**：配置/秘密 owner 将连接移出可用表，同时在同一保存计划中把待清退项写入 `SecretStore` 固定管理记录 `configuration/model-retirements/v1`。普通等待结算的秘密留在当前秘密代际，其他配置保存保留待回收集合；禁新发放与新准入协调，空闲实例立即退役，在途按用户选择完成或取消，引用归零、保存恢复与启动恢复均可幂等完成秘密清退（他连共用逻辑凭据保留；引用侧留原连接名与选模意图供历史解释；重启不对已死实例等待内存计数，也不把资源释放伪装成任务完成）。
- **显式撤权与连接级取消**：显式撤销的持久状态归配置/秘密 owner，单机与多机均生效——立即将逻辑凭据从活动 manifest 解绑并记入耐久清退，撤销模式禁止回填活动 manifest，重启后不能复活为就绪；多机 `trusted-home` 同步暴露状态。宿主按逻辑凭据、连接与修订登记活跃模型调用的 `AbortController`，接纳撤销后禁新、abort 全部相关调用、失效就绪与发现缓存，并分别反馈保存与收束结果；旧 SDK 闭包即使持 Key 也不再获调用许可。连接退役后在最后使用结束时显式 `close` 其网络 `dispatcher`，共享池不得被单连接提前关闭。
- **封禁凭据（`compromised`）轮换**：编辑基线将封禁凭据表示为“存在但不可读取”加不透明版本令牌，Secret owner 内部按令牌核对允许替换，解决过滤值导致的基线死锁；窄激活接入适配 v2 连接的 `publishRequiredCredentialRotations`，遵循现有轮换校验与读回要求，保存与解除封禁分别反馈。[编辑读策略](../../packages/cli/src/serve/local-configuration-application.ts) · [轮换发布](../../packages/cli/src/serve/credential-rotation-publication.ts)
- **无宿主首配与草稿隔离**：首配宿主未启动时，编辑进程 N 调用共享接入模块与跨进程文件锁执行配置与目录读写；未保存草稿的发现与可选生成验证仅在持有草稿秘密的 N 本地经受控网络执行，由编辑作用域登记与取消，普通 IPC/RPC 绝不传未保存密钥；宿主上线后统一接管运行期管理与刷新。

#### 5.4 受控单跳传输与未送达记账组合

网络请求、发现与可选验证共用连接的受控单跳通路，将 [delivery-transport.ts](../../packages/providers/src/adapters/delivery-transport.ts) 改造为注入单跳受控传输，保留唯一一份跳转编排与整次调用送达账本：

1. **路线判定**：连接代理策略为 `inherit | direct`（公网默认继承 `network.proxy`，用户确认的本机/私网默认直连，可显式改选）。每跳按代理策略、`network.proxy` 与 `NO_PROXY` 规则先判定直连或走受信代理，不依赖黑盒代理客户端绕过直连 DNS 校验；
2. **逐跳安全校验**：仅接受 HTTP(S)（公网默认 HTTPS，本地/私网 HTTP 需显式确认），拒绝 URL userinfo 与未声明查询字段，认证头排除路由及逐跳控制头且值只取自逻辑秘密引用；直连与 `NO_PROXY` 命中分支均使用受控 DNS lookup，本机/私网许可仅作用于用户确认的连接来源，未获准的链路本地（`169.254.0.0/16`、`fe80::/10`）与云元数据地址继续拦截；代理路径逐跳校验 URL、来源与字面 IP，详情与诊断明示目标域名由受信代理解析；公开投影、错误与日志统一脱敏；
3. **跳转收束**：同源跳转按上述顺序重检；跨源跳转在联系新来源前停止并展示脱敏目的地；
4. **送达记账保护**：仅当首跳在连接建立阶段被拒且此前未收到任何响应时可标为未送达（维护零 token 结算合同）；收到首跳 `3xx` 或任意响应即记为已响应；代理隧道建立后发生的远端错误不得轻率标为未送达。[网络现行边界](../modules/network/architecture.md) · [代理与 DNS 基线](../../packages/network/src/safe-fetcher-internal.ts)

#### 5.5 旧配置安全迁移与旧程序防护

1. **恢复优先与防中断窗口**：先恢复合法遗留保存计划再迁移；涉及模型 v2 的保存/迁移采用 `SavedEdit.v = 2`，新程序支持恢复 v1/v2，旧程序在写盘前拒绝 v2 计划，覆盖 `MANIFEST_REF` 保护标记落盘前的中断窗口。
2. **并发幂等与完整管理读取**：在现有配置文件锁与 `SecretStore` coordinator 内先重读判重再生成配对迁移计划，并发启动发现已迁移则复用结果；内部迁移规划以管理权限读取完整原记录（不因普通编辑视图对 `compromised` 的读过滤而漏迁），完整保留原封禁/撤销状态。
3. **公开安全边界与旧自定义地址保护**：所有拟从旧秘密记录迁入公开配置的字段先经公开安全 schema 校验。仅当旧地址省略或匹配已核验公开预设时自动迁入公开连接表；无法自动确认公开性质的旧自定义 `baseUrl`（如含路径内嵌令牌）继续受 `SecretStore` 保护，经第 3.4 节专用迁移修复由用户确认后才公开。发现 URL 内嵌凭据、未允许查询认证或其他敏感字段时拒绝接纳迁移计划，完整保留原旧配对进入修复流程，绝不写入公开配置或 `migrationPending`，也不丢弃原记录。
4. **字段归属与未初始化区分**：旧 provider ID 映射稳定连接 ID，连接字段、用户型号与容量/输入覆盖迁入公开连接表，注意力经验阈值按旧有效作用域归入 `llm.attentionPolicies` 并显式移除旧根级字段；未能确定归属的非秘密覆盖入 `llm.migrationPending`（保留原字段与理由，不阻断原本可解析用途的无头启动）。新读者按配对实态区分：合法 v1 进入迁移；v2 遇 `MANIFEST_REF === null` 属未初始化，允许首配或由 owner 为已明确的合法配置补建版本标记（不新建未选连接或密钥）；非空 manifest 与 v2 缺标记先恢复待完计划，仍失配则拒绝并给修复入口。[旧 manifest 与秘密校验](../../packages/providers/src/credentials-loader.ts)

#### 5.6 Responses 前缀稳定与动态上下文窄接合

现行 [agent-loop.ts](../../packages/core/src/loop/agent-loop.ts) 每次调用从原始 `state.messages` 生成发送视图，而 [turn-context.ts](../../packages/core/src/context/turn-context.ts) 将动态 `<turn-context>` 注入最新 `user` 消息；由于 [messages.ts](../../packages/core/src/types/messages.ts) 将工具结果构造为新 `user` 消息，普通两调用工具往返会出现首调发 `U0+C0 → R0+tool_call`、次调发 `原U0 → R0 → tool_result+C1` 的前缀移位（`R0` 之前的 `C0` 被移除）。按 [OpenAI 前缀保持指南](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged.md)，较新 Responses 型号在前缀改变后会丢弃其后的推理项，且 GPT-6.2 顶层 `instructions` 属单轮末尾追加（turn-scoped），与较早机型规则不同。本轮仅在**窄请求/发送投影边界**收口，不改写主循环状态机，也不冻结所有输入：

1. **窄请求视图与无副作用的追加式窗口临时上下文**：在 `prepareSendView` 与适配器请求投影之间分离稳定历史 `state.messages` 与逐调用生成的动态 `<turn-context>`；既有非追加敏感协议保持现行向最新 `user` 注入不变。对声明追加式前缀敏感的 `openai-responses` 协议，在**当前活跃窗口代际的内存态发送投影**中维护轻量的已提交轮次临时上下文锚点表（**保持普通 `user` 角色输入材料信任等级，绝不提权写入 `developer` 或 `instructions`；绝不回写 `state.messages`、权威对话转录或送入段摘要**）：
   - **纯函数投影与提交时锚定**：`prepareSendView` 保持无副作用纯读取（按已锚定的前序 `C0..C_{k-1}` 叠加本次现取的 `C_k` 生成发送视图），因此 `runTurnBegin` 与 `runTurnEnd` 为评估切段或快照反复调用 `prepareSendView` 不会重复叠加 `<turn-context>` 块；**仅当一次模型调用实际产出助手消息进入 `state.messages` 时**，才将该次实际附尾的 `C_k` 锚定到对应轮次；若 `build()` 返回空则不追加空块。
   - **普通两调用工具往返**：首调发送 `[稳定前缀, U0, user(C0)]` 得到 `R0(reasoning+tool_call)` 并锚定 `C0`；工具完成后次调实时生成刷新后的 `C1`（保留时间/调度/`task_list.set` 逐调用刷新），发送 `[稳定前缀, U0, user(C0), R0, function_call_output, user(C1)]`——`R0` 之前全部前缀项与工具声明逐字节不变，`C1` 仅追加在末尾。
   - **预算与校准口径一致**：`prepareSendView` 产出的实际发送视图（含同窗口已锚定的 `C0` 与新追加的 `C1`）直接送入既有的 `tokenEstimator`、`wrapWithCalibration`、`runTurnBegin` / `runTurnEnd` 预算评估，确保计量与真实出站字节一致。
2. **按型号版本区分 `systemPrompt` 与 `instructions` 投影**：
   - **GPT-6.2 及更新型号**：将可复用的稳定 `systemPrompt` 投影为 `input` 首位 `developer` 消息参与前缀缓存与推理延续，顶层 `instructions` 留空或仅用于明确单轮生效、不依赖前缀缓存的指令；
   - **较早 Responses 型号**：遵循其文档对应的稳定前置指令/developer、固定 `tools` 与 `text.format` 约束，同窗口代际内不原地改写前序项。
3. **真实前缀变化（压缩、窗口重建、实例/进程重启、协议/连接切换、工具集变更）的合法处理**：当发生 `windowLifecycle` 段切分压缩/窗口重建、宿主换代/进程冷重启（从干净权威转录恢复，旧内存态 `C0` 刻意未持久化）、会话切换连接/协议，或运行边界工具集/配置变更时，**诚实开启新前缀代际**并清空旧内存临时上下文锚点表——绝不为凑前缀稳定把 `<turn-context>` 写入权威历史或篡改已提交事实；对已知因前缀变化失效的已结算旧推理载荷在出站投影中省略（不伪造保真，也不空耗输入 token 传失效加密载荷），新代际内的后续工具往返重新按上述规则保持追加式前缀稳定。[逐轮上下文注入合同](../modules/context/turn-context-injection.md) · [Turn 评估钩子](../../packages/core/src/loop/turn-end.ts)

---

### 6. 关键架构取舍与对比

#### 6.1 相对现状与外部强方案的收益代价

| 对照对象 | 用户体验收益 | 供给与维护收益/代价 | 架构取舍 |
| --- | --- | --- | --- |
| **知行现状** | 开放全部 11 项预设、自定义与免密接入，`/model` 快捷选模/原位调参与用途默认解耦，增改删/隐藏/修复形成完整闭环 | 同协议资料与推荐改为单源数据发布，消除四表手工同步与普通上新发整包；新增策展审阅、兼容通道与周期续签责任 | 保留现有角色、配置/秘密 owner 与 `SecretStore` 底座；将变化锁在接入层与模型运行态端口 |
| **OpenClaw 供给链** | 保留推荐加完整列表与既有选择可解释性，将免密与刷新纳入知行统一终端管理 | 借鉴旧端兼容读取器与高修订恢复，兼容服务商由声明式预设供给；仍须核实各家真实协议 | 公开连接直接作配置权威，避免多份生成配置再合并的复杂性 |
| **Hermes / Pi / OpenCode** | 保留轻量精选、搜索、手填与覆盖，未知规格诚实呈现，免查资料与假 Key | 策展覆盖全部内置预设，原生发现补充对应连接事实，维护者须为推荐留证 | 受控协议适配 + 声明式数据更新，避免普通上新引入运行期装包依赖 |

#### 6.2 三项核心内部架构决策取舍

| 决策项 | 采用方案 | 备选方案及放弃原因 | 成立条件与简化退路 |
| --- | --- | --- | --- |
| **协议范围** | 锁定四协议（补齐 `openai-responses` 与 `google-interactions`），实施期分步交付验收 | 仅留现有双协议：将直接丧失 OpenAI GPT-6.2 工具调用与 Google 官方推荐无状态接口，缩减主流供给 | 仅使用 OpenAI 兼容或 Anthropic 生态的隔离部署可只启用对应连接，未用 SDK 保持按需懒加载 |
| **目录可信更新** | `tuf-js@5.0.1` 受限四角色 + 外包校验 + 窄存储补丁内联进 `dist` | `tuf-browser@0.2.0` 未审计且全局 `fetch`；自写校验器背负整套加密状态机长期安全债；无续签清单放弃硬抗冻结 | 隔离环境或固定小目录可关闭远端检查仅用随包基线；仅当**同时满足**项目最低 Node 升至上游兼容范围**且**上游提供可插拔异步持久化接口时，才迁回无补丁上游版 |
| **配置运行应用** | 混合编辑单一裁决 + 纯模型走 `ModelRuntimePort` 窄激活 | 一律整机宿主换代会打断未变通道长连接，且装配失败丢旧可用实例；“仅拆通道”仍涉生命周期重组并非免费 | 包含 `network.proxy`/工作区/拓扑的混合修改自动收敛为单次完整宿主换代，不增加复杂局部状态迁移 |

此外，已具备统一受信企业网关的用户可只配置单个自定义连接入口；若某专有协议高频变化快于宿主发版，单独交付受控适配代码比强塞数据层更可靠。设计以明确操作与维护变化论证改善，实际耗时、费用与稳定性在获准实施后实测核验。

---

### 7. 验收场景与失败判据

设计审查逐条推演输入、触发、动作与终态，实施后通过真实入口与仓外制品验证。五项设计标准与下表共同约束成果：

| 验收场景 | 预期结果 | 失败判据 |
| --- | --- | --- |
| **首配、追加连接、11 预设、自定义与免密** | 11 预设同源供给，发现器严格区分已核实原生路径与可选兼容探测；仅缺失 `main` 的首配同次保存自动绑定 `main`，已有 `main` 时新增/修改连接不改既有用途默认；模板不预选、取消不提交；Ollama 免密自动探测；无宿主首配由 N 本地完成且草稿秘密不跨普通 RPC | 展示无适配选项、免密索要假 Key、首配须跳页二次绑 `main`、新增备用连接暗改既有 `main`、草稿秘密跨 RPC、资料未收录就无法配置 |
| **探测错误分态与可选验证** | `401` 高亮阻断警示、403 结构化排障、404/405 不阻保存回落目录/手填、超时允许存草稿并可切代理；四态分离；生成验证自愿告知且不用固定 1 token 探针 | 404/405 拒绝保存、403 一律误报 Key 错、把发现成功冒充型号生成已验证、强发计费探针 |
| **`/model` 总览、原位调参与三态移除** | 顶部同步展示当前生效、来源及 `main/light/power` 关系；支持不换模型原位调参并明确本会话/默认作用域；搜索查全、改当前与改默认分开；隐藏后刷新不复活且可从“已隐藏”入口恢复；删覆盖前说明上游值；文本 `/model`、`ReplLocalView`、`/status` 同源 | 推荐更新暗改型号、原位调参无入口或作用域不明、已隐藏项无法恢复、删覆盖误删供应方条目、多表面显示旧启动 `main` |
| **参数、承载差异与非对话过滤** | 同名异端规格独立，硬约束与资料分层；控件只用已注册语义，旧参数不串用；仅按明确结构化断言过滤非对话模型，未知保留并标明 | 拼错端点能力、覆盖突破硬限制、注入任意字段/脚本、靠名称关键字误杀对话型号 |
| **跨连接/跨协议/同协议切模与 Responses 前缀投影** | 权威历史不变，投影层先校验非秘密来源身份（`sourceConnectionId + sourceOriginKey`）再判协议与型号：同来源同协议保真（含 Google 无状态重传）；**Responses 两调用工具往返**首调发 `[稳定前缀, U0, user(C0)] → R0+tool_call`，次调保留 `C0` 且尾部追加 `function_call_output + user(C1)`，`R0` 前缀字节不变、动态上下文实时刷新且维持 `user` 信任等级、预算计量与实际发送一致、权威转录与段摘要不含 `<turn-context>`，GPT-6.2 将稳定 `systemPrompt` 置于首位 `developer`（与较早机型分版处理），压缩/实例重建等真实前缀边界诚实开新代际不伪造保真；`openai-compatible` 按方言决定是否发 `reasoning_content`；**同协议同名不同连接**、**同连接改地址后**、来源不明旧记录与跨协议默认不转发私有推理载荷，已结算轮次允许继续且不伪造签名/不把不透明载荷转文本；未完工具往返遇强制签名冲突或材料不兼容时诚实阻断并保原选择 | Responses 工具往返次调移除 `R0` 前的 `C0` 导致前缀断裂丢弃推理项、冻结动态上下文致 `task_list` 失灵、把 `<turn-context>` 提权进 `developer`/`instructions` 或污染权威历史与摘要、忽略 GPT-6.2 与旧机型 `instructions` 差异、压缩/重启后伪造前缀保真；或把官方连接 A 的加密推理项/签名发往同协议同名网关 B 或改址后连接、跨协议伪造签名、把加密载荷当文本输出、普通跨厂商切模无故强迫开新对话、静默删用户图片材料 |
| **预设建议、迁移修复与封禁轮换** | 预设改地址出对比建议由用户采纳/忽略；旧自定义路径地址未确认公开前仍受 `SecretStore` 保护并经专用修复入口确认；`llm.migrationPending` 无头保留且有修复入口；封禁凭据以不透明令牌正常保存轮换并分别反馈保存与解封 | 远端预设暗改已确认地址、旧路径令牌借自动迁移外泄、封禁凭据基线死锁无法保存、迁移修复无终端入口 |
| **连接删除、显式撤权与崩溃恢复** | 删除先列引用与改绑必需默认，待清退项入 `configuration/model-retirements/v1` 并经归零/重启幂等完成；显式撤权持久解绑（单机重启不复活）、禁新并 abort 活跃调用；退役连接最后释放关闭 `dispatcher`；`SavedEdit.v = 2` 与 `MANIFEST_REF.modelConfigVersion = 2`（含纯免密）阻止旧程序误读 | 新调用越过禁新、在用秘密提前删除、单机重启复活已撤销凭据、旧程序抹除新配置 |
| **`light` 摘要、混合应用与受控网络** | `main=A、power=B、light` 未配时摘要与 `ctx.llm.light` 统一走 `resolvedLight=A`（不随工作场景 `power` 或主循环 `sessionOverride` 分裂），`light` 显式配置出错告警回落 `main`；自动切段与 `/compact` 经 `makeSegmentStreamFactory` 走 `roles.light` 完整绑定；纯模型走 `ModelRuntimePort` 窄激活不断未变通道，含 `network.proxy`/工作区走单次整机换代，混合通道保留独立反馈；免密通过 `requiredBindingsForRuntime`；受控单跳传输 + `deliveryFetch` 正确处理 `NO_PROXY` DNS 与代理/首跳 3xx 记账 | 摘要与工具 `light` 解析分裂或跨服务商错发主端点、先窄激活再整机重装、未变通道被纯模型编辑重建、免密卡在凭据门禁、代理隧道后或首跳 3xx 后误标未送达 |
| **维护更新、TUF 边界与仓外交付** | 同协议变化经“源资料 → 可审 diff → 人审 → 发布”一次到达各入口；事实修订不改推荐/默认；兼容通道按三步条件演进退出；严格拒绝无效日期/重复公钥/委托/非支持方案，连续根轮换与每次刷新独立时钟成立；`writeBytesAtomic` 原始字节防断电损坏；`pnpm package:check` 与真实 `serve` 入口验收通过 | 四处手工表漂移、断网卡住入口或清空缓存、低版本倒退信任根、截断元数据字节、依赖暗抬 Node 基线、正式 npm/`serve` 入口加载未打补丁库 |

本轮交付止于设计定稿与审查。用户审阅同意实施后，按既有分支管理规则在独立任务分支、工作区和运行数据根推进，主开发目录继续承载任务核心文稿。

## 工作范围与完成标准

- **现状**：两人各自深入核查生产实现与相关用户路径，覆盖接入合同、协议适配、模型目录与能力信息、配置与认证、运行时应用、终端使用，以及模型/服务商新增、变更和退役的维护方式。交换发现、补查差异，明确事实依据与尚未验证边界，由 Codex 将双方核实的现状简洁写入本文。
- **调研**：两人必须各自完整使用 [research 技能](../../.agents/skills/research/SKILL.md)。以决定性问题组织研究，先广泛探索，再按实质贡献与证据择优；考察同类前沿、基础原理、历史与跨领域有效实践及竞争解释，实际打开一手文档、源码或研究材料。区分作者主张、证据与自身推断，核查适用前提和反例。尤其回答服务商/模型更新如何交付给用户、哪些变化需要系统升级、哪些可独立更新及其兼容、安全与运行成本，不预设答案。决定性问题都有充分依据，重要冲突与反例处置完成，双方独立审查和交叉审查均通过后，才进入设计；不能以资料数量、已花时间或找到一个可用案例代替达标。
- **设计**：双方各自形成判断后交叉质询，基于愿景、架构演进方向、真实现状和调研结论，明确体系的职责划分、功能及实现机制、完整用户旅程与终端体验、供给方维护/更新流程。说明相对可信一流路线的具体改进、代价与成立条件，给出可判定的验收场景；不以“最优”或“超越”的措辞代替证据。未达标时继续修正并复核受影响部分，最终由 Codex 将双方认可的完整设计写入本文。

三个阶段均由双方独立工作、交叉核实并各自验收，不将现状核查交给单方，也不由一方代替另一方确认。用户原话及补充保存在本轮[协作记录](../../collab/threads/20261118-model-provider-access-6f20/request.md)，原话高于转述。

## 分工与实施边界

Codex 担任本轮总控，负责目标、进度、阶段安排及本文整理；Antigravity 担任项目负责人。两人共同完成现状核查、独立调研、设计与审查，对最终结果负责。

本文的核心内容和待办在当前 `develop` 工作区维护，不改变已有暂存内容、Git 历史或远程。本轮只完成前三阶段，**设计达标后停下，向用户报告并等待审阅，不开始产品实现**。用户同意实施后，按[分支管理](../../.agents/skills/branch-management/SKILL.md)从开发基线建立相应任务分支和独立工作区，隔离可写运行数据，按验收和授权集成，不占用或阻塞主开发目录。分支规则已有相应隔离与退出要求，无须另造分支制度。

---

## 执行待办

仅在对应成果已完成且双方独立与交叉核验通过后勾选；本清单维护进度，静态核心内容写在分割线上方。

### 前期成果

- [x] **1. 核实接入体系现状。** 双方各自完整核查实现和用户路径，交换细节、补查差异，现状已写入正文并通过双方独立成稿验收（2026-11-18；[Codex 依据](../../collab/threads/20261118-model-provider-access-6f20/codex-stage1-attainment.md)、[Antigravity 依据](../../collab/threads/20261118-model-provider-access-6f20/antigravity-stage1-attainment.md)）。
- [x] **2. 严格按调研技能完成独立研究与交叉审查。** 2026-11-18，原调研大幅删减后，双方从用户原始需求重新独立研究并交叉质询，纠正错误事实与范围偏移。正式正文首轮未通过后定向修订，第 2 轮按任务目标和固定五项标准同版验收通过。[Codex 验收依据](../../collab/threads/20261118-model-provider-access-6f20/codex-restart-final-attainment.md) · [Antigravity 验收依据](../../collab/threads/20261118-model-provider-access-6f20/antigravity-restart-final-attainment.md)
- [x] **3. 完成体系设计并通过双方审查。** 2026-11-19，双方重判撤回旧通过结论并确认六组真实缺口后，由 Antigravity 重构修订第三部分，按用户指定顺序经 Codex 独立审查、Antigravity 同版独立终验及非执笔方安排的 §3.13 零历史冷读终审（含 R3 定向闭环与增量一致性复验，0 blocker / 0 major / 0 需改稿 minor）全部有据通过；本轮止于设计交付，实施待用户审阅同意。[Codex 验收依据](../../collab/threads/20261118-model-provider-access-6f20/codex-design-revision-attainment.md) · [Antigravity 验收依据](../../collab/threads/20261118-model-provider-access-6f20/antigravity-design-revision-attainment.md) · [§3.13 冷读终审依据](../../collab/threads/20261118-model-provider-access-6f20/codex-design-revision-cold-review.md)

### 实施执行单元

以下按第三部分设计落实实施，依 **单元 1 → 2 → 3 → 4** 推进；当前均未开工。单元内连续完成实现与必要验证，再集中交审、修复和复验。状态使用“待执行／开发中／待审查／待最终检查／完成”，达到本单元完成条件及适用收尾要求后才勾选。

单元 1 先以既有协议贯通连接、用途配置与运行消费；单元 2 补齐四协议及直接消费者；单元 3 接通独立目录维护与可信更新；单元 4 完成全部终端管理体验并整体验收。后续单元扩展能力，不回补前序已经承诺的安全、恢复或基本可用性。需要改变划分时按真实依赖调整并明确剩余归属，不按文件、服务商或提交数量凑单元。

- [ ] **单元 1：连接与用途配置、迁移和运行生效主干**｜状态：待执行
  - 落实第 2.1、2.2、5.1—5.5 节：统一连接表、三用途绑定与已实现适配的能力门控，以既有两类协议和内置资料接通完整模型绑定。建立目录窄读口，后续在线数据接入不另造解析路径；未实现适配不冒充可用。
  - 完成 v2 配置/秘密配对保存、旧配置安全迁移、旧程序拒读及并发/中断恢复；将 `/config` 一次切上“服务商连接 + 用途默认”基础结构，支持预设及自定义连接的地址、协议、免密/密钥/自定义认证头。首配、追加保默认、旧配置继续使用、取消、迁移修复和封禁轮换入口在此建成，后续仅增量扩展，不另造临时向导。
  - 由 Session owner 持久保存“跟随默认 / 结构化会话覆盖”，提供对应读写口并替换旧裸 `mainModelOverride`，贯通普通/工作场景及未指定角色子执行的继承。接通 `ModelRuntimePort`、窄激活、混合修改裁决和全部模型消费者；结构化选择与免密就绪贯通本机/远端派发。`light` 摘要与工具统一消费独立用途绑定，不随 `power` 或本会话覆盖改绑，修复两条摘要入口错端点。
  - 落实受控单跳网络与送达记账、显式代理/直连和来源限定的私网许可，以及连接删除引用检查、秘密耐久清退、撤权取消与共享资源释放；相应影响预览、改绑和结果反馈随实际管理入口可用。
  - **完成条件**：通过真实配置/管理与运行入口跑通“首配或迁移 → 保存 → 生效 → 三用途正确消费 → 修改/删除/撤权 → 重启恢复”。验证预设/自定义认证与免密连接、追加连接保默认、会话覆盖持久化与恢复跟随、未指定角色子执行继承、跨服务商 `light` 不受主会话覆盖影响、纯模型变更不断未变通道、混合变更只应用一次，以及并发保存、迁移中断、封禁轮换、在途删除与撤权后重启；旧配置不丢失或泄密，各消费者不残留旧绑定。后续协议、目录与界面单元可直接复用这一主干。

- [ ] **单元 2：四协议适配与模型调用的完整接合**｜状态：待执行
  - 依托单元 1，完成第 1.1、2.3、5.6 节：补齐现有 Chat Completions 兼容方言和 Anthropic 思考形态，新增 Responses 与 Google Interactions，接通合法参数、流事件、文本/工具/思考及用量；错误经统一分类/恢复、脱敏公开投影到中文下一步指引，`403` 按结构化原因区分，不在终端另建厂商分支。基础配置入口可选择、配置并实际使用新适配，不能只留下未接入的 SDK 封装。
  - 将有界协议状态及来源身份贯通消息、转录提交/恢复、RPC、执行封套和直接校验消费者；同源保真、跨源私有状态隔离、旧记录来源未知及旧执行器能力门控按设计一并生效。
  - 实现 Responses 临时发送上下文与前缀代际：动态状态逐调用刷新，准备视图无提交副作用，实际输出时锚定；计量包含实际发送视图且不重复计旧上下文，压缩/重建/切源时诚实处理失效推理态，不改变材料信任等级和权威历史。
  - **完成条件**：四协议通过真实适配及运行入口完成流式、工具往返、取消、错误和用量验证；确认同名不同连接及同连接改址/换适配不串私有状态、普通已结算跨协议切模可合法续接、未完工具往返强制签名冲突或材料不兼容时阻断并保留原选择，错误指引可操作且不泄密；Responses 连续工具调用前缀稳定、任务状态及时刷新、重复预算评估不重复锚定、恢复后不伪造保真。外部服务采用受控夹具时注明证明边界，不以 SDK mock 或类型通过代替实际协议链验证。

- [ ] **单元 3：单源模型资料、原生发现与可信维护更新**｜状态：待执行
  - 复用前两单元的连接、适配和目录读口，落实第 1.3、1.4、2.2、4 节：统一十一预设、型号资料、用途推荐和经验参数，生成或替换原四处手工表及其消费者；实现硬约束/资料/偏好三层合成、分字段来源与覆盖、未知表达、生命周期和结构化非对话过滤；覆盖不能突破已确认硬约束，不把推荐、库存与用户默认混用。
  - 按已核实模板实现原生发现、可选兼容探测、隔离缓存及可选生成验证，接通无宿主 N 草稿与宿主管理路径；草稿秘密不跨普通 RPC。生成验证的自愿告知、费用说明、合法参数与取消入口随执行链建成，禁止固定一 token 探针。改址/换 Key/取消后丢弃过时结果，发现、保存、应用与已验证分别反馈；目录、发现、手填和覆盖能由实际配置入口消费。
  - 完成资料采集差异、人审、兼容读取器与发布流程，分别处理新增服务商/型号、规格/推荐变化、退役和错误修订。落实受限 TUF、连续根轮换、严格校验、原始字节耐久保存、跨进程单写、离线保底和周期续签；真实发布源、受支持读取器与客户端更新路径闭合。
  - 将锁定补丁和许可正确交付进正式包，贯通终端与非打包 `zhixing serve` 入口；保留源资料、推荐和发行元数据的各自维护责任。
  - **完成条件**：核验十一预设的已声明发现路径（含 Ollama 推理/原生路径归一及自定义基路径保留）、缺省字段与结构化过滤、硬约束冲突保输入、`401/403/404/405/超时` 分态和换钥/改址缓存失效；缓存不写公开配置、不含秘密，过期不充当永久禁用权威。无宿主草稿取消不提交或跨 RPC 泄密，可选生成验证自愿、可取消且使用合法参数。从发布变更到用户列表跑通上新、修正规格、退役和高修订纠错，既有端点、默认及偏好保持；坏签名、过期、回滚、兼容门控、断网、并发和写入中断终态正确。仓外 npm 制品的更新/恢复及 `package:check`、许可证、安装脚本门禁通过；完整界面整理归单元 4，数据/验证/维护链的正确性不后置。

- [ ] **单元 4：完整终端管理体验与模块整体验收**｜状态：待执行
  - 复用单元 1 已建成的 `/config` 连接/用途页面和 Session owner 选模接口，以及单元 3 的发现、验证、更新操作，增量完成第 3 节完整体验和“模型资料与更新”区的统一组织；实现 `/model` 总览、搜索、本会话选择、设用途默认、恢复跟随和原位调参，清楚展示三用途关系及生效来源。
  - 增补自定义型号增改删、规格覆盖恢复预览、隐藏/取消隐藏及预设建议对比采纳/忽略；复核既有首配、迁移修复、封禁轮换、连接删除和生成验证在完整界面中的连贯性，不重复建设这些闭环。文本 `/model`、`/status`、`ReplLocalView` 与交互终端同源，统一状态、费用、取消及错误修正反馈。
  - 核对旧注册表、过渡映射及重复入口已经随替代实现清退，补齐用户与维护者的必要使用说明；不重做前序已完成且证据有效的实现。
  - **完成条件**：在同一冻结候选的实际终端和正式安装形态下，完成第 7 节全部正常、失败、取消及恢复场景，并逐项核对第一部分需求、第三部分五项标准、供给/三用途分层红线及实施期注意项。跨单元配置/资料/运行修订一致，全部十一预设与四协议按承诺开放，既有行为无回归；必要全量构建、仓外制品检查、双方独立验收及适用冷执行/冷读通过，无未关闭的实质缺口，才宣布整个任务完成。

**验证与收尾口径**：关键协议、迁移或制品假设可能影响后续实现时，先以最小真实路径核验；不另设只产出诊断的碎单元。每单元覆盖自身新增/受影响的成功与故障路径，并按[协作终审要求](../workbench/cross-session-collaboration.md#313-终审质量门唯一门禁清单)执行适用门禁；复用输入未变的证据，不逐文件重跑全仓。阶段通过不代替最终跨单元验收。

## 实施期注意项

> 以下仅标注已定设计在当前代码中的实施落点，供用户同意实施后承接；不新增设计合同、产品范围或本轮验收门槛。

| 实施落点 | 对应既定设计与代码核对点 |
| --- | --- |
| **Responses 锚点增量计量** | 承接第 5.6 节计量一致合同。[token-accounting.ts](../../packages/core/src/context/token-accounting.ts) 第 52–55 行真值锚点分支当前仅累加 `stateMessages` 增量；实施时须仅计入锚点之后新追加的临时上下文 `C_k`（避免重复计算已包含在锚点真值中的旧 `C0`），并在前缀代际失效时清理锚点按完整发送视图重算。 |
| **探测状态派生缓存边界** | 承接第 2.2.4 节与第 3.3 节探测四态。最近探测结果（含 `401` 提示）、时间与当前性存于按 `connectionId + endpoint + adapter + credentialRevision` 隔离的脱敏派生缓存，不写入公开 `config.jsonc`，不缓存原始 SDK 响应或秘密；换 Key/改址即失效，后续成功替换旧失败，过期结果仅标“上次结果/待刷新”，不得冒充新鲜失败或充当永久禁用凭据的权威。 |
| **新协议错误整链覆盖** | 承接第 1.1 节与第 3.3 节错误反馈。[model-failure.ts](../../packages/cli/src/terminal/model-failure.ts) 现消费 [classify.ts](../../packages/core/src/resilience/classify.ts) 统一分类且终端入口仅接字符串。实施时须核对 `openai-responses` 与 `google-interactions` 的“适配器错误 → 统一分类/恢复策略 → 公开脱敏投影 → 中文下一步指引”整链覆盖，保持 `403` 按结构化原因区分而非一律报 Key 错，不在 CLI 另堆厂商错误分支。 |
| **Ollama 推理与发现路径归一** | 承接第 1.3 节 Ollama 模板。[resolve.ts](../../packages/providers/src/resolve.ts) 当前仅去尾斜杠、不补 `/v1`。实施时须分别核验兼容推理（`<origin>/v1/chat/completions`）与原生发现（`<origin>/api/tags`、`<origin>/api/show`），防止缺 `/v1`、重复 `/v1` 或误给 `/api/tags` 加 `/v1`，且不改写用户显式指定的自定义 `basePath`（见 [Ollama 兼容文档](https://docs.ollama.com/api/openai-compatibility)）。 |
| **TUF 制品打包与门禁落点** | 承接第 4.2 节仓外交付门禁。[package-check.mjs](../../scripts/package-check.mjs) 第 141–154 行要求 tarball 仅含允许资产且包根 `LICENSE` 与仓库根许可完全一致；内联补丁的第三方许可须放入 `dist/` 内合法位置，不得覆盖包根 `LICENSE` 或落盘未允许根文件，并按既有 `zhixing serve`、仓外 npm 安装及 `npm-production-install-script-audit.json` 门禁实测（不得以放宽预期名单代替修复违规制品）。 |

- **来源链接校正**：第 1.3 节 Kimi 所引旧地址 `platform.moonshot.ai/docs/api/chat#list-models` 实际重定向至对话页，正式列表接口文档为 [Kimi List Models](https://platform.kimi.ai/docs/api/list-models)；实施策展帮助链接时优先使用该准确地址（已审定静态正文暂不改动）。
