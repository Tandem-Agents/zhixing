# 智能体架构分析与对比

## DeepSeek Harness

DeepSeek Harness 的核心架构是以 Cordis Context 承载运行时，以声明式服务依赖和可逆 Effect 管理插件生命周期，再通过 Profile、Bundle、Preset 与 Scope 分层组合模型、Agent Loop、会话、能力和 UI。

## OpenClaw

OpenClaw 的核心架构是以单个常驻 Gateway 统一持有通道连接、路由、会话与事件控制面，把入站消息按绑定映射到隔离的 Agent/Session，并由按模型选择的内置或插件 Agent Runtime 在会话串行边界内完成上下文、模型—工具循环、持久化和回复投递。

## Hermes Agent

Hermes Agent 的核心架构是以单一 `AIAgent` 工具调用循环统一承载 CLI、Gateway、ACP、批处理和 API，把模型适配、自注册工具/插件与隔离执行后端接入同一会话内核，并以 Profile 隔离的 SQLite 会话、有限记忆和可演化 Skills 构成跨会话学习闭环。

## OpenCode

OpenCode 的核心架构是以按项目目录隔离的本地 Server 统一持有持久化 Session 与模型—工具执行循环，再通过同一 OpenAPI/事件流把状态投影给 TUI、Web、Desktop、IDE 和 SDK，并在 Provider、Tool、MCP、Agent 与 Plugin 边界扩展能力。

## Pi Agent Harness

Pi 的核心架构是把统一多 Provider 模型调用、事件驱动 Agent Loop、会话/工具产品装配与 TUI 拆成可独立复用的薄层，再由同进程 TypeScript 扩展在最外层重组几乎全部 Coding Agent 行为。

## OpenAI Codex

Codex 的核心架构是以 Rust `codex-core` 将每个 Thread 建模为提交/事件双队列驱动的状态化 Agent Runtime，统一拥有模型—工具循环、沙箱审批、耐久历史与子 Agent 图，再由 TUI/Exec 直接调用，或经 App Server 与 CLI JSONL 以 Thread/Turn/Item 语义投影给 IDE、SDK 和其他客户端。

---

## 纯架构判断

不存在脱离目标的唯一最优架构，但绝不是“大家都最优、无法比较”。它们完全可以比较，而且优劣相当明显。

现有“一句话架构”足以识别各项目的核心取舍，却不足以单独证明谁最优。严谨比较还必须加入：职责边界、事实源、生命周期、恢复、安全、扩展成本、复杂度和产品目标适配度。

- **综合最强：OpenAI Codex**
  Thread Runtime、双队列协议、工具主链、沙箱审批、耐久历史、多 Agent 和多客户端投影形成完整闭环。架构最成熟，但也最重。

- **最简洁、最优雅：Pi**
  模型、Agent Loop、产品装配和 UI 分层最干净，可复用性最好；代价是把安全和工作流一致性更多交给用户与扩展生态。

- **插件组合思想最先进：DeepSeek Harness**
  声明式依赖、可逆 Effect 和分层装配非常强，但认知与运行复杂度高。它是最优插件容器架构，不是当前最优成品架构。

- **本地多客户端 Server 架构最好：OpenCode**
  项目级 Server 统一 Session 和执行事实的方向优秀，但 V1/V2 过渡造成重复与结构不稳定。

- **长期在线个人助手架构最好：OpenClaw**
  Gateway 控制平面与其多通道、多设备目标高度匹配，但中心化、高权限和多 Runtime 带来较大复杂度。

- **Hermes Agent 架构相对最弱**
  能力很强，但编排过度集中、动态注册面广，功能增长速度超过了结构收敛速度。

因此，如果问题是“做一个成熟、可靠、面向用户的顶级 Coding Agent，哪套纯架构最好”，目前答案是 **Codex**；如果问题是“用最少概念构建可塑造的 Agent Harness”，答案是 **Pi**；如果问题是“构建一切皆插件的 Agent 平台”，答案是 **DeepSeek Harness**。

乔布斯式判断下，真正的最优不是最灵活，而是**让正确行为自然发生，同时把内部复杂度完全藏住**。按这个标准，Codex 当前综合领先；Pi 最有架构美感；DeepSeek Harness 最有思想突破性。现有一句话架构对比可以用于定位，但还不能单独承担“裁定最优”的功能。
