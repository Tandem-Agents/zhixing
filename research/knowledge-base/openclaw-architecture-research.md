# OpenClaw 架构调研

> **调研日期**：2026-08-18  
> **源码快照**：`main`，提交 `5e3e524`，根包版本 `2026.8.1`  
> **范围**：独立分析 OpenClaw 的技术栈、核心架构、运行时、扩展模型、状态、安全边界、产品价值、成本与成熟度；不讨论其他项目如何借鉴或迁移。

## 结论

OpenClaw 的本质不是一个聊天界面，也不是单独的 Agent Loop，而是一个长期运行在用户设备上的**个人智能体控制平面**：单个 Gateway 统一持有消息通道、会话、路由、事件、设备连接和公开控制接口，再把每条消息送入对应 Agent/Session，并交给当前模型所选择的 Agent Runtime 执行。

它最有价值的架构选择有三项：

- **用 Gateway 收拢产品闭包**：聊天渠道、Web/CLI/TUI、设备节点、模型、工具和回复投递共享同一控制面，用户可以在已有入口持续使用同一个智能体。
- **把人格、状态与运行引擎分层**：Agent 负责工作区、身份、认证和会话；Session 负责一段对话；Agent Runtime 负责一次模型—工具循环，三者不再与具体渠道或模型供应商绑定。
- **核心合同与可选能力分层**：路由、会话、策略和共享工具合同留在核心；渠道、模型能力、Agent Harness、工具、Hook、服务、技能和 MCP 通过插件体系扩展。

它不是“Everything is a Plugin”：Gateway、路由、会话、共享策略和内置 Runtime 都是有意保留的核心，插件在核心提供的能力缝上注册实现。这个选择牺牲了任意组合自由度，换来了面向真实用户的默认完整性、统一行为和运维闭包。

独立判断是：**OpenClaw 已经具备成熟个人智能体产品所需的广度和端到端闭包，但架构复杂度、安全责任与快速演进风险同样很高。** 它的强项不是某一种推理技巧，而是把多通道、多设备、多模型、多 Runtime、工具执行、状态恢复和用户操作面组织成了一个可长期运行的系统。它适合一个可信操作者使用；不应把同一 Gateway 当成敌对多租户边界，也不应把“默认能在主机执行工具”误解为默认沙箱安全。

## 1. 项目状态与技术栈

本次调研使用 `main@5e3e524`，而不是把历史文档或旧版本行为当作当前事实。该快照根包版本为 `2026.8.1`；调研时 GitHub 最新可见预发布为 `v2026.8.1-beta.2`，最新可见稳定发布为 `v2026.7.1-2`。官方愿景同时明确表示项目仍处于快速迭代期，当前优先级是安全、稳定性和首次使用体验。

| 层面 | 当前实现 |
|---|---|
| 主语言与运行时 | TypeScript、Node.js ESM；官方包支持多个受控 Node 版本范围 |
| 工程组织 | pnpm monorepo；根包、内部 packages、UI、平台应用和大量 extensions 共仓维护 |
| 核心进程 | 常驻 Gateway；同一端口复用 WebSocket RPC、HTTP API、插件路由、Control UI 与 Webhook |
| 控制端 | CLI、TUI、Web Control UI，以及 macOS/iOS/Android/Windows/Linux 相关应用或节点形态 |
| 智能体运行时 | 内置 `openclaw` Runtime，加上插件注册的 Codex、Copilot 等 Harness；外部 Harness 可经 ACP/ACPX 接入 |
| 模型层 | Provider/Model 与 Agent Runtime 分离；Runtime 在模型解析后按精确策略选择 |
| 状态 | Gateway 持有运行态；每个 Agent 使用独立 SQLite 会话与认证状态，兼容导入旧 JSON/JSONL 资产 |
| 扩展 | 原生代码插件、Bundle、Skills、MCP、Hooks、Provider、Channel、Tool、Service 与节点命令 |
| 安全 | 单操作者信任模型、设备配对、Gateway 鉴权、工具策略、执行审批和可选 Sandbox |

TypeScript 的选择与系统性质一致：OpenClaw 主要解决的是编排、协议、工具和集成，而不是训练或数值计算。代价是仓库规模和依赖面很大，构建、兼容、平台测试与发布治理本身已经成为产品能力的一部分。

## 2. 核心架构

```text
消息通道              Control UI / CLI / TUI          配对设备节点
    │                         │                           │
    └──────────── WebSocket / HTTP / 插件入口 ───────────┘
                              │
                    单个常驻 Gateway
          通道连接 · 鉴权 · 路由 · 会话 · 事件 · 状态 · 投递
                              │
                    binding 与 session key
                              │
                  Agent → 独立 Session/Workspace
                              │
             Provider + Model → Agent Runtime 选择
                     ┌────────┼────────┐
              内置 OpenClaw   Codex等插件   CLI/ACP 外部 Harness
                     └────────┼────────┘
                              │
             上下文 · 模型循环 · 工具 · 持久化 · 回复
```

一句话概括：**OpenClaw 的核心架构是以单个常驻 Gateway 统一持有通道连接、路由、会话与事件控制面，把入站消息按绑定映射到隔离的 Agent/Session，并由按模型选择的内置或插件 Agent Runtime 在会话串行边界内完成上下文、模型—工具循环、持久化和回复投递。**

这句话中的四层不能混为一谈：

1. **Gateway** 决定系统在哪里汇聚、由谁持有连接和控制面。
2. **Agent/Session** 决定消息属于哪套身份、工作区和历史。
3. **Provider/Model** 决定调用什么模型以及如何认证、发现和传输。
4. **Agent Runtime/Harness** 决定由哪套循环、原生工具和线程状态真正执行这一回合。

## 3. Gateway：中心控制面，而不是普通 API Server

Gateway 是 OpenClaw 架构的锚点。一个主机通常只运行一个 Gateway；它长期持有消息供应商连接，并为控制客户端和设备节点提供类型化 WebSocket 协议。默认端口同时服务 WebSocket、HTTP API、Control UI、插件 HTTP 路由和 Webhook。

这种单所有者设计带来明确收益：

- 通道登录、消息路由、会话并发、Agent 生命周期和设备状态不需要在多个进程之间争夺所有权。
- CLI、TUI、Web UI 和应用不各自复制业务状态，只作为同一控制面的客户端。
- 一次 Agent 调用先返回已接纳的 `runId`，后续 assistant/tool/lifecycle 事件及最终结果仍属于同一运行。
- 配置可热更新时原子替换完整内存快照；不能热更的变更由 Gateway 重启收敛。
- 配置损坏或反复启动失败时可以进入安全模式，保留控制面供用户修复，而不是继续启动全部渠道和 Provider。

相应代价是 Gateway 成为主要故障域和运维中心。它需要系统服务监督、严格状态目录隔离和清晰恢复路径；多 Gateway 不是默认扩容方式，而是需要独立配置、状态、工作区和端口的隔离部署。

## 4. 路由、Agent 与 Session

入站消息先通过 binding 选择 Agent，再由渠道、账号、对话对象和会话作用域生成稳定 session key。绑定采用确定性优先级，精确 peer、父 peer、角色、组织、账号和渠道依次匹配，最后才落到默认 Agent。

一个 Agent 是完整人格与状态边界，拥有自己的：

- Workspace 及 `AGENTS.md`、`SOUL.md`、`USER.md` 等上下文文件；
- Agent state directory、模型注册表和认证资料；
- SQLite 会话库、历史、路由状态和运行元数据；
- 模型、Skills、工具策略和 Sandbox 配置。

同一 Gateway 可以运行多个 Agent，也可以绑定多个渠道账号，但这只是核心状态隔离，不是敌对租户隔离。插件的全局存储不会因为增加 Agent 自动分片，操作者必须明确配置需要隔离的插件状态。

默认单 Agent 路径保持简单；多 Agent 只有在配置绑定后才显现。这个渐进边界是好的产品设计：普通用户不必为了系统具备多 Agent 能力而理解路由树，高级用户又能把不同号码、群组或工作身份映射到不同人格和会话库。

## 5. Agent Runtime：模型与执行循环解耦

当前 OpenClaw 已经把 Provider、Model、Runtime 和 Channel 明确分开：

- Provider 负责认证、模型发现和传输协议。
- Model 是一次回合所选择的具体模型。
- Agent Runtime/Harness 拥有模型循环、原生工具调用和完成回合的方式。
- Channel 只决定消息从哪里进入和回复到哪里。

内置 `openclaw` Runtime 由项目自身维护，包含上下文装配、模型流、工具循环、压缩、会话与 transcript 接线；插件可以注册其他 Harness，例如 Codex 或 Copilot。Runtime 策略绑定在 Provider/Model 上，精确模型优先，显式选择失败时 fail-closed；只有 `auto` 可以在无人认领时回落到内置 Runtime。

外部 Runtime 并不天然与内置 Runtime 等价。以 Codex 为例，Codex app-server 拥有原生模型循环、线程、原生工具和压缩；OpenClaw 仍拥有通道投递和外层 Session，并通过适配器桥接动态工具、Hook 和 transcript mirror。谁拥有事实，就由谁决定可编辑、可恢复和可观察的边界。

这套抽象的价值是：用户仍选择一个规范的 `provider/model`，执行引擎可以独立变化，而不必把渠道、模型名、认证方式和 Runtime 混成一个不可迁移的标识。成本是每个非内置 Harness 都必须维护明确的支持矩阵，不能假定工具、Hook、压缩和线程语义天然一致。

## 6. Agent Loop、并发与持久化

内置 Agent Loop 是按 Session 串行的一次运行：接收输入、组装上下文、调用模型、执行工具、流式输出、写入状态并交付回复。Gateway RPC 立即返回接纳信息，调用者可以继续订阅事件或用 `agent.wait` 等待终态。

关键一致性措施包括：

- 每个 Session 和全局队列共同约束并发，避免同一历史被无序推进。
- 耐久 writer claim 在输出前建立；每次追加或重写都校验预期 writer，过期运行不能继续提交。
- SQLite 写入经队列收束，Gateway state directory 另有进程级所有权锁。
- 每个 Agent 的 SQLite 是其会话和认证事实边界；旧 JSON/JSONL 主要承担导入、导出或归档兼容。
- 控制面事件不提供通用重放；客户端发现序列缺口后必须重新读取权威状态。

这里的架构取舍很清楚：OpenClaw 追求单机长期运行下的明确所有权和恢复，而不是把 Gateway 事件流做成分布式事件日志。它能降低产品和运维复杂度，但也意味着 Gateway 状态、数据库备份和客户端刷新合同非常关键。

## 7. 插件与能力边界

插件系统采用“核心定义 Capability，插件拥有实现”的模式。插件可以注册 Provider、Channel、Tool、Hook、HTTP Route、CLI Command、Service、Agent Harness、媒体能力和节点命令；核心消费者通过统一 Registry 和 Capability 合同调用，不直接依赖某家供应商实现。

加载分为四步：manifest/discovery、enablement/validation、runtime loading、surface consumption。Gateway 先建立 metadata snapshot 和启动计划，再按命令、渠道、Provider、Runtime 或能力需要激活插件，避免把所有可选代码无条件装入启动路径。

它和彻底插件化架构存在重要区别：

- Gateway、路由、Agent/Session、共享 `message` 工具、策略词汇和 Runtime 选择保留在核心。
- 插件负责供应商或功能的完整所有权，并实现核心定义的窄 Capability。
- Bundle 优先承载 Skills、MCP 和配置；确需深层运行时接入时才使用进程内代码插件。
- 原生代码插件与 Gateway 同进程、同信任边界；它不是权限隔离容器。

这种设计对成品产品更务实：默认行为由核心统一，插件又能覆盖足够大的产品面。代价是核心必须持续判断什么值得成为公共 Capability，并承担插件 SDK、兼容迁移、provenance 和安装安全治理。

Memory 是一个排他插件槽，同一时刻只选择一种实现；它与每个 Agent 的 SQLite 会话历史不是同一层。Skills 和 MCP 更适合走 Bundle 等较窄边界，只有需要运行时 Hook、Provider、Channel、Tool 或 Service 时才值得加载同进程代码插件。

## 8. 节点与跨设备拓扑

macOS、iOS、Android、Windows、Linux 或 headless node 通过同一个 Gateway WebSocket 以 `role: node` 连接，声明自身能力与命令。Gateway 负责设备身份、配对、允许命令快照和调用策略，Agent 再通过受控工具调用相机、屏幕、通知、位置、系统命令或设备数据。

节点不是复制 Gateway 状态的对等智能体，也不是自动形成一致性集群：

- Gateway 仍是会话、路由和控制面的唯一所有者。
- 节点只暴露本机实际实现并获准的能力；平台策略表只是上限。
- 新设备、身份升级和扩大命令面需要配对或重新批准。
- 隐私敏感和危险命令需要显式 allow；deny 始终优先。
- 节点断开只使该设备能力不可用，不把会话所有权迁到节点。

这个中心—边缘模型非常适合个人智能体：一个智能体可以触达多台设备，又不必在每台设备复制模型、渠道和会话系统。相应地，Gateway 的可达性决定跨设备能力是否可用。

## 9. 安全模型及其真实边界

OpenClaw 的正式安全模型是“一个可信操作者对应一个 Gateway 信任边界”。它不把同一 Gateway 内的多个 Agent、Session 或认证控制客户端当成相互敌对的租户。

已建立的安全机制包括：

- 未知私聊发送者默认配对或按 allowlist 限制；入站消息始终按不可信输入处理。
- Gateway 默认 loopback，并支持 token、设备身份、挑战签名、TLS/指纹和受控远程连接。
- Tool policy、exec approvals、节点命令 allow/deny、敏感命令二次 opt-in 和安全审计共同限制效果面。
- Sandbox 可按 Agent、Session 或共享范围选择 Docker、Podman、SSH、OpenShell；容器默认无网络、只读根和移除 Linux capabilities。
- 状态、配置、认证和插件来源有权限、provenance 与 doctor/audit 检查。

但默认边界必须说清楚：

- Sandbox 默认关闭，主 Session 的工具通常运行在 Gateway 主机上。
- Workspace 只是默认工作目录，不是硬隔离；不开 Sandbox 时绝对路径仍可访问主机其他位置。
- Gateway 本身从不进入 Agent Sandbox；elevated、插件和 MCP 能力还要经过各自策略。
- 原生插件是受信任的进程内代码。
- 多个不互信的人共享一个可执行工具的 Agent，会共享这个 Agent 获得的工具权限。

因此，它的安全不是“模型无法做危险动作”，而是“操作者明确控制谁能输入、模型能调用什么、效果在哪里执行”。对个人助手这是合理边界，对公开 SaaS 或敌对多租户则必须拆成独立 Gateway、OS 用户或主机。

## 10. 产品价值与架构成本

### 产品价值

- **入口自然**：用户可以继续使用既有聊天软件，也可以使用 Web、CLI、TUI 或平台应用，不需要围绕智能体学习一套唯一界面。
- **状态连续**：通道只是入口，Agent/Session 才是身份和历史边界，跨入口能力不会天然变成多套孤岛。
- **设备可达**：Gateway 通过配对节点把工具执行延伸到用户设备，而不要求每个节点运行完整控制面。
- **默认完整、按需展开**：单 Agent、本地 Gateway 和向导构成可工作的默认产品；多 Agent、插件、Sandbox 和外部 Harness 在需要时才出现。
- **模型与 Runtime 可替换**：模型供应商、认证、执行循环和渠道彼此解耦，避免用户选择被某一运行引擎锁死。
- **维护闭包真实存在**：daemon、doctor、audit、backup、safe mode、配置迁移和状态修复都是长期运行产品的必要部分，而不是演示脚本。

### 架构成本

- **中心化故障域**：Gateway 统一了所有权，也集中了承载压力与故障影响；可靠监督、备份和恢复不可省略。
- **状态模型复杂**：Agent、Session、Channel、Provider、Model、Runtime、Node 和 Plugin 都有独立身份，文档与 UI 必须防止用户把它们混淆。
- **Harness 语义不完全一致**：内置、Codex、Copilot、CLI 和 ACP 对工具、Hook、线程、压缩与终态的所有权不同，适配层必须诚实暴露差异。
- **安全默认偏能力优先**：主机工具和同进程插件能提供强大体验，也把正确配置、来源审查和 Sandbox 选择交给操作者。
- **渠道与平台维护面巨大**：消息供应商、移动权限、桌面应用、模型协议和外部 CLI 都会独立变化，兼容工作长期存在。
- **快速演进成本**：官方仍把安全、稳定和首次体验列为当前优先级，插件 Capability 合同也有仍在收敛的部分，不能把 `main` 上所有公开辅助接口都当成冻结 API。

## 11. 独立判断

| 维度 | 判断 |
|---|---|
| 核心架构 | 清晰而务实；单 Gateway 所有权、Agent/Session 隔离和 Runtime 分层共同形成完整控制面 |
| Agent 能力 | 广；内置循环、工具、Skills、子 Agent、外部 Harness 与多模型均有生产入口 |
| 产品闭包 | 很强；通道、设备、UI、daemon、doctor、安全审计、备份和恢复共同服务长期使用 |
| 扩展性 | 强但有边界；Capability/Registry 适合成品生态，不追求所有行为都可任意热替换 |
| 多设备 | 是中心—边缘设备能力网络，不是多主分布式 Agent 或状态复制系统 |
| 安全性 | 面向单可信操作者自洽；默认 Sandbox 关闭、进程内插件和主机工具需要用户理解真实风险 |
| 可维护性 | 核心职责有明确分层，但代码库和集成矩阵极大，长期维护成本高 |
| 成熟度 | 已是功能完整的真实产品；同时仍高速变化，官方也把稳定性和设置可靠性列为当前重点 |

最终判断：**OpenClaw 的领先之处在于把个人智能体从“会调用工具的对话循环”提升成了一个可在真实通道与设备上长期运行的控制平面。它的架构不是最纯粹的，也不是最小的，但与其产品目标高度一致；真正需要警惕的不是能力不足，而是中心控制面、多个 Runtime、广泛集成和高权限执行共同产生的系统复杂度与安全责任。**

## 主要资料

- [官方仓库快照 `5e3e524`](https://github.com/openclaw/openclaw/tree/5e3e52431e94317e80b08a3798cf32664e5b6d15)
- [发布记录](https://github.com/openclaw/openclaw/releases)
- [根包版本、入口与发布边界](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/package.json)
- [README：产品入口、Gateway、通道、节点与安装](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/README.md)
- [VISION：产品方向、核心与插件边界、安全和成熟度](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/VISION.md)
- [Gateway 架构与 WebSocket 协议](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/concepts/architecture.md)
- [Gateway 运行、热更新与安全模式](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/gateway/index.md)
- [Agent Runtime 架构与当前源码边界](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/agent-runtime-architecture.md)
- [Provider、Model、Runtime 与 Harness 分层](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/concepts/agent-runtimes.md)
- [Agent Loop、队列、writer claim 与事件](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/concepts/agent-loop.md)
- [Session 路由、生命周期与存储](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/concepts/session.md)
- [Multi-Agent 的隔离、绑定与限制](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/concepts/multi-agent.md)
- [插件 Capability、加载、所有权与兼容边界](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/plugins/architecture.md)
- [节点拓扑、配对、命令与权限](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/nodes/index.md)
- [安全模型与审计](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/gateway/security/index.md)
- [Sandbox 的模式、范围、后端与默认边界](https://github.com/openclaw/openclaw/blob/5e3e52431e94317e80b08a3798cf32664e5b6d15/docs/gateway/sandboxing.md)
