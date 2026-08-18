# Hermes Agent 架构调研

> **调研日期**：2026-08-18  
> **源码快照**：`main`，提交 `a168237`，根包版本 `0.20.4`  
> **范围**：独立分析 Hermes Agent 的技术栈、核心架构、Agent Loop、工具与插件、学习闭环、状态、部署、安全边界、产品价值、成本与成熟度；不讨论其他项目如何借鉴或迁移。

## 结论

Hermes Agent 的本质是一个**以共享 Agent Runtime 为中心、可从终端、消息平台、桌面、IDE、API 和定时任务进入的自托管个人智能体系统**。不同入口最终复用同一套 `AIAgent` 会话与工具循环；模型供应商、工具、执行环境和部分上下文能力围绕它替换，SQLite 会话、有限记忆和可演化 Skills 则把一次性执行延伸为跨会话学习。

它最有辨识度的架构选择有三项：

- **一个执行内核服务全部入口**：CLI、Gateway、ACP、批处理、API 和 Cron 不各自实现一套智能体，而是把平台差异留在入口和回调层。
- **把模型、工具和执行地点分开**：多种模型协议先收敛到统一内部消息格式；工具经中央 Registry 暴露；终端执行可落在本机、容器、SSH 或按需云环境。
- **用外部可审计状态实现“自我改进”**：模型权重不会在本机继续训练；Hermes 通过有限记忆、会话检索、Agent 创建或修订的 Skills、后台复盘与 Curator 维护，把经验转成下一次可复用的上下文和过程知识。

独立判断是：**Hermes Agent 已具备一线通用个人智能体的能力广度和真实产品闭包，但其功能架构明显领先于代码结构的整洁度。** 共享内核、Profile 隔离、模型可替换、工具后端和学习闭环方向正确；与此同时，超大编排文件、导入期注册、数量庞大的可变扩展面和极快发布节奏增加了理解、测试和兼容成本。它已经是可用产品，而不是概念原型；但不能把“功能极全”误判为“架构已经足够简单或稳定”。

## 1. 项目状态与技术栈

本次调研固定在 `main@a168237`。该快照的 `pyproject.toml` 版本为 `0.20.4`，高于调研时 GitHub 最新稳定发布 `v0.20.3`，因此本文描述的是当前主干方向，不把尚未进入稳定版本的细节当成已发布承诺。

| 层面 | 当前实现 |
|---|---|
| 主语言与运行时 | Python 3.11～3.13；桌面、TUI 和部分 Web 界面同时使用 TypeScript/Node.js |
| 核心执行 | `AIAgent` 统一会话、模型调用、工具循环、重试、压缩、持久化与回调 |
| 模型层 | OpenAI-compatible Chat Completions、OpenAI Responses/Codex、Anthropic Messages 三类传输模式，外加多 Provider 解析与回退 |
| 工具层 | 中央 Registry、自注册工具、Toolset、MCP 和插件工具；官方架构文档记录 70+ 工具、约 28 个 Toolset |
| 执行后端 | Local、Docker、SSH、Singularity、Modal、Daytona、Vercel Sandbox |
| 用户入口 | CLI/TUI、Desktop、消息 Gateway、ACP、API Server、Python Library、Batch Runner、Cron |
| 状态 | Profile 级 `HERMES_HOME`；SQLite + FTS5 会话库；`MEMORY.md`、`USER.md`、Skills 和配置文件 |
| 扩展 | Python 插件、Skills、MCP、模型/记忆/上下文 Provider、消息平台适配器 |
| 发布 | MIT；官方安装器、Python 包、桌面与容器形态并存 |

依赖策略体现了明显的供应链防御意识：核心依赖多数精确锁定，特定 Provider 和重型能力进入可选依赖并按需安装。不过，Python、Node、原生组件、桌面、多消息平台和多个远程后端共同存在，也意味着发布矩阵和依赖治理本身已经是系统的重要成本。

## 2. 核心架构

```text
CLI / TUI     Messaging Gateway     Desktop / Web     ACP / API / Batch / Cron
     \                |                   |                    /
      └──────────── Profile-scoped entry adapters ────────────┘
                                |
                         shared AIAgent runtime
             prompt · provider · conversation · tool loop · callbacks
                     /                 |                 \
          Provider adapters      Tool Registry       Context plugins
      chat / responses / anthropic   MCP / plugins    memory / compression
                     \                 |                 /
                Local / Docker / SSH / serverless environments
                                |
             SQLite sessions + bounded memory + evolvable skills
```

一句话概括：**Hermes Agent 的核心架构是以单一 `AIAgent` 工具调用循环统一承载 CLI、Gateway、ACP、批处理和 API，把模型适配、自注册工具/插件与隔离执行后端接入同一会话内核，并以 Profile 隔离的 SQLite 会话、有限记忆和可演化 Skills 构成跨会话学习闭环。**

这不是 Gateway 中心架构。Gateway 是长期持有消息平台连接、鉴权、路由和投递的入口，但本地 CLI 可以绕过 Gateway 直接运行同一个 `AIAgent`；真正定义智能体行为的是共享 Runtime，而不是某个渠道进程。

它也不是“Everything is a Plugin”。`AIAgent`、内部消息模型、工具调度、会话库、Profile 路径和默认 CLI/Gateway 都是明确核心；插件在核心提供的工具、Hook、Provider、平台和命令缝上扩展。

## 3. Agent Loop：统一执行内核

一次回合的主链为：

```text
用户输入
  → 装配或复用稳定 system prompt
  → 必要时预压缩上下文
  → 解析 Provider 与 API mode
  → 可中断模型请求
  → 返回工具调用？
       是 → 审批/Hook → 执行工具 → 结果写回历史 → 再请求模型
       否 → 持久化会话与记忆 → 返回最终结果
```

三类模型协议在边界处适配，进入核心后都收敛到 OpenAI 风格的 `role/content/tool_calls` 内部消息结构。这降低了 Provider 对上层工具循环的侵入，也使 CLI、Gateway 与 ACP 能复用同一历史和回调模型。

当前源码已开始把 `run_agent.py` 中的循环搬到 `agent/conversation_loop.py`：`AIAgent.run_conversation()` 是转发入口，实际循环位于后者。官方架构文档仍把完整循环概括在 `run_agent.py`，说明主干处于持续拆分阶段；这是文件归属变化，不是运行模型改变。

工具调用可以并行，但交互式工具保持串行，结果按原始调用顺序写回。模型请求和工具执行都支持中断；被丢弃的半成品不会注入历史。迭代预算、模型回退、上下文压缩和记忆 flush 均由同一 Runtime 协调。

## 4. Prompt、上下文与 Provider 分层

系统提示由稳定、上下文和易变层按固定顺序装配，包含身份、工具说明、Skills、项目上下文、记忆、用户画像和时间信息。对支持前缀缓存的模型，稳定层可以复用；压缩负责在窗口压力下保留近期消息和完整工具调用对。

Provider 解析将“用哪个模型”和“走哪种协议、凭据与端点”分开。主会话、Gateway、Cron、ACP 和辅助任务共享解析边界，而视觉、压缩、检索等辅助任务可以拥有独立回退链。这种分层使用户能切换模型供应商而不改 Agent Loop。

代价是支持矩阵持续扩大：不同协议对消息交替、推理内容、工具调用 ID、缓存和流式事件的要求并不相同，统一内部格式只能收敛共同语义，无法消除每个适配器的兼容工作。

## 5. 工具、Toolset 与执行环境

内置工具在模块导入时注册到单例 `ToolRegistry`。发现器先用 AST 找到含顶层 `registry.register()` 的文件，再导入触发注册；`check_fn` 决定工具当前是否可用，Toolset 决定某个入口向模型暴露哪些能力。MCP 与插件工具随后进入同一调度面。

这套机制的价值是：

- 新工具无需维护第二份手工目录；模型 schema、处理器、可用性和元数据在同一注册点绑定。
- 可选依赖缺失时工具可以不进入模型上下文，而不是让调用后才失败。
- 平台入口可以用 Toolset 控制能力组合，MCP 和插件无需另建工具循环。
- 终端工具与执行后端分离，同一上层能力可运行在本机、容器、SSH 或按需环境。

它的结构成本也明确存在：注册发生在导入期，真实工具集合依赖模块扫描、环境、配置与插件加载顺序；动态 schema、Agent 内部截获工具和 Registry 调度同时存在，理解一次调用有时需要跨越多层。自动发现减少了目录维护，却增加了隐式启动行为。

## 6. 会话、Profile 与状态边界

SQLite 是会话与消息历史的主要持久化层，FTS5 提供跨会话检索；压缩会形成可追踪的 Session lineage。Gateway、CLI 和工作树智能体可以并发访问数据库，当前实现使用 WAL、短超时和带抖动的应用层重试收敛写竞争。

Profile 是完整智能体状态边界。每个 Profile 拥有独立的：

- 配置、凭据和人格文件；
- SQLite 会话、记忆、Skills 与 Cron；
- Gateway PID、平台令牌、日志和运行状态。

Profile 不是工作目录，也不是安全沙箱。官方明确要求不要让两个独立 Agent 进程共享同一个 Profile，因为自动记忆写入会互相污染；需要多个智能体时应使用不同 Profile。这个边界对用户清晰，但也说明 Hermes Home 尚不是多写者共享状态系统。

## 7. 学习闭环：不是训练模型，而是更新可复用状态

Hermes 所称的“self-improving”由四层共同构成：

1. **有限记忆**：`MEMORY.md` 保存环境和经验，`USER.md` 保存用户偏好；二者有严格字符上限并在会话开始时冻结进 Prompt。
2. **会话检索**：SQLite FTS5 保留完整历史，Agent 可按需查找过去对话，不必把全部历史塞进每次请求。
3. **可演化 Skills**：Skills 采用渐进披露；Agent 可以把一次复杂任务提炼成 Skill，也可以在使用中补充步骤、陷阱和参考资料。
4. **后台复盘与 Curator**：回合后的后台 Agent fork 可提炼记忆或 Skill；Curator 在空闲期审查、合并或归档长期不用的 Skills，并提供快照、审计账本和回滚。

因此，Hermes 的“成长”是**Prompt 外部知识与程序性说明的持续维护**，不是修改基础模型权重。它的优势是可见、可编辑、可撤销、成本远低于训练；局限是这些状态仍依赖模型正确提炼，错误经验也可能被带入后续会话。

系统通过容量上限、写入审批、通知、威胁扫描、归档而非自动删除、备份和 ledger 降低风险。方向是合理的，但“默认允许后台更新记忆与 Skills”仍然是一项产品取舍：它换来连续成长，也要求用户信任提炼模型和维护机制。

## 8. 子 Agent、脚本化工具调用与自动化

`delegate_task` 创建新的 `AIAgent` 子实例。子 Agent 拥有全新对话、独立终端和自己的迭代预算，只继承工具能力；父会话历史不会自动复制，只有显式传入的目标与上下文以及最终摘要进入双方边界。批量委派可并行执行，避免把所有中间轨迹挤进主上下文。

这种隔离能控制上下文成本，也迫使父 Agent 明确交付信息。它不是共享记忆的多 Agent 社会：子 Agent 默认不知道父会话发生了什么，协作质量取决于委派合同是否完整。

Cron 运行的是完整 Agent 任务而非 shell 定时器，可以附带 Skills、使用模型和工具并投递到任意平台。代码执行工具还允许脚本通过 RPC 调用已有工具，把确定性流水线从多个模型回合压缩成一次程序执行。两者扩展了无人值守能力，也放大了审批、凭据、超时和环境隔离的重要性。

## 9. Gateway 与多入口产品闭包

Gateway 是长驻消息适配层，负责平台连接、发送者授权、Session key、Slash command、Hook、Cron tick 和回复投递。Telegram、Discord、Slack、WhatsApp、Signal 等入口最终创建或复用相同会话 Runtime，因此渠道不是独立智能体。

入口层通过 callback 把 Agent 状态投影成终端 spinner、消息进度、推理块、交互确认和流式输出。这个设计保持核心与平台解耦，同时让每个平台可以用自己的交互组件承载批准和澄清。

Profile 允许同一机器运行多套 Gateway，每套有独立令牌和状态；令牌锁避免两个 Profile 意外抢占同一平台身份。Gateway 扩展了可达性，但不是强制控制面：只用本地终端的用户不需要运行它。

## 10. 插件架构及其边界

Hermes 插件可注册工具、Hook、Slash command、CLI command、Skills 和平台适配器。来源包括内置目录、用户目录、项目目录和 Python entry point；普通第三方插件默认需显式启用，安装时执行静态安全扫描并记录来源。

插件体系实际分为不同合同：

- 通用插件可多选，主要增加工具、Hook 和命令；
- 模型 Provider 可同时注册多个，由用户选择；
- Memory Provider 与 Context Engine 属于单选槽；
- Skills 和 MCP 是更窄的扩展边界，不必加载同进程 Python 代码。

插件不是安全沙箱。启用后它与 Hermes 运行在同一 Python 进程和 OS 用户权限下；能力声明、扫描和 opt-in 能改善知情同意，不能把恶意插件变成低权限代码。真正的不可信执行仍应放在容器、远程后端或操作系统边界中。

## 11. 安全模型

主要安全层包括：

- 消息发送者 allowlist 与私聊配对；
- 危险命令识别、人工或智能审批及超时拒绝；
- 无法绕过的灾难性命令 hardline blocklist；
- 文件写入敏感路径保护和可选 safe root；
- MCP 凭据过滤、上下文注入扫描和输入清理；
- Docker、Singularity、Modal 等隔离执行环境；
- Profile、Session 和 Cron 状态边界。

真实边界是：默认本机终端能力仍可触达用户机器，`smart` 审批依赖辅助模型判断已知危险模式，原生插件属于受信任代码，Profile 隔离也不等于 OS 隔离。Hermes 提供了较完整的防线，但其安全目标是帮助单一操作者控制高权限 Agent，而不是在同一进程内承载彼此敌对的租户或插件。

## 12. 产品价值与架构成本

### 产品价值

- **同一能力，多种自然入口**：终端、聊天软件、桌面和 IDE 共享 Agent Runtime，用户不必在不同客户端重建智能体。
- **模型自由度高**：Provider 与 Agent Loop 分离，用户可在不同模型和凭据方案间切换。
- **行动范围广**：工具、MCP、浏览器、文件、终端、计算机使用和多种执行后端覆盖个人与开发任务。
- **经验能积累**：记忆、检索、Skills 和后台复盘形成真实可见的跨会话学习，而不是营销式“记住一切”。
- **可从本机扩到云端**：执行环境和 Gateway 允许 Agent 留在 VPS 或按需环境中，由用户从消息平台访问。
- **高级能力按需出现**：只用 CLI 的用户不必理解 Gateway、Profile、插件或远程后端。

### 架构成本

- **核心编排仍高度集中**：快照中的 `run_agent.py`、`agent/conversation_loop.py`、`cli.py` 和 `gateway/run.py` 都是超大文件；仓库自身也把拆分这些 god-files 列为持续目标。职责在概念上分层，不代表代码依赖已经充分解耦。
- **隐式注册与动态组合增加追踪成本**：工具、插件、Hook、Provider、Toolset 和环境可用性共同决定运行时表面，静态阅读一个入口无法得到完整能力集合。
- **学习状态会漂移**：记忆、Skills、后台复盘、Curator 和外部 Memory Provider 都可能改变未来行为；备份与审批能恢复，但测试确定性和用户理解成本不会消失。
- **扩展与平台矩阵巨大**：模型协议、消息平台、桌面、语音、浏览器、远程执行和可选依赖都会独立变化。
- **发布节奏过快**：主干已领先最新稳定版，近期稳定发布之间包含大量改动。能力增长很快，但下游集成应固定版本并以正式发布合同为准。
- **Profile 是隔离单位而非共享运行时**：多 Agent 需要多个 Home；同 Home 多写者可能污染记忆，跨实例共享状态需要额外 Provider。

## 13. 独立判断

| 维度 | 判断 |
|---|---|
| 核心架构 | 方向清楚：共享 AIAgent、统一消息模型、工具 Registry、Profile 状态边界共同形成可复用内核 |
| Agent 能力 | 很强；工具、模型、子 Agent、自动化、远程环境、MCP、语音和多入口均有正式实现 |
| 学习机制 | 有辨识度且边界诚实；通过外部记忆和 Skills 演化，不伪称本地训练模型 |
| 产品闭包 | 强；安装、配置、Gateway、桌面、Profile、更新、诊断与安全设置已覆盖长期使用 |
| 扩展性 | 强，但不是深度插件化内核；核心 Runtime 固定，插件扩展多个既有能力缝 |
| 安全性 | 对单操作者高权限 Agent 较完整；默认本机执行、同进程插件和智能审批仍需明确理解 |
| 可维护性 | 概念分层优于代码结构；god-files、导入副作用和高速变化是当前主要结构风险 |
| 成熟度 | 已有稳定发布和完整产品面，但主干仍快速重构，不宜把所有当前内部接口视为稳定合同 |

最终判断：**Hermes Agent 的领先之处，不是某一种新 Agent Loop，而是把一个共享工具调用内核与多入口、可替换模型、远程执行和可审计学习状态组合成了能长期使用的个人智能体。它已经达到顶级开源智能体的能力层级；下一阶段最重要的不是继续增加能力数量，而是降低核心编排集中度、收紧动态扩展的可解释性，并用较慢、更稳定的公共合同承接高速创新。**

## 主要资料

- [官方仓库快照 `a168237`](https://github.com/NousResearch/hermes-agent/tree/a1682376ca37abe3fcfd30a1febed25ca3678d9d)
- [README：产品定位、入口、能力与安装](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/README.md)
- [版本、运行时、依赖与命令入口](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/pyproject.toml)
- [稳定发布记录](https://github.com/NousResearch/hermes-agent/releases)
- [官方系统架构图](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/developer-guide/architecture.md)
- [Agent Loop](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/developer-guide/agent-loop.md)
- [当前 Conversation Loop 实现](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/agent/conversation_loop.py)
- [工具 Registry、Toolset 与执行环境](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/developer-guide/tools-runtime.md)
- [会话库与 FTS5](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/hermes_state.py)
- [有限记忆、会话检索与后台复盘](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/user-guide/features/memory.md)
- [Skills 与渐进披露](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/user-guide/features/skills.md)
- [Curator 的归档、审计与回滚](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/user-guide/features/curator.md)
- [子 Agent 委派](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/user-guide/features/delegation.md)
- [Profile 状态隔离](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/user-guide/profiles.md)
- [插件能力与信任边界](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/user-guide/features/plugins.md)
- [安全模型](https://github.com/NousResearch/hermes-agent/blob/a1682376ca37abe3fcfd30a1febed25ca3678d9d/website/docs/user-guide/security.md)
