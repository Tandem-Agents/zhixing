# Pi Agent Harness 架构调研

> **调研日期**：2026-08-18  
> **源码快照**：`main`，提交 `2509b5c037d366979f2febfce4174b88aeaadc6a`，Coding Agent 版本 `0.84.2`  
> **范围**：独立分析当前正式 Pi 的技术栈、核心架构、Agent Loop、会话、扩展、安全边界、产品价值与演进方向；不讨论其他项目如何借鉴或迁移。

## 结论

Pi 的架构中心不是终端界面，也不是一个无所不包的插件容器，而是一个**刻意保持很小、可嵌入的分层 Agent Harness**：`pi-ai` 统一模型调用，`pi-agent-core` 只负责状态化的模型—工具循环与事件，`pi-coding-agent` 再装配会话、编码工具、资源和交互形态，扩展只在最外层重组产品行为。

它最有辨识度的设计有四项：

- **内核与成品明确分层**：模型协议、Agent Loop、Coding Agent 和 TUI 都是独立包，嵌入者不必连整套终端产品一起采用。
- **应用消息不污染模型合同**：Agent Core 允许产品定义自己的消息，再通过显式转换把应用上下文投影为模型上下文。
- **会话是可分叉的完整事实**：正式 Coding Agent 用追加式 JSONL 会话树保存消息、模型变化、压缩、分支摘要和扩展状态，压缩不删除原始历史。
- **扩展承担产品选择，核心拒绝无限膨胀**：工具、命令、Provider、权限确认、压缩、UI、MCP、子 Agent 和计划模式都能由同进程 TypeScript 扩展实现，而不必写入固定内核。

独立判断是：**Pi 是目前架构辨识度最高的开源 Coding Agent Harness 之一；它最强的不是默认功能最多，而是以很少的稳定概念同时服务终端用户、扩展作者和嵌入者。代价也同样明确：默认进程拥有用户全部权限，扩展是完全受信任代码，许多产品级安全与工作流一致性被交给用户或生态自行组合。**

## 1. 项目状态与技术栈

本次调研对象是当前官方仓库 [`earendil-works/pi`](https://github.com/earendil-works/pi)。旧仓库路径已迁移到该组织；固定快照为 `main@2509b5c`，许可证为 MIT。

| 层面 | 当前实现 |
|---|---|
| 主语言与运行时 | TypeScript ESM；正式 npm 包要求 Node.js 22.19+ |
| 工程组织 | npm workspaces monorepo，核心能力按包分层发布 |
| 模型层 | `pi-ai` 统一 Provider、模型目录、认证、流式事件与工具调用 |
| Agent 内核 | `pi-agent-core` 维护内存状态、模型—工具循环、队列和事件流 |
| 产品层 | `pi-coding-agent` 装配会话、编码工具、资源加载、TUI、JSON、RPC 与 SDK |
| 会话事实 | 本地追加式 JSONL，会话条目以 `id/parentId` 形成树 |
| 扩展 | 由 `jiti` 直接加载 TypeScript；支持 npm、Git 和本地 Pi Package |
| 终端 UI | 独立 `pi-tui` 包，以差分渲染提供交互界面 |
| 独立交付 | npm 包为主，也用 Bun 生成多平台独立可执行文件 |
| 远程方向 | Protocol、Client、Server 与 SQLite Session Backend 已进入仓库，但仍明确标为实验能力 |

仓库对依赖供应链采取了少见的严格策略：直接依赖固定版本、锁文件作为唯一安装事实、发布包带 shrinkwrap、安装与更新默认禁止生命周期脚本，并在发布流程审计依赖签名和脚本白名单。这不是 Agent 架构本身，却是其“可安装扩展型工具”能够长期可信交付的重要底座。

## 2. 核心架构

```text
Provider SDK / Custom Provider / Local Model
                  │
        pi-ai：统一模型、认证、流式事件
                  │
 pi-agent-core：状态 + Agent Loop + Tool + Queue + Event
                  │
 pi-coding-agent：AgentSession / SessionManager / ResourceLoader
        │                 │                    │
  read/write/edit/bash   JSONL 会话树      Extensions / Skills / Packages
        │                 │                    │
        └──── Interactive TUI / Print / JSON / RPC / SDK ────┘
```

一句话概括：**Pi 的核心架构是把统一多 Provider 模型调用、事件驱动 Agent Loop、会话/工具产品装配与 TUI 拆成可独立复用的薄层，再由同进程 TypeScript 扩展在最外层重组几乎全部 Coding Agent 行为。**

这句话包含三个必须分开的责任层：

1. **`pi-ai` 是模型运行边界**：Provider 拥有模型目录、认证与具体流式行为，对上提供统一事件和可跨 Provider 转移的上下文。
2. **`pi-agent-core` 是最小智能体内核**：它拥有本次运行的状态、轮次、工具执行、消息队列与事件顺序，但不规定编码工具、UI 和耐久存储。
3. **`pi-coding-agent` 是用户可用的成品**：它把 Agent Core、文件与 Shell 工具、会话、项目上下文、扩展资源和多种交互入口装成 Coding Agent。

扩展性很强，但“Extension”并不是基础运行时：没有模型层和 Agent Loop，扩展无法独立成为 Pi；它们的角色是在成品层替换或介入既有责任。

## 3. 模型层：Provider 是运行单元

`pi-ai` 不把不同厂商都硬压成最低共同能力。Provider 自己拥有模型目录、认证和流式实现，公共层统一文本、思考、工具调用、完成与错误事件。内置目录和动态目录并存，Provider 工厂又允许按需加载 SDK，避免默认入口把所有厂商代码一次打包。

这带来三个直接价值：

- Agent Core 不需要知道 Anthropic、OpenAI、Google 或本地模型的具体协议。
- 同一会话上下文可以在 Provider 或模型之间切换，产品层不必重写历史。
- 自定义 Provider 可以只替换模型边界，不必复制 Agent Loop、会话和 UI。

成本是 Provider 能力差异仍然客观存在。统一事件降低了上层复杂度，却不能消除工具协议、推理块、缓存、上下文限制和供应商兼容变化的维护面。

## 4. Agent Core：事件驱动但有明确结算边界

Agent Core 的一个 turn 是一次模型调用及其产生的工具执行；只要模型继续发出工具调用，Agent Loop 就继续推进后续 turn。公共事件覆盖 Agent、Turn、Message 和 Tool Execution 的开始、增量与结束，因此 UI、日志、扩展和 SDK 可以观察同一执行事实。

它不是简单的 `while(toolCall)`：

- 工具可并行或串行执行，并允许工具级覆盖默认策略。
- `beforeToolCall`、`afterToolCall` 和 `shouldStopAfterTurn` 提供窄生命周期钩子。
- 高层 `Agent` 会等待 assistant `message_end` 订阅者完成，再进入工具预检；结束监听者也属于结算范围。
- 监听器按注册顺序等待，关键效果不会因“事件已发出”就被误认为完成。
- `prompt()`、`abort()` 和 `waitForIdle()` 给嵌入者清楚的运行所有权。

这种设计最重要的价值是：事件既能支撑流式 UI，又没有牺牲关键阶段的顺序确定性。低层 `agentLoop()` 更接近可观察事件流，高层 `Agent` 则提供更严格的屏障语义，调用者可以按需要选择抽象层次。

## 5. 消息桥：应用上下文与模型上下文分离

Agent Core 允许应用扩展 `AgentMessage`。Coding Agent 因此可以保存 Bash 输出、分支摘要、压缩摘要和扩展自定义消息，而不要求所有内容都直接成为某家模型 API 的消息格式。

两个显式函数守住边界：

- `transformContext` 在模型调用前调整应用上下文。
- `convertToLlm` 把应用消息投影成模型真正消费的消息。

这是一个很小但长期价值很高的设计：产品状态可以演化，模型合同仍保持有限；跨 Provider 切换时也不必让每个产品消息了解所有底层协议。

## 6. 队列：运行中输入有不同语义

Pi 把用户在 Agent 工作期间的新输入分为两类：

- **Steering**：当前 assistant turn 的工具执行结束后注入，用于改变正在推进的方向。
- **Follow-up**：Agent 原本准备停止后才注入，用于追加下一项工作。

两者有独立队列和清理接口，Coding Agent 又把 Enter 与 Alt+Enter 映射到这两种语义。它避免了“所有运行中消息都塞进同一个队列”造成的意图混淆，也让交互层不用改动 Agent Loop。

## 7. 会话：追加式 JSONL 树，而不是聊天数组

正式 Coding Agent 的会话保存在按工作目录组织的 JSONL 文件中。除头部外，每个条目都有 `id` 与 `parentId`，所以一次会话天然是一棵树：

- `/tree` 在同一文件中移动当前叶子并创建新分支。
- `/fork` 从旧节点复制到新会话文件。
- `/clone` 把当前活动路径复制成新会话。
- 模型和思考级别变化、标签、扩展条目、压缩与分支摘要都作为显式条目记录。

上下文压缩是有损模型投影，不是历史删除。原始条目继续留在 JSONL 中；新的压缩检查点还可携带 retained tail，使上下文重建不必再次遍历被压缩的全部旧条目。

这套方案非常适合单机 Coding Agent：文件可读、可导出、可迁移，分支不需要数据库。代价是它不是天然的多进程并发事务存储；仓库中新出现的 SQLite backend 和远程 Session Protocol 正在探索另一类部署需求，但不能反过来冒充当前稳定 CLI 的会话事实。

## 8. Coding Agent：薄默认值，而非固定工作流

默认产品只给模型四个核心工具：`read`、`write`、`edit`、`bash`；CLI 还提供 `grep`、`find`、`ls` 等可选择工具。项目规则由从全局到工作目录逐层发现的 `AGENTS.md` 或 `CLAUDE.md` 注入，系统提示可以替换或追加。

Pi 同时提供四种正式使用形态：

- 交互式 TUI。
- Print 或 JSON 事件输出的一次性运行。
- 基于 stdin/stdout 严格 JSONL framing 的 RPC 模式。
- 直接创建 `AgentSession` 或 `AgentSessionRuntime` 的 TypeScript SDK。

`AgentSessionRuntime` 专门拥有新建、恢复、切换、分叉和导入造成的活动 Session 替换，并要求调用者在替换后重新订阅、重新绑定扩展。这说明 Pi 没有把“换会话”伪装成原 Session 对象的普通状态修改，而是承认 cwd 相关资源与运行时实例都可能需要重建。

## 9. 扩展系统：能力最强，也最需要信任

扩展是由 `jiti` 直接载入的 TypeScript 模块，可以：

- 注册或替换模型工具、命令、快捷键、参数和 Provider。
- 拦截工具调用、注入上下文、改变压缩和摘要。
- 添加 TUI 组件、状态栏、编辑器、弹层与自定义渲染。
- 通过会话自定义条目保存跨重启状态。
- 接入 MCP、子 Agent、SSH、沙箱或任意外部系统。

全局和项目扩展可被 `/reload` 热加载；异步扩展工厂会在会话启动前被等待。文档还明确要求长期资源在 `session_start` 后创建，并由幂等的 `session_shutdown` 清理，避免只执行配置命令时意外留下后台进程。

Pi Package 把 Extension、Skill、Prompt Template 和 Theme 作为一个可经 npm、Git 或本地路径分发的资源包。项目包只有在项目被用户信任后才会安装和执行，非交互模式则使用显式的默认信任策略或一次性参数。

这套机制确实能让用户“不改 Pi 内核就改 Pi”。但它不是隔离插件：扩展拥有宿主进程完整权限，Skills 也能引导模型执行任意动作。灵活性来自信任，而不是来自能力沙箱。

## 10. 有意不内建：产品哲学也是边界

Pi 明确不默认提供 MCP、子 Agent、权限弹窗、计划模式、内置 Todo 和后台 Bash。理由不是这些能力无用，而是每项都有多种合理产品选择；Pi 选择让用户通过扩展、Skill、CLI 或 tmux 组合自己的方案。

这个取舍的价值是：

- 核心概念少，新工作流不必等待上游接受。
- 不同团队可以选择完全不同的权限、计划和多 Agent 语义。
- 成品和 SDK 共用同一小内核，扩展不会迫使嵌入者接受整套产品意见。

它的成本也不能回避：

- 新用户可能必须先理解生态，才能获得其他产品默认就有的体验。
- 同一需求存在多个互不兼容的扩展方案，产品心智模型可能碎片化。
- 权限、恢复和子 Agent 等高风险能力由生态实现时，质量与安全下限不再由核心统一保证。

因此，“最小”在 Pi 中既是架构优势，也是明确的产品责任转移。

## 11. 安全边界

官方非常直接地声明：Pi 没有内建限制文件系统、进程、网络或凭据访问的权限系统，默认拥有启动用户和宿主进程的全部权限。用户确认弹窗也不是默认能力。

项目信任只解决“是否加载项目设置、自动安装项目包和执行项目扩展”，不限制模型已经拥有的内置文件与 Shell 工具。Pi Package 同样是完全受信任代码。

需要更强边界时，官方建议把隔离放到 Agent 外部：

- Gondolin 扩展把工具和 `!` 命令送入本地 Linux micro-VM，模型认证仍留在宿主。
- Plain Docker 把整个 Pi 进程放入容器。
- OpenShell 提供策略化沙箱。

这一选择架构上自洽：核心没有假装提供半套沙箱。但从普通用户产品看，它仍是 Pi 最重要的风险——默认易用性高，误操作和恶意扩展的影响半径也等于用户进程权限。

## 12. 实验性远程层：真实存在，但尚非稳定中心

仓库已经加入 Protocol、Client、Server 和 Node SQLite Session Backend：

- Protocol 用严格 schema、长度前缀 CBOR framing 和版本 hello 定义远程会话合同。
- Client 通过 transport-neutral 接口附着多个 Session，以权威快照而非乐观 progress 作为状态事实。
- Session Lease 区分独占与共享获取，生命周期显式释放。
- SQLite backend 提供 migration、materialized view 和可重建 FTS。

这些包显示 Pi 正从“可嵌入的本地 Harness”向可远程承载的 Session Runtime 演进。不过协议文档仍明确说明 v1 实验性、没有兼容保证，Server 包本身也标为 experimental。当前评价应把它视为可信方向和实际代码，不应计入稳定 Pi Coding Agent 的冻结承诺。

## 13. 产品价值与架构成本

### 产品价值

- **默认可用而核心不臃肿**：安装后就有模型、会话、TUI 和编码工具，复杂能力又能按需加载。
- **用户可以塑造产品**：扩展不仅加工具，还能改变模型、消息、压缩、UI 和工作流。
- **嵌入路径真实**：Agent Core、SDK、JSON 与 RPC 都复用正式运行时，而不是为演示另写一套 Loop。
- **会话探索自然**：JSONL 树把回退、分叉和完整历史统一成一个可理解模型。
- **多模型切换成本低**：统一 Provider 事件和应用消息桥让模型选择不侵入产品内核。
- **复杂度显性外置**：MCP、多 Agent、计划和后台任务没有以半成品形式污染核心。

### 架构成本

- **默认没有最小权限防线**：模型工具、扩展和宿主共享用户权限，安全依赖信任或外部隔离。
- **扩展组合缺少统一产品保证**：多个扩展可同时改工具、消息、UI 和生命周期，组合行为需要用户承担验证成本。
- **功能发现依赖生态**：高级能力不内建时，用户必须先找到、理解并信任合适方案。
- **本地文件会话不是分布式事实源**：它非常适合单机，却不自动解决多进程、多设备和远程租约问题。
- **Provider 面持续变化**：统一 API 仍需长期追踪厂商协议和认证变化。
- **实验远程层带来双重认知**：稳定 JSONL Coding Agent 与实验 Server/SQLite 不能混用成熟度判断。

## 14. 独立判断

| 维度 | 判断 |
|---|---|
| 核心架构 | 优秀；模型、Agent Loop、产品装配和 UI 的薄层边界清楚 |
| Coding Agent 能力 | 默认能力克制但闭环完整；高级能力主要由扩展生态提供 |
| 可嵌入性 | 很强；低层事件流、高层 Agent、AgentSession、RPC 和 SDK 形成连续抽象梯度 |
| 扩展性 | 极强；能改变几乎全部产品行为，但扩展不是隔离插件 |
| 会话与恢复 | 单机形态设计优秀；树状历史、压缩和分支统一，远程耐久层仍实验中 |
| 产品体验 | 面向愿意塑造工具的高级用户非常好；希望默认得到完整工作流的用户门槛较高 |
| 安全性 | 对可信本地开发者诚实但偏弱；强安全依赖项目信任之外的外部沙箱 |
| 可维护性 | 核心职责小且清晰；Provider 数量、扩展组合和新远程层是主要维护压力 |
| 成熟度 | 正式 Coding Agent 已成熟可用；远程 Server/Protocol 不应提前算作稳定能力 |

最终判断：**Pi 已经是顶级开源 Coding Agent Harness，但它追求的“顶级”不是为所有用户预装同一种工作流，而是以最少且可复用的核心，让用户和开发者能把 Agent 改造成自己的工具。这个方向经得起时间检验；要让它从顶级 Harness 进一步成为对更广泛用户同样顶级的产品，最关键的不是继续扩大扩展面，而是让可信扩展的发现、组合和默认安全边界更低成本、更一致。**

## 主要资料

- [官方仓库快照 `2509b5c`](https://github.com/earendil-works/pi/tree/2509b5c037d366979f2febfce4174b88aeaadc6a)
- [根 README：包结构、权限与发布边界](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/README.md)
- [Coding Agent README：产品能力、模式与哲学](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/README.md)
- [pi-ai：Provider、模型和统一事件](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/ai/README.md)
- [pi-agent-core：状态、事件、工具与消息队列](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/agent/README.md)
- [Agent 高层屏障实现](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/agent/src/agent.ts)
- [Extension 合同与生命周期](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/extensions.md)
- [Pi Package 分发与信任边界](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/packages.md)
- [Session 与树状分支](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/sessions.md)
- [JSONL Session 格式](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/session-format.md)
- [SDK 与 AgentSessionRuntime](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/sdk.md)
- [容器化与外部安全边界](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/containerization.md)
- [实验 Protocol 合同](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/protocol/README.md)
- [实验 Client 与 Session Lease](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/client/README.md)
- [SQLite Session Backend](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/session-backends/sqlite-node/README.md)

