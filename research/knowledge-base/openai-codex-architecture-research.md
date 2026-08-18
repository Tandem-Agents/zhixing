# OpenAI Codex 架构调研

> **调研日期**：2026-08-18  
> **源码快照**：`main`，提交 `711a5f8b3a6eb40134146ae9ec22fdcdda5e3170`  
> **范围**：独立分析当前开源 Codex 的技术栈、核心运行时、线程协议、工具执行、安全、会话、子 Agent、扩展、客户端边界与架构代价；不讨论其他项目如何借鉴或迁移，也不把未开源的 IDE 与 Codex cloud 实现推断为仓库事实。

## 结论

Codex 的架构中心不是终端界面，而是一个**以 Thread 为长期执行单元的 Rust Agent Runtime**。`codex-core` 统一拥有模型—工具循环、上下文、工具路由、权限审批、操作系统沙箱、压缩、恢复和子 Agent；客户端通过异步 Submission/Event 协议驱动它，丰富界面再经 App Server 把同一运行事实投影成稳定的 Thread/Turn/Item API。

它最有辨识度的设计有五项：

- **线程是运行时，不只是聊天记录**：一个 Thread 同时承载 Session 状态、输入队列、Turn 生命周期、工具效果、环境和持久化句柄。
- **控制与观察分离**：客户端把操作写入 Submission Queue，运行时把进度与终态写入 Event Queue，流式 UI、审批、steer、interrupt 和恢复都建立在同一异步边界上。
- **安全不是提示词约定**：沙箱限制技术上能做什么，approval policy 决定何时必须征得许可；两者是正交的正式运行合同。
- **多 Agent 是线程图**：子 Agent 是由同一个 `ThreadManager` 管理的独立 Thread，拥有自己的模型与工具工作，通过受控通信回到根线程，而不是在一段 Prompt 中模拟多个角色。
- **多产品面共享同一行为所有者**：本地 TUI/Exec 直接消费 Core，IDE、远程 TUI、Python SDK及其他丰富客户端消费 App Server，TypeScript SDK则包装 CLI；上层没有各写一套 Agent Loop。

独立判断是：**Codex 已经不是“轻量 CLI”的简单代码库，而是一套安全边界清楚、协议化程度高、可以承载多个产品面的成熟 Coding Agent Runtime。它的主要代价也来自这种成熟度：Rust 工作区和兼容面非常庞大，Core Session 持有的职责较多，开源本地运行时与未开源产品层之间存在必须明确说明的能力边界。**

## 1. 项目状态与技术栈

本次调研对象是 OpenAI 官方仓库 [`openai/codex`](https://github.com/openai/codex)，固定在 `main@711a5f8`。仓库采用 Apache-2.0 许可证；当前主体是 Rust 2024 edition 工作区，旧的 TypeScript CLI 目录不能代表现行架构中心。

| 层面 | 当前实现 |
|---|---|
| 核心语言 | Rust；`codex-rs` 是主实现与主要产品装配区 |
| 核心运行时 | `codex-core` 的 `ThreadManager → CodexThread → Session` |
| 控制协议 | `Op/Submission` 输入，`Event/EventMsg` 输出；异步 SQ/EQ 模式 |
| 公共产品模型 | Thread / Turn / Item |
| 工具系统 | Registry + Router + Runtime + 生命周期、并行、取消与审批 |
| 本地安全 | 平台原生操作系统沙箱 + 独立 approval policy；网络默认关闭 |
| 会话存储 | rollout JSONL 保存规范历史，SQLite 保存可查询 thread metadata |
| 多 Agent | 根线程作用域的 AgentControl、子线程图、受控消息与执行额度 |
| 富客户端接口 | App Server；JSON-RPC 风格协议，stdio JSONL 为默认传输 |
| 自动化接口 | Exec、TypeScript/Python SDK、MCP Server、App Server |
| 扩展入口 | AGENTS.md、Skills、MCP、Hooks、Plugins 与受控 Core extensions |
| 开源边界 | CLI、Core、App Server、SDK 开源；IDE extension 与 Codex cloud 不开源 |

工作区并不小：除 `core/protocol/tui/exec/app-server/thread-store` 外，还包含 model provider、MCP、skills、plugins、hooks、agent graph、sandbox、network proxy、state、rollout 等专责 crate。这说明当前 Codex 的真实定位是可复用的本地 Agent 平台，而不是只有一个交互循环的终端程序。

## 2. 核心架构

```text
                         OpenAI / compatible model provider
                                      │
                    ┌─────────────────▼─────────────────┐
                    │ codex-core                         │
                    │ ThreadManager                      │
                    │   └─ CodexThread ─ Session         │
                    │      ├─ Turn / context / compaction│
                    │      ├─ Tool Registry + Router     │
                    │      ├─ Sandbox + Approval         │
                    │      ├─ AgentControl / child graph │
                    │      └─ LiveThread persistence     │
                    └───────────────┬────────────────────┘
                       Submission SQ│Event EQ
                ┌───────────────────┴───────────────────┐
                │                                       │
          local TUI / Exec                      Codex App Server
                                                        │
                                          Thread / Turn / Item API
                                                        │
                                   IDE / remote TUI / Python SDK / clients

          TypeScript SDK ── spawn Codex CLI + stdin/stdout JSONL ──┘
```

一句话概括：**Codex 的核心架构是以 Rust `codex-core` 将每个 Thread 建模为提交/事件双队列驱动的状态化 Agent Runtime，统一拥有模型—工具循环、沙箱审批、耐久历史与子 Agent 图，再由 TUI/Exec 直接调用，或经 App Server 与 CLI JSONL 以 Thread/Turn/Item 语义投影给 IDE、SDK 和其他客户端。**

这里有三个不能混淆的边界：

1. **Core 是行为所有者**：决定 Turn 如何推进、工具如何执行、何时审批、如何恢复和怎样落盘。
2. **Protocol 是控制与观察边界**：客户端提交意图并消费事件，不直接修改 Session 内部状态。
3. **App Server 是产品投影层**：它为富客户端提供认证、历史、审批和结构化流事件，不再实现一套 Agent Loop。

## 3. Thread：长期运行身份

`ThreadManager` 创建并维护内存中的 Thread，也负责新建、恢复、分叉、父子关系和 thread store 协调。`CodexThread` 包装 `Session` 与 Session I/O，是调用方提交操作、读取事件、开始或 steer Turn、等待关闭的正式句柄。

Thread 配置快照不只包含模型名称，还包含 provider、service tier、推理设置、approval policy、permission profile、workspace roots、运行环境、personality、collaboration mode、history mode、父线程和 fork 来源。这说明 Thread 是一次可恢复的执行环境身份，而不是 `messages[]` 的别名。

`Session` 进一步持有当前对话历史、活动 Turn、输入队列、工具与扩展服务、环境、压缩和 rollout 状态。这样的聚合让一个 Thread 可以可靠地回答三个问题：

- 当前是否有 Turn 正在运行，新的输入应该启动、steer 还是排队。
- 当前工具调用属于哪个 Turn，取消、审批与终态应回到哪里。
- 进程中断后应从哪份历史和 metadata 恢复，而不是重新解释 UI 缓存。

代价是 Session 的责任面很宽。Codex 用多个内部 service、专责 crate 和 protocol type 控制这种复杂度，但它仍是未来维护中最容易形成“所有能力都向 Core 汇聚”的压力点。

## 4. Submission Queue / Event Queue：异步控制面

协议源码明确把客户端与 Agent 的通信定义为 SQ/EQ：

- 客户端提交 `Submission { id, op, trace, parent_turn_id, root_turn_id }`。
- 运行时产生带关联身份的 Event，客户端据此更新界面、处理审批或判断终态。

`Op` 覆盖用户输入、Turn steer、interrupt、shutdown、审批响应、环境选择和多 Agent 控制等行为；`EventMsg` 覆盖消息、推理、工具、计划、审批、错误、Turn 完成和 Thread 状态等结果。

这套模型的价值不是“用了队列”本身，而是把并发交互统一成一个顺序明确的协议：

- UI 不需要同步阻塞等待整个 Agent 完成。
- 用户可以在运行中 steering 或 interrupt。
- 工具审批是同一执行流中的请求/响应，而不是 UI 的旁路状态。
- 父 Turn、根 Turn 和子 Agent 活动可以被追踪和聚合。
- 本地界面与远程界面看到的是同一类运行事件。

## 5. Turn 与模型—工具循环

一个 Turn 从用户输入开始，在模型响应、工具调用、工具输出和后续模型调用之间推进，直到完成、失败或被取消。工具返回不是旁路日志，而是进入后续模型上下文的正式 Item。

工具执行核心被拆成几层：

- **ToolSpec / model-visible specs**：决定模型当前能看见什么。
- **ToolRegistry**：把稳定工具名映射到运行时和执行能力。
- **ToolRouter**：解析模型响应中的 function/custom/search call，形成统一 `ToolCall` 并分派。
- **Tool runtime 与 handler**：执行 shell、patch、MCP、搜索、多 Agent 等具体行为。
- **生命周期与并行控制**：统一处理取消、并行资格、终态和输出回传。

这种拆分让内置工具、MCP 工具、插件工具和 collaboration 工具最终穿过同一执行主链。扩展可以增加能力，但不需要复制模型—工具循环；安全策略也不必散落在每个界面。

值得注意的是，Codex 并非简单追求“工具越多越好”。Registry 区分模型可见工具与可延迟发现工具，Tool Search 可以按需暴露候选，避免把全部工具定义永久塞入上下文。这是庞大扩展生态下控制上下文成本的重要机制。

## 6. 安全：沙箱与审批正交

Codex 的本地安全合同分成两层：

- **Sandbox** 决定命令在技术上能读写哪些位置、能否访问网络，以及子进程继承什么限制。
- **Approval policy** 决定何时必须暂停并请求用户允许，例如越出沙箱、访问网络或执行未获信任的动作。

官方默认关闭网络，并用操作系统强制的沙箱限制本地命令；不同平台用不同底层实现承载同一个上层合同。这个结构优于把“请谨慎”写进 Prompt：模型即使判断错误，未获权限的效果仍由系统边界拦截。

它也有现实成本：

- macOS、Linux/WSL 和 Windows 的隔离能力与故障模式不同，平台实现必须长期保持语义一致。
- 插件、MCP、宿主工具和外部进程跨越的权限边界更复杂，工具是否 eligible for escalation 不能只由名称判断。
- 过多审批会破坏体验，过宽默认又会扩大影响半径，因此 permission profile 本身成为核心产品设计。

Codex 的正确方向不是消灭审批，而是让沙箱先给出可靠的默认边界，再只在真正跨界时让用户决策。

## 7. 会话与恢复：历史和索引分层

`ThreadStore` 是线程持久化边界。当前本地实现把两类事实分开：

- rollout JSONL 保存规范的历史 Item，追加接口只记录调用者给出的内容，不偷偷推断 metadata。
- SQLite 在可用时保存可查询的 Thread metadata，用于列表、过滤和快速恢复定位。

活动 Thread 通过 `LiveThread` 持有持久化句柄，统一处理规范追加、rollout policy 和 metadata 同步；冷 Thread 的 metadata 修改则经 `ThreadManager` 进入同一边界。

这个设计避免两个常见错误：一是让 UI 缓存成为恢复事实，二是让日志 recorder 顺便猜测标题、归档等 metadata。JSONL 保留可检查的执行历史，SQLite 承担查询效率；两者职责不同而不是互相争夺权威。

上下文压缩也与历史保存分离。压缩改变后续模型消费的上下文投影，但 Thread 历史和恢复身份不等于“只剩摘要”。这使长任务可以控制 token，同时仍保留审计与恢复所需的运行事实。

## 8. 多 Agent：根线程作用域的线程图

Codex 的子 Agent 不是同一 Session 中的角色标签。`AgentControl` 由根 Thread/Session 树创建并共享，负责：

- 通过 `ThreadManager` 生成和启动独立子 Thread。
- 保存根线程作用域的 Agent registry 与状态。
- 控制并发执行额度和 rollout budget。
- 发送 user input 或 inter-agent communication。
- 保留 parent thread、parent turn、root turn 与 fork history 身份。

子 Agent 可以继承完整历史或最近 N 个 Turn，也可以拥有不同角色配置、模型和环境。主线程通过消息与完成通知收集结果，客户端则可直接查看每个子线程状态。

这带来两个核心价值：

- 中间搜索、日志和试验不会全部污染主线程上下文。
- 并行工作有独立生命周期、取消和预算，而不是一个模型在 Prompt 中假装“同时思考”。

成本是 token、工具资源和线程调度都会增长。Codex 因此把 Agent registry 约束在根线程树，而不是全局共享，并设置 execution limiter 与 rollout budget；多 Agent 是有成本的执行能力，不是无条件默认的质量增强。

## 9. App Server：把运行时变成产品协议

App Server 是 Codex 为 VS Code 等富客户端提供的正式接口。协议采用 JSON-RPC 2.0 风格，默认通过 stdio 交换 JSONL，也支持面向特定场景的 WebSocket/Unix socket 传输。

它把 Core 的内部事件收束为三类稳定产品对象：

- **Thread**：可开始、恢复、分叉、归档的会话。
- **Turn**：一次用户输入到 Agent 终态的运行。
- **Item**：消息、推理、命令、文件修改、MCP 调用、审批等有类型的内容。

客户端先 initialize，再开始或恢复 Thread，并通过 notification 流观察 Turn 与 Item 的开始、增量和完成。协议还能生成与具体 Codex 版本一致的 TypeScript/JSON Schema，降低客户端手写漂移。

App Server 的长期价值是把“嵌入 Codex”从复刻 CLI 变成消费正式运行协议。代价是协议面已经很大，其中部分能力仍标为 experimental；稳定客户端必须根据成熟度区分正式合同与试验接口，不能把仓库里存在的方法都视为长期承诺。

## 10. SDK 与其他产品面

Codex 没有为每种入口复制 Core：

- **TUI / Exec**：作为 Rust 工作区的一部分，直接装配和消费本地 Core。
- **TypeScript SDK**：启动 `@openai/codex` CLI，通过 stdin/stdout JSONL 交换事件，提供 Thread、流式 Turn 和结构化输出。
- **Python SDK**：控制本地 App Server，并随发布包固定兼容的 Codex runtime。
- **IDE / 远程 TUI / 深度产品集成**：通过 App Server 消费历史、审批与流事件。
- **MCP Server**：当 Codex 只是更大编排中的一个编码专家时，把 Codex 能力作为 MCP 服务提供。

TypeScript SDK 选择进程边界而不是直接绑定 Rust 库，有额外启动与序列化成本，但换来三个优势：SDK 与用户实际 CLI 运行时一致、Node 应用无需链接 Rust ABI、升级边界由协议而不是内部类型决定。

## 11. 指令与扩展体系

Codex 的扩展面不是一种万能插件 API，而是按责任分层：

- **AGENTS.md**：从全局到项目当前目录建立有优先级的持久指令链。
- **Skills**：打包按需读取的专业工作流、资源和脚本。
- **MCP / Connectors**：连接外部工具与上下文；本地客户端共享同一 MCP 配置。
- **Hooks**：在窄生命周期点执行确定性集成。
- **Plugins**：组合 Skills、MCP、apps 等可发现能力，并由插件管理器装载。
- **Core extensions**：通过 Rust trait/专责 crate 接入受控的正式能力。

这套架构的核心原则是：扩展改变“可用能力和指导”，Core 仍拥有 Thread、Turn、工具分派、安全和持久化。它不像 Pi 那样允许任意同进程 TypeScript 扩展重写几乎全部产品行为，换来的则是更统一的安全下限与跨客户端一致性。

## 12. 模型与 Provider 边界

仓库存在独立 model-provider 抽象、模型管理，以及 Ollama、LM Studio 等本地适配代码，因此 Core 并非把每次调用硬编码成单一 HTTP 请求。不过 Codex 产品、提示、工具协议和质量优化仍以 OpenAI Codex 模型为中心。

因此更准确的判断是：

- 架构上有 Provider 边界，便于本地或兼容服务接入。
- 产品上不是以“任意 Provider 等价体验”为首要承诺。
- 统一接口只能隔离协议差异，无法让不同模型天然具备相同的工具理解、推理质量和安全行为。

## 13. 开源边界

官方明确列出：Codex CLI、SDK、App Server 与相关 Skills/Plugins 是开源组成；IDE extension 与 Codex cloud 不是开源组件。

这意味着本调研能确认的，是本地运行时、协议、终端入口、SDK 和 App Server 的真实架构。不能仅凭仓库中的 cloud client、backend model 或 protocol type，推断 OpenAI 托管调度、云端隔离、计费、队列和 IDE 内部实现也已开源。

这个边界不会削弱本地 Core 的价值，但会影响产品比较：

- 可以把开源 Codex 作为完整的本地 Coding Agent 与可嵌入 Runtime 评价。
- 不能把 ChatGPT/Codex cloud 的全部产品能力都算成 `openai/codex` 仓库能力。
- App Server 协议公开，不等于每个消费它的官方客户端源码公开。

## 14. 产品价值与架构成本

### 产品价值

- **一套行为，多种产品面**：CLI、自动化、IDE 和 SDK 不需要维护彼此分叉的 Agent Loop。
- **默认安全可执行**：沙箱先给技术边界，审批只处理真正的越界决策。
- **长任务可恢复**：Thread、Turn、Item、rollout 和 metadata 共同形成明确的恢复模型。
- **流式交互自然**：SQ/EQ 同时支持进度、审批、steer、interrupt 和终态。
- **多 Agent 可观察**：子工作是独立线程，用户和主 Agent 都能看到真实状态。
- **扩展不破坏核心心智模型**：AGENTS、Skills、MCP、Hooks 和 Plugins 都围绕同一个 Thread Runtime 工作。
- **嵌入路径分级清楚**：简单自动化用 SDK，深度产品集成用 App Server，更大编排用 MCP Server。

### 架构成本

- **工程体量很大**：Rust workspace crate 数量多，跨平台构建、协议生成和测试成本高。
- **Session 是高压聚合点**：模型、工具、环境、恢复、压缩和多 Agent 最终都要与 Session 协调。
- **协议兼容面持续扩大**：App Server 同时服务多个客户端，试验方法与稳定方法需要严格隔离。
- **跨平台安全难度高**：相同 permission contract 由不同 OS 原语实现，边界行为容易漂移。
- **扩展体系层次较多**：AGENTS、Skills、MCP、Hooks、Plugins、Core extension 各有边界，新用户需要理解何时用哪一种。
- **开源与托管能力容易混淆**：官方产品增长速度快，评价仓库时必须持续区分本地事实和未开源服务。
- **OpenAI 中心化明显**：Provider 抽象存在，但默认产品质量仍依赖 OpenAI 模型和服务演进。

## 15. 独立判断

| 维度 | 判断 |
|---|---|
| 核心架构 | 优秀；Thread Runtime、SQ/EQ、工具路由和客户端协议责任清楚 |
| Coding Agent 能力 | 顶级；编码、工具、安全、恢复、扩展和多 Agent 已形成完整闭环 |
| 多产品面一致性 | 很强；Core 与 App Server 避免 CLI、IDE、SDK 各自复制行为 |
| 安全性 | 开源 Coding Agent 中处于第一梯队；沙箱和审批分层是关键优势 |
| 会话与恢复 | 成熟；规范历史与查询 metadata 分层，长任务和中断恢复有正式身份 |
| 多 Agent | 架构扎实；以独立线程图和预算控制替代 Prompt 角色模拟 |
| 可嵌入性 | 很强；但 App Server/进程 SDK 比直接链接小型 Agent Core 更重 |
| 扩展性 | 广且受控；一致性和安全优先于无限制重写内核 |
| 可维护性 | 边界设计好，但整体规模、平台数和协议面带来显著长期成本 |
| 开源完整度 | 本地 Agent Runtime 很完整；IDE 与云端产品实现不在开源范围 |

最终判断：**Codex 已是顶级开源 Coding Agent，而且它的领先不只来自模型能力。真正经得起时间检验的是，它把长任务、工具副作用、安全授权、恢复、多 Agent 和多个客户端统一成一个有身份、有协议、有系统边界的 Thread Runtime。未来最大的风险不是能力不足，而是产品和协议继续扩张后，Core、App Server 与多层扩展能否继续保持有限责任和一致心智模型。**

## 主要资料

- [官方仓库快照 `711a5f8`](https://github.com/openai/codex/tree/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170)
- [根 README：产品入口与安装边界](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/README.md)
- [Protocol：Submission/Event 双队列合同](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/codex-rs/protocol/src/protocol.rs)
- [CodexThread：线程句柄与配置快照](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/codex-rs/core/src/codex_thread.rs)
- [ThreadManager：线程创建、恢复、分叉与关系管理](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/codex-rs/core/src/thread_manager.rs)
- [ToolRouter：模型工具调用的统一分派](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/codex-rs/core/src/tools/router.rs)
- [AgentControl：子 Agent 线程图与通信](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/codex-rs/core/src/agent/control.rs)
- [ThreadStore：规范历史与 metadata 的存储边界](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/codex-rs/thread-store/README.md)
- [App Server 仓库协议](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/codex-rs/app-server/README.md)
- [TypeScript SDK：CLI 进程与 JSONL 边界](https://github.com/openai/codex/blob/711a5f8b3a6eb40134146ae9ec22fdcdda5e3170/sdk/typescript/README.md)
- [官方 App Server 文档](https://developers.openai.com/codex/app-server)
- [官方 Codex SDK 文档](https://developers.openai.com/codex/sdk)
- [官方 Agent approvals & security 文档](https://developers.openai.com/codex/agent-approvals-security)
- [官方 Sandboxing 文档](https://developers.openai.com/codex/sandboxing)
- [官方 Subagents 文档](https://developers.openai.com/codex/subagents)
- [官方 MCP 文档](https://developers.openai.com/codex/mcp)
- [官方 AGENTS.md 文档](https://developers.openai.com/codex/guides/agents-md)
- [官方开源边界说明](https://developers.openai.com/codex/open-source)
