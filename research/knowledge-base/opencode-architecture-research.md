# OpenCode 架构调研

> **调研日期**：2026-08-18  
> **源码快照**：`dev`，提交 `4e81a0b73f6e614afebf9c7ff8862904a3674455`，仓库版本 `1.18.18`  
> **范围**：独立分析当前正式 OpenCode 的技术栈、核心架构、运行时、状态、扩展、安全边界、产品价值与演进风险；不讨论其他项目如何借鉴或迁移。

## 结论

OpenCode 的架构中心不是终端界面，也不是插件系统，而是一个**按项目目录隔离、由本地 Server 统一持有的持久化编码智能体运行时**：Session、模型—工具循环、权限和项目状态留在服务端，TUI、Web、Desktop、IDE 与 SDK 通过同一 HTTP/OpenAPI 和事件合同使用它。

它最有价值的设计有四项：

- **一个行为合同承载所有客户端**：交互式 TUI 本身也是 Server 客户端；SDK 由 OpenAPI 生成，外部程序无需复制内部业务逻辑。
- **项目目录就是运行时隔离轴**：每个规范化目录拥有独立的项目上下文、配置、工具和会话作用域，同一进程可安全承载多个项目。
- **模型循环与扩展能力分层**：Session Loop 保持核心所有权，Provider、Tool、Agent、MCP、Skill 和 Plugin 在明确边界接入。
- **状态不是只存在于终端内存**：用户消息、模型输出、工具阶段和会话元数据写入 SQLite，并通过事件流投影给多个客户端。

独立判断是：**OpenCode 已经是架构完整、产品闭环真实的顶级开源 Coding Agent，最强之处是把“本地 CLI”做成了可复用的项目级 Agent Server；但仓库正处于 V1 向 V2 的深度重建期，稳定实现、新事件基础和 V2 目标架构同时存在，当前最大的结构风险不是能力不足，而是过渡期的重复概念、兼容桥和认知成本。**

## 1. 项目状态与技术栈

本次调研对象是当前正式维护的 [`anomalyco/opencode`](https://github.com/anomalyco/opencode)，不是已经归档的旧仓库。固定快照为 `dev@4e81a0b`；根包和主要应用版本为 `1.18.18`，许可证为 MIT。

| 层面 | 当前实现 |
|---|---|
| 主语言与运行时 | TypeScript ESM；Bun 负责开发、构建和自包含二进制 |
| 工程组织 | Bun workspace + Turborepo monorepo |
| 服务内核 | Effect 管理依赖图与作用域生命周期；Effect HTTP API 暴露 Server |
| 模型层 | Vercel AI SDK 与各 Provider SDK，统一模型、流式输出和工具调用边界 |
| 状态 | SQLite + Drizzle；Session、Message、Part、Todo 等项目级持久化事实 |
| 终端界面 | SolidJS + OpenTUI；默认通过 Worker 内的同一 Server Router 通信 |
| 其他客户端 | SolidJS Web、Electron Desktop、IDE 扩展和生成式 TypeScript SDK |
| 扩展 | Provider、Tool、Agent、MCP、Skill、Plugin 与项目/全局自定义工具 |
| 交付 | Linux、macOS、Windows 的 x64/arm64 自包含二进制及桌面形态 |

TypeScript/Effect 适合它真正解决的问题：协议、状态、工具、Provider 和多客户端编排。Bun 自包含二进制让用户不必先管理 Node 运行时；代价是构建矩阵、Bun 兼容和跨平台验证成为发布体系的一部分。

## 2. 核心架构

```text
TUI          Web / Desktop          IDE / SDK / 外部客户端
 │                 │                         │
 └──────── OpenAPI HTTP + SSE / in-memory fetch ────────┘
                              │
                  project-scoped local Server
        Router · Permission · Provider · Tool · Event projection
                              │
                    persistent Session runtime
             Prompt → Model stream → Tool → Persist → Continue
                   │             │              │
              Agents/Tasks   MCP/Plugins    SQLite/Event bus
                              │
                canonical project directory / worktree
```

一句话概括：**OpenCode 的核心架构是以按项目目录隔离的本地 Server 统一持有持久化 Session 与模型—工具执行循环，再通过同一 OpenAPI/事件流把状态投影给 TUI、Web、Desktop、IDE 和 SDK，并在 Provider、Tool、MCP、Agent 与 Plugin 边界扩展能力。**

这句话包含三个不能混淆的层次：

1. **Server 是行为所有者**：权限、Session、Provider、工具、项目实例和事件都在服务端收敛，客户端只消费公开合同。
2. **Session Runtime 是智能体内核**：它负责持久化输入、构造上下文、调用模型、执行工具、处理压缩/子任务并推进终态。
3. **扩展边界不是内核本身**：插件、MCP、Skills 和自定义工具改变能力面，但不会取代 Server、Session 与持久化的核心职责。

## 3. Client/Server：产品架构的真正锚点

官方文档明确说明，运行 `opencode` 会同时启动 TUI 与 Server，TUI 是 Server 的客户端；`opencode serve` 则只启动无界面的 HTTP Server。Server 提供 OpenAPI 文档、类型化 API 和 SSE 事件，因此同一运行时可被终端、网页、桌面、IDE 或自定义程序使用。

默认本地 TUI 又做了一层有价值的优化：若用户没有要求公开 host/port，它不会为了维持分层而强行打开网络端口，而是在 Worker 中创建同一 Server Router，通过代理的内存 `fetch` 和事件转发通信。这样既保留了唯一 API 合同，也避免本地默认路径承担无价值的监听和鉴权成本。

当用户显式启动网络 Server 时，默认仍绑定 loopback。远程访问需要用户自己配置鉴权和网络边界；官方会在未设置密码时警告 Server 未受保护。它是本地优先的可编程边界，不是默认开放的远程多租户服务。

## 4. 项目实例：以目录隔离运行时

Server 不用一个全局“当前项目”服务所有请求。请求携带目录后，运行时先规范化路径，再由 `InstanceStore` 为该目录创建或复用 `InstanceContext`；并发首次启动由同一个 deferred 结果收敛，避免重复装配。

每个实例包含项目、worktree、目录和作用域服务，关闭或重载时统一释放。由此得到清晰的产品边界：

- 用户可以在多个项目中并行使用 OpenCode，不会把目录、配置和工具上下文混成一套。
- Headless Server 可以服务多个目录，客户端不必为每个项目复制进程级业务逻辑。
- 项目级状态与全局 Provider/认证配置可以分层存在。
- 目录是隔离与定位轴，但不是 OS 安全沙箱；工具权限仍决定 Agent 能访问什么。

这种设计比“启动 CLI 时把 cwd 塞进若干全局变量”更适合长期运行和多客户端接入。

## 5. Session 与模型—工具循环

稳定运行主链为：

```text
用户输入先持久化
  → 同一 Session 取得唯一运行权
  → 读取历史、压缩状态与待处理任务
  → 解析 Agent、Model、Provider、Tools、Permission
  → 流式调用模型
  → 持久化 assistant/message/part/tool 状态
  → 有工具调用则执行并继续下一轮
  → 完成、错误或中止后形成可读取终态
```

几个关键选择决定了它不只是聊天循环：

- 用户消息在执行前落盘，输入不会只存在于 UI 的瞬时状态。
- 同一 Session 的执行被串行化，避免两次模型循环并发推进同一历史。
- 模型流的文本、推理、工具调用、工具结果、错误、用量和终态被转换成持久化 Part。
- Context 压缩、子任务和普通工具调用都在同一个 Session 控制面协调。
- Task 工具通过父子 Session 运行子 Agent，隔离历史并保留可追踪关系，而不是在主 Prompt 内伪装并发角色。

当前核心仍较集中，`SessionPrompt` 承担了大量流程编排。这让一次执行路径容易找到，却也使扩展、恢复和错误语义的改动容易触及大文件；V2 正试图把耐久输入、执行所有权与投影进一步分开。

## 6. 持久化与事件

SQLite 是稳定状态事实源。数据库启用 WAL、外键、busy timeout 和 `synchronous=NORMAL`；Session、Message、Part 与 Todo 形成可查询关系，Session 同时绑定项目、目录、父 Session、Agent、模型、权限、成本与 token 等信息。

事件负责把事实变化投影给客户端，而不是取代数据库：

- Server 通过 SSE 提供当前实例和全局事件流。
- TUI、Web 和其他客户端收到事件后更新界面，需要完整状态时仍可读公开 API。
- 仓库当前同时存在旧事件总线、向新事件系统的桥，以及 V2 的耐久序列/重放能力。

最后一点必须谨慎解读：新事件服务已经进入仓库并被部分桥接，不代表 V2 的全部耐久恢复合同已经交付。它是过渡中的基础设施，不应把设计文档里的最终形态冒充当前稳定行为。

## 7. Provider、工具、Agent 与扩展边界

Provider 层把模型目录、认证、SDK 差异和模型能力收敛到统一边界；Agent 决定模型、Prompt、权限与模式；Tool Registry 再汇总内置工具、自定义工具、插件工具和 MCP 工具。

稳定产品已包含文件读写、搜索、Shell、补丁、任务委派、Web、Todo、Skills 等编码所需能力。工具是否向模型可见、能否执行以及参数如何收窄，最终受 Agent 和 Permission 共同约束。

Plugin 可以订阅事件、修改配置、注册工具，并在模型参数、消息与工具执行前后介入；MCP 则把外部工具接到同一工具边界。插件按配置顺序执行 Hook，因此组合行为具有确定顺序，但进程内插件仍是受信任代码，不是隔离容器。

OpenCode 因此具有很强扩展性，但它不是“Everything is a Plugin”：

- Server、Instance、Session、持久化、权限和核心循环不是插件。
- 插件扩展既有能力缝，不拥有整个运行时生命周期。
- V2 正在扩大插件和 Effect Service 边界，但官方 V2 插件/SDK 文档仍标为 beta，不能倒推成稳定产品现状。

## 8. 权限与安全边界

权限规则采用 `allow`、`ask`、`deny`，可以按工具及路径/命令模式配置，并支持 Agent 覆盖。默认策略偏向让本地开发高效：多数常用操作允许，外部目录和循环异常会询问，`.env` 等敏感文件默认受限。

真实边界是：

- OpenCode 没有 OS 或容器沙箱；它面向用户本人控制的本地编码 Agent，不承诺隔离敌对代码。
- Tool Permission 以 `allow`、`ask`、`deny` 和外部目录检查限制公开工具，但 Shell 仍拥有宿主用户的文件、进程和网络权限，命令参数中的外部路径只接受尽力而为的告警；受信任插件也与宿主进程共享 OS 权限。
- Server 默认本地；远程暴露必须配置密码和外围网络保护。
- Session 分享默认由用户主动触发；分享会把会话内容上传并生成可访问链接，可通过配置完全禁用。
- “本地优先”不等于“完全离线”：模型 Provider、MCP 或用户配置的 Web 工具仍可能访问网络。

这套默认值适合个人 Coding Agent 的低摩擦体验；高敏感代码、企业环境或不可信插件需要更严格的 deny/ask 策略和外部隔离。

## 9. 多客户端产品闭包

OpenCode 的 UI 并不是几套各自实现的 Agent：

- TUI 用 OpenTUI 提供高密度终端交互。
- Web 与 Electron Desktop 复用 SolidJS 应用层。
- IDE 扩展把编辑器上下文和启动入口接入同一 Server。
- SDK 由 Server OpenAPI 生成，可创建内嵌 Server+Client，也可连接既有 Server。

因此，一个 Session 可以脱离某个终端窗口持续存在，新的客户端也不必重写模型循环、权限和持久化。这个架构真正打开了产品扩展空间：自动化、编辑器、桌面和远程控制都是同一核心的不同客户端，而不是维护多套行为近似的 Agent。

## 10. V2：目标架构，不是当前稳定产品

仓库正在进行一次实质性的 V2 重建。其明确方向包括：

- 依赖只能按 `Schema → Core/Protocol → Server → Client/SDK` 单向流动，Client 不得反向依赖 Server/Core。
- `sdk-next` 可以在同一 Effect Scope 内以内存 transport 使用正式 Server Router，不打开 listener，也不复制 Server 语义。
- 用户输入先进入耐久 inbox，再由 location-scoped runner 执行；接纳与执行所有权分离。
- 事件、projector、context epoch 和执行 ownership 获得更清楚的耐久合同。
- Plugin、Provider、Permission、Filesystem 等能力进一步服务化。

这是更清晰的长期方向，尤其改善依赖方向、嵌入式消费和输入接纳。但官方 V2 文档明确把 SDK/Plugin API 标为 beta，SDK 尚未作为外部稳定包发布；仓库待办仍列有配置、认证、Provider 注册、Plugin API、运行时等价和崩溃续跑缺口。

因此，评价 OpenCode 必须同时做到两点：承认 V2 架构方向先进；不把未完成设计计入当前产品能力。过渡期还会承担两套概念、桥接层、测试矩阵和迁移边界的成本。

## 11. 产品价值与架构成本

### 产品价值

- **默认路径直接**：用户进入项目运行命令即可工作，不必理解 Server、OpenAPI 或 Instance。
- **客户端不会分叉行为**：TUI、桌面、IDE 和 SDK 使用同一服务端事实与权限合同。
- **会话可观察、可恢复**：输入、输出、工具阶段和错误持久化，不依赖某个 UI 活着。
- **模型与能力可替换**：Provider、Agent、Tool、MCP、Skill 和 Plugin 在不同层替换，不把选择焊死在 Agent Loop 中。
- **多项目自然隔离**：目录级 Instance 让一个运行时承载多个项目，又不暴露内部拓扑给普通用户。
- **本地效率与架构完整兼得**：默认内存 transport 避免无意义网络成本，公开 Server 又保留自动化和多客户端能力。

### 架构成本

- **V1/V2 过渡复杂**：旧服务、新 Effect 服务、事件桥和两套文档共同存在，理解“当前事实”需要格外严格。
- **核心流程仍集中**：Session Prompt/Processor 周边职责较重，修改循环、工具和恢复边界时回归面较大。
- **插件边界正在变化**：稳定 V1 与 beta V2 的 API/生命周期不同，生态需要承担迁移成本。
- **高扩展面增加组合风险**：Provider、Agent、Tool、MCP、Plugin 与项目配置共同决定运行时行为，必须维持清楚的优先级和失败语义。
- **权限默认偏体验优先**：适合个人本地编码，但更强隔离需要用户或组织主动配置。
- **自包含交付有平台成本**：多 OS/架构二进制和桌面应用提高易用性，也增加构建、签名和发布治理负担。

## 12. 独立判断

| 维度 | 判断 |
|---|---|
| 核心架构 | 清晰且有辨识度；项目级本地 Server、持久 Session 与统一客户端合同构成稳定中心 |
| Coding Agent 能力 | 强；模型、工具、子 Agent、MCP、Skills、权限与多客户端均有真实生产闭包 |
| 产品体验 | 成熟；默认 TUI 简单，复杂 Server/SDK/Plugin 能力按需显现 |
| 扩展性 | 强但非全插件化；核心运行时固定，能力在多个受控边界扩展 |
| 状态与恢复 | 明显强于纯 CLI Loop；当前稳定版有持久化与事件投影，V2 的完整耐久执行仍未完成 |
| 安全性 | 对单一可信开发者自洽；默认策略重效率，远程、多租户和不可信插件需额外防线 |
| 可维护性 | 稳定架构概念清楚，但 V1/V2 并存使当前仓库认知与回归成本偏高 |
| 成熟度 | 已是可日常使用的正式产品；V2 是值得期待但不能提前计入的重建方向 |

最终判断：**OpenCode 已经达到顶级开源 Coding Agent 的能力与产品标准；它真正领先的不是“支持很多模型或工具”，而是让项目级 Agent Runtime 成为可持久、可编程、可被多个客户端一致消费的本地服务。它下一阶段最重要的工作不是继续堆能力，而是在不破坏稳定产品的前提下完成 V2 收敛，消除过渡期重复并冻结可信的扩展合同。**

## 主要资料

- [官方仓库快照 `4e81a0b`](https://github.com/anomalyco/opencode/tree/4e81a0b73f6e614afebf9c7ff8862904a3674455)
- [README：产品入口、安装与客户端](https://github.com/anomalyco/opencode/blob/4e81a0b73f6e614afebf9c7ff8862904a3674455/README.md)
- [根包技术栈与工程组织](https://github.com/anomalyco/opencode/blob/4e81a0b73f6e614afebf9c7ff8862904a3674455/package.json)
- [MIT 许可证](https://github.com/anomalyco/opencode/blob/4e81a0b73f6e614afebf9c7ff8862904a3674455/LICENSE)
- [Server：Client/Server、OpenAPI、SSE 与公开 API](https://opencode.ai/docs/server/)
- [SDK：由 Server API 生成的类型安全客户端](https://opencode.ai/docs/sdk/)
- [Agent 与子 Agent](https://opencode.ai/docs/agents/)
- [Permission 合同与默认边界](https://opencode.ai/docs/permissions/)
- [Plugin 能力与 Hook](https://opencode.ai/docs/plugins/)
- [Provider 配置与模型边界](https://opencode.ai/docs/providers/)
- [MCP 接入](https://opencode.ai/docs/mcp-servers/)
- [Skills](https://opencode.ai/docs/skills/)
- [Session 分享边界](https://opencode.ai/docs/share/)
- [V2 SDK：Effect Scope 与内存 transport](https://opencode.ai/v2/docs/build/sdk)
- [V2 Client](https://opencode.ai/v2/docs/build/client)
- [V2 Plugin API（beta）](https://opencode.ai/v2/docs/build/plugins)
- [V2 Permission](https://opencode.ai/v2/docs/permissions)
