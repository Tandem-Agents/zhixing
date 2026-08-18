# DeepSeek Harness 架构调研

> **调研日期**：2026-08-18  
> **源码快照**：`v0.1.0-rc.7`，提交 `99f6f02`  
> **范围**：独立分析 DeepSeek Harness 的技术栈、核心架构、插件机制、产品价值、成本与成熟度；不讨论其他项目如何借鉴或迁移。

## 结论

DeepSeek Harness 不是“给编码智能体增加插件接口”，而是把智能体本身做成一棵可组合、可卸载、可替换的运行时组件树：模型适配器、工具、会话日志、Agent Loop、沙箱、持久化、子智能体、交互策略乃至 Web UI 都由插件装配。

它真正先进的地方不是“插件很多”，而是用 Cordis 同时解决了插件系统最难的两个问题：

- **空间组合**：插件声明自己需要哪些服务，运行时根据服务的出现和消失自动激活或停用插件，不靠手写启动顺序。
- **时间组合**：插件产生的监听器、工具、服务和外部资源都作为可逆效果登记，卸载时按生命周期撤销，避免热替换后留下旧行为。

这套架构还把可重放会话日志、作用域隔离、能力接口、配置装配和临时自修改统一在同一模型中。因此，它更像一个“可编程智能体运行平台”，而不是一个固定编码智能体。

独立判断是：**架构思想领先、实现完整度罕见，但产品仍处于 Developer Preview。** 它已经证明了深度插件化可以形成真实产品能力，也暴露了相应代价：系统认知成本高、插件等同于受信任代码、装配错误可能阻断启动、扩展兼容性尚未稳定。它目前最适合智能体研发、专用智能体装配和高级开发者；还不能仅凭架构先进就判定为成熟的通用终端产品。

## 1. 项目定位与成熟度

DeepSeek Harness，命令名 `dsh`，是 DeepSeek AI 以 MIT 许可证开放的智能体 Harness。官方入口只要求 Node.js，执行 `npx @deepseek-ai/dsh web` 即可启动本地 Web UI；用户配置模型、选择工作区后，智能体可读写文件、运行命令、维护计划和委派子任务，并在权限策略要求时请求批准。

截至本次调研：

- 最新版本为预发布版 `v0.1.0-rc.7`。
- 官方明确标记为 **Developer Preview**，并警告将发生破坏兼容性的变更。
- 产品已经具备 Web、headless、ACP、TypeScript SDK 和 Python SDK 等入口，但其公共扩展合同仍在快速演进。

因此，当前代码适合判断架构方向和能力边界，不适合把现有配置格式、插件 API 或磁盘格式视为长期稳定合同。

Cordis 的理论论文同样是 2026-08-13 的在修订预印本。它能说明设计动机与形式化目标，但不能单独证明当前工程实现已经获得形式化验证；本文只把论文作为设计依据，并以 Harness 的源码装配、公开合同和已声明限制判断实际行为。

## 2. 技术栈

| 层面 | 当前实现 |
|---|---|
| 主语言与运行时 | TypeScript、Node.js ESM；要求 Node `^22.19.0 || >=24.0.0` |
| 工程组织 | pnpm 11 monorepo，按能力族拆分为大量独立 npm 包 |
| 插件内核 | 仓库内固定版本的 Cordis，负责 Context、Service、Fiber、Effect、事件、Loader 与 HMR |
| 前端 | 浏览器插件树；Host 与 Client 分属两个 TypeScript 聚合程序 |
| 远程调用 | Typert 从 Host 类型生成反射信息、RPC gateway 和 Client 投影 |
| 持久化 | append-only 会话事件流；JSONL/SQLite 后端；投影与查询独立成能力缝 |
| 进程与终端 | subprocess、Shell、持久 PTY、LSP；`node-pty` 与平台沙箱后端 |
| 外部接口 | Web、CLI、headless、ACP、JSON-RPC TypeScript SDK、Python SDK |
| 测试与门禁 | Vitest、端到端/快照/性能/压力配置，以及大量由源码生成并校验新鲜度的目录、图和合同 |

Host 与 Client 必须分开编译，不只是构建偏好：二者都会通过 TypeScript declaration merging 扩充 Cordis `Context`，相同键在两侧可能代表不同实现，放进同一 TypeScript Program 会发生类型碰撞。Typert 再把 Host 可远程调用的方法投影给 Client，从而保持浏览器插件也能使用同一服务模型。

## 3. “Everything is a Plugin”到底意味着什么

### 3.1 插件不是扩展目录，而是运行时组件

一个 Cordis 插件可以是函数、对象或 `Service` 子类。它通过 `Context` 获取依赖、注册能力，并由一个 Fiber 承载生命周期：

```text
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

- `Context` 是服务仓库，插件通过稳定的 `ctx.<key>` 使用服务，不直接依赖具体实现。
- `inject` 声明所需服务；依赖未就绪时插件保持 `PENDING`，依赖满足后再激活。
- `ctx.on()`、`ctx.plugin()`、服务注册和 Harness registry 注册天然属于可逆效果。
- 定时器、连接、watcher 等框架外资源必须放进 `ctx.effect()`，并返回 disposer。
- Fiber 被卸载时，会等待自身和子插件的清理完成。

这使“加载一个插件”同时表达了依赖关系、作用范围、运行状态和撤销方式，而不是单纯执行一次初始化函数。

### 3.2 它仍然存在一个元内核

“Everything”在产品行为层成立，但并非字面上的绝对无核心。Cordis 的 Context、Fiber、Effect、Loader，Node 进程、ESM 模块系统以及启动器仍构成不可由普通插件替换的元内核。

更准确的说法是：**除最小组合机制外，智能体的产品行为没有必须修改的特权核心。** 新能力通常挂载在既有服务或事件扩展点上，而不是改 Agent Loop。

## 4. 四层装配模型

```text
CLI / Web / Headless / ACP / SDK
                │
             Profile
                │
     ordered Bundles → user patches → --patch
                │
        Cordis Plugin Tree
                │
 Context + Services + Events + Reversible Effects
                │
 Agent / Session / Tools / Capabilities / UI
```

### Profile

Profile 是一次应用启动所使用的完整组合，保存于 Harness home。官方提供 `web` 和 `headless` 模板；其他 Profile 可安装第三方插件并维护自己的 `cordis.patch.yml`。

### Bundle

Bundle 是可发布的配置层与插件代码集合。每个 Profile 按顺序叠加 Bundle，随后叠加 Profile、用户目录及命令行 patch。后层按稳定 row id 替换前层配置。

### Patch

Patch 可以替换或插入插件 row。它不是深合并：命中某个 row 时替换整份 config，用户必须重述希望保留的字段。`dsh --dump-config` 可显示机器真正会启动的最终插件树。

### Preset 与 Scope

Preset 是每个智能体会话使用的模型可见组合，主要控制工具、系统提示、投影等。它与应用级 Profile 不同：

- 同一 Preset 在进程内只挂载一次，多会话共享插件实例，但插件按 Session/Agent 隔离状态。
- 作用域按 `agent → preset → global` 查找，近层可以遮蔽远层，兄弟 Preset 互不串扰。
- 子智能体绑定父智能体正在使用的同一 Preset generation，不因文件后来变化而悄悄换代。
- 只有尚未产生内容的空白会话可以切换 Preset，避免历史工具调用落入新组合后无法重放。
- 切换结果写入耐久会话事件；创建时的 header 保持创建事实不变。

这套区分使机器级部署、应用形态、用户覆盖和会话能力可以分别变化，而不把它们混成一份全局配置。

## 5. 智能体核心如何保持“小而稳定”

`dsh-agent-loop` 是唯一包含具体循环逻辑的包，职责被限制为“调用模型、执行工具、继续或结束回合”。计划、压缩、权限、重试、沙箱、持久化、子智能体和 UI 都通过事件或服务插件接入。

一次 Turn 可包含多个 Step；每个 Step 是一次模型请求及其工具调用：

```text
领取输入
  → 组装系统提示与工具 schema
  → agent/pre-step
  → 写入耐久 user/message
  → 从日志派生模型历史
  → agent/request → llm/stream
  → assistant/message
  → tool/call → pre-execute → execute → post-execute → tool/result
  → 仍有义务则进入下一 Step，否则关闭 Turn
```

事件分为三类：

- **Session events**：必须跨重启存在的耐久事实。
- **Agent events**：携带实时 Agent 的运行中协调点。
- **Capability events**：文件、工具、遥测等能力自身的策略与适配点。

事件有 `emit`、`waterfall`、`parallel`、`serial` 四种明确调度语义。特别是 waterfall 允许中间件包装、修改或短路下游行为，因此插件可以改变请求、拒绝步骤或接管恢复，而无需让 Agent Loop 认识具体功能。

## 6. 会话日志是行为一致性的中心

Harness 把 append-only `SessionEvent` 日志作为模型上下文、回放和恢复的共同事实源。模型历史由 `deriveMessages()` 从日志投影，原始流式 chunk 也保留以支持 UI 与回放。

它明确维护一个关键不变量：**模型可见即已记录。** 任何进入模型请求的内容，都必须能仅从会话日志重建。由此得到：

- 恢复、fork、转录、遥测与持久化共享同一事件流，不各自保存一套对话真相。
- Preset 切换、注入上下文和工具结果若改变后续模型行为，必须产生相应耐久事件。
- UI 展示与模型历史可以有不同投影，但不能凭未记录的进程状态改变模型输入。

插件自由度因此受到一条强约束：插件可以替换行为，但不能制造无法重建的隐式上下文。

## 7. 能力缝：可替换能力的统一结构

一个完整能力通常由三种角色组成：

1. **Service Definition**：稳定接口与语义。
2. **Service Provider**：本地、远程或第三方实现。
3. **Consumer**：其他插件或模型可见工具。

例如文件系统、subprocess、Shell、终端、LSP、沙箱、LLM、持久化、检索和子智能体都沿此方式拆分。消费者只依赖 Definition，不依赖具体 Provider。

这不仅是代码整洁。文件系统与 subprocess Provider 共享同一个“执行世界”时，把两者换到远程沙箱，Bash、PTY 和 LSP 可以一起迁移，无需为每个工具复制远程版逻辑。子智能体也可在同一接口后选择进程内新 Agent、会话 fork、ACP、Codex、Claude Code 或另一个 Harness 进程。

## 8. 自修改：最有辨识度的产品能力

Creator 相关插件把当前 Cordis 运行时本身暴露为五个模型工具：

- `cordis_inspect`：查看当前服务、Fiber、工具、API、事件和浏览器插槽。
- `cordis_define`：语法检查并记录模型编写的临时插件，但不执行。
- `cordis_run`：运行 Host half，并在需要时把 Browser half 交给页面加载。
- `cordis_stop`：卸载到静止状态。
- `cordis_undefine`：卸载并删除临时定义。

它的关键边界是：

- 定义仅存在当前进程内，不写插件文件、不改 `cordis.yml`、不跨重启自动恢复。
- Host 与 Browser 可以组成双端插件；Browser half 的运行需要用户明确允许或拒绝。
- 重复运行、并发运行、过期 revision 和停止都有显式终态。
- 模型可查看由源码生成的 API、事件和 UI slot 目录，减少凭空猜测接口。
- `node:vm` 只隔离全局对象，**不是安全边界**；动态插件可访问受注入服务，应按获得 Bash 权限看待。

这项能力的产品价值不只是“现场写一个工具”：智能体可以临时添加运行时服务、策略或 UI，再通过同一插件生命周期安全撤销。它把“智能体适应任务”从修改提示词提升到重新组合自身能力。

## 9. 插件架构带来的产品价值

### 同一产品可以形成真正不同的智能体

Web、headless、极简模式、代码模式和 Creator 模式不是在固定智能体上切换几个开关，而是装配不同的能力树。开发者也可以为某类任务制作只含必要权限、工具和 Provider 的 Preset。

### 替换能力不会迫使上层分叉

工具依赖抽象能力，部署者替换 Provider 即可改变执行地点、模型供应商、持久化后端或子智能体实现。上层交互和 Agent Loop 不需要了解每种基础设施。

### 动态变化能够收干净

可逆效果与 Fiber 生命周期让 HMR、配置更新、会话销毁和插件停用共享同一清理模型。对长期运行且不断变更能力的智能体，这比“注册后永远存在”的传统扩展表更可靠。

### 可检查、可解释、可重放

最终配置可 dump，运行时服务和事件可 inspect，模型输入由日志重建，公共目录由源码生成并由门禁验证。复杂性没有消失，但系统为复杂性提供了观察入口。

### 正常用户可以只使用成品组合

普通用户可以直接启动 Web Profile，不需要理解 Cordis；高级用户再进入 Profile、Preset 和插件层。插件架构的产品成功取决于是否始终保留这种“默认成品、按需揭示复杂度”的分层体验。

## 10. 必须付出的成本

### 10.1 架构与认知成本

Profile、Bundle、Patch、Preset、Scope、Context、Service、Fiber、Effect 和多类 Event 各自解决不同问题，但共同构成较高学习门槛。能力被拆成 Definition、Provider、Consumer 后，包数量、依赖图和跨包追踪成本显著增加。

官方为此维护生成式模块图、能力图、事件生产消费图、配置目录、API 目录和多种结构门禁。这些不是附属文档，而是控制架构复杂度所必需的基础设施。

### 10.2 装配故障具有系统性影响

启动采用 fail-loud 与事务式装配：必需插件导入失败、等待不到服务或激活失败时，启动器清理部分插件树并拒绝启动，而不是静默降级。这样能防止“看似启动、实际缺能力”，代价是一个错误的关键配置或插件可能使整个 Profile 无法启动。

运行中的用户 patch 更新失败会保留上一棵可用树，但冷启动前写入的坏配置仍需要外部修复。插件生态越开放，兼容性检查、回滚入口和安全编辑体验越重要。

### 10.3 插件不是权限隔离

普通插件是同进程受信任代码，用户 Preset 的权限等同于其引用的插件；动态插件的 VM 也明确不是安全边界。Cordis 解决的是生命周期与依赖组合，不是恶意代码隔离。

真正的安全仍依赖权限策略、审批、文件系统边界、subprocess Provider 和操作系统沙箱。把“不可信插件市场”直接建立在当前同进程模型之上并不安全。

### 10.4 生命周期正确性需要严格纪律

框架只能撤销已登记的效果。插件若在 `ctx.effect()` 之外创建资源，仍可能泄漏；多个异步 disposer 会并发启动，需要严格顺序时必须放在同一个 disposer 中自行 await。深度动态系统对插件作者的生命周期素养要求高。

### 10.5 类型与构建系统更复杂

Host/Client Context 声明合并冲突迫使仓库维护两个 TypeScript 聚合程序，再由 Typert 生成跨端投影。大量目录和图由生成器维护，并需要 freshness gate。它换来了跨端插件一致性，但提高了构建、发布和故障定位成本。

### 10.6 资源与性能结论尚不充分

官方没有提供足以隔离“插件架构本身开销”的公开基准，因此不能断言 Cordis 明显更快或更慢。现有文档能确认的成本包括：

- 被替代的 Preset generation 当前不会回收，反复编辑会积累插件子树与文件 watcher，直到进程结束。
- 运行时扫描、配置重组和生成目录会增加工程与启动工作。
- 插件改变系统提示或工具 schema 时，模型请求前缀会变化，可能降低 KV Cache 复用率。
- 动态 Browser half 在无人连接时可能一直等待到发起 Turn 被取消。

这些问题目前均有明确边界，但在长期运行和大规模第三方插件生态下仍需实测。

### 10.7 兼容性成本尚未稳定

当前仍是预览版，官方明确不承诺避免破坏性变更。插件系统的价值依赖稳定的 Context key、事件、配置和生命周期合同；在这些接口稳定之前，第三方插件作者需要承担较高跟随成本。

## 11. 哪些是创新，哪些是已有技术的组合

单看依赖注入、事件总线、插件加载、YAML 配置、HMR 或服务注册，它们都不是新概念。DeepSeek Harness 的创新在于把这些机制一致地下沉到智能体几乎所有产品层，并用三组约束把自由度收住：

1. Cordis 的反应式依赖与可逆效果，约束运行时组合。
2. Session log 的“模型可见即已记录”，约束状态与恢复。
3. Definition / Provider / Consumer，约束能力替换边界。

再加上会话作用域、双端插件、运行时自检查和临时自修改，它形成了一个传统“工具插件系统”没有的完整闭包。

最值得肯定的是：它没有为了“万物皆插件”把 Agent Loop 变成任意代码拼接。循环仍有明确最小职责，扩展点由事件和服务承载；持久事实仍须进入会话日志；动态代码也没有伪装成安全沙箱。这些克制使架构具备长期演进的可能。

需要警惕的是：**插件化是手段，不是产品价值本身。** 如果普通用户必须理解装配层、手工修复插件冲突或承受不兼容，架构自由度会反过来损害体验。它的长期成败取决于默认 Profile 是否足够可靠、插件兼容与恢复是否足够自动，以及复杂度是否始终只向真正需要它的人揭示。

## 12. 最终判断

| 维度 | 判断 |
|---|---|
| 核心架构 | 前沿且自洽；插件深度、生命周期模型和状态闭包均超出普通智能体扩展系统 |
| 技术实现 | 已形成真实产品链路，不是概念原型；源码、文档、装配树和生成门禁互相约束 |
| 产品价值 | 对专用智能体、研究平台、自定义工作流和运行时能力生成有显著价值 |
| 产品复杂度 | 高；必须依靠优秀默认组合、渐进揭示和故障恢复把复杂度挡在普通用户之外 |
| 安全性 | 具备权限与沙箱能力，但插件本身是受信任代码；动态 VM 不是安全边界 |
| 性能 | 缺少足以评价插件机制净开销的公开证据，当前不宜下强结论 |
| 成熟度 | Developer Preview；适合研究、试用和扩展开发，不应视为接口稳定的成熟平台 |

一句话总结：**DeepSeek Harness 最重要的贡献，是把“智能体由能力组成”从架构口号落实成了可装配、可撤销、可作用域隔离、可重放且能临时自修改的运行时模型；它的上限很高，而眼下最大的风险也正是这份自由度带来的复杂性、信任与兼容成本。**

## 主要资料

- [官方仓库与 Developer Preview 声明](https://github.com/deepseek-ai/deepseek-harness)
- [最新预发布版本 `v0.1.0-rc.7`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)
- [官方架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/architecture.md)
- [Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/cordis-primer.md)
- [Cordis 时空可组合性论文摘要](https://github.com/cordiverse/paper)
- [开发与 Host/Client 构建说明](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/development.md)
- [包与能力族总图](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/README.md)
- [Profile、Bundle 与启动装配](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/boot/app-boot/README.md)
- [每会话 Preset 与作用域模型](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/preset/agent-presets/README.md)
- [Agent Loop 与扩展点](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/agent-loop/README.md)
- [运行时自修改工具与信任边界](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/extensions/tool-cordis/README.md)
- [Web UI 用户旅程](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/user/guide/index.md)
