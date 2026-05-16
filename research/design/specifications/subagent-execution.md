# 子 Agent 体系(Sub-Agent Foundation)执行规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **本文档是执行规格(execution spec),不是修订日志。**
>
> **只写**:
> - 当前生效的架构、方案、执行计划
> - 架构决策及其"为什么"(帮助理解当前设计)
> - 与真实代码的对接点(精确到文件路径 + 行号)
>
> **不写**(协作者修订时一并清理,不要叠加):
> - 版本号、状态徽章、修订日期、"最后更新"行
> - `修订要点 / 修订历史 / vX.X vs vY.Y` 对比表
> - 决策演化标签(`v1.0 错误 / v2.0 修正 / v2.1 新增` 等)
> - 废案与新案的对比
> - 决策追溯链("当初这么想 → 后来审查发现 → 于是改成"这种叙事)
>
> **演化方式**:设计变化时**原地修改**,不追加"v2.1 修订段"。历史与演化留给 `git log`,不在本文。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **文件作用**:本文档是知行**子 agent 体系**的权威执行规格。设计决定(草稿层 12 项)在 [subagent-research.md](../drafts/subagent-research.md);本文是它们到具体字段、接口、数字、算法、测试拓扑、渐进式实现计划的精确落地。
>
> **核心架构选择(产品 + 工程双重决策)**:子 agent 的执行**完全内部于 Task 工具**——子的 LLM 调用、工具调用、中间步骤都是 Task 工具实现的内部循环,**不写独立 Turn 记录入 transcript**。从主 agent 的视角看,Task 是一个普通工具:接 `(description, prompt)`,返 `tool_result.content`(子最终文本)。这让架构与既有"AgentRuntime = 纯计算 / REPL · SessionRuntime = 持有 transcript 状态"的分层严丝合缝,不引入新的持久化机制和时序约束。
>
> 业界对照(详见 [source-analysis](../../source-analysis/)):
> - Claude Code 写 sidechain 文件 → 我们不写,子内部即用即弃
> - OpenClaw 起独立 sessionFile → 我们共享主 transcript,子不入 turn
> - Hermes 父子 SQLite 同库 + parent_session_id FK → 我们子不持久化,父 Turn.toolCalls 含 Task 调用记录
>
> **前置规格**(必读):
> - [interruptible-agent-loop-execution.md](./interruptible-agent-loop-execution.md) — 中断协议层,本规格继承其全部不变量
> - [remote-interruption-execution.md](./remote-interruption-execution.md) — 远程中断 / typed AbortReason 接入
> - [conversation-model.md](./conversation-model.md) — Conversation / SessionRuntime / Turn 生命周期
> - [tool-permission-execution.md](./tool-permission-execution.md) — SecurityPipeline / PermissionStore / ConfirmationBroker
> - [confirmation-ux.md](./confirmation-ux.md) — Resolver / Renderer 体系
> - [tools-builtin.md](./tools-builtin.md) — 现有 8 个 builtin 工具
> - [persistent-service.md](./persistent-service.md) §3.6 — 子 agent 在 daemon 拓扑中的位置
>
> **已建本仓基础**(本规格直接复用):
> - [packages/cli/src/run-agent.ts:96-128](../../../packages/cli/src/run-agent.ts#L96-L128) — `AgentRuntime` 接口
> - [packages/cli/src/run-agent.ts:206-217](../../../packages/cli/src/run-agent.ts#L206-L217) — `createAgentRuntime` 工厂
> - [packages/core/src/types/tools.ts:246-342](../../../packages/core/src/types/tools.ts#L246-L342) — `ToolDefinition` 接口
> - [packages/core/src/loop/types.ts:266-316](../../../packages/core/src/loop/types.ts#L266-L316) — `RunResult` 接口
> - [packages/core/src/transcript/store.ts:155-204](../../../packages/core/src/transcript/store.ts#L155-L204) — `commitTurn` per-conversationId withLock
> - [packages/core/src/interrupt/types.ts:31-50](../../../packages/core/src/interrupt/types.ts#L31-L50) — `AbortReason.parent-abort` typed kind **已具备**
> - [packages/core/src/interrupt/controller.ts:148-167](../../../packages/core/src/interrupt/controller.ts#L148-L167) — `forkController(parentSignal)` **已具备**
> - [packages/core/src/events/event-bus.ts](../../../packages/core/src/events/event-bus.ts) — `EventBus` / `IEventBus` / `Listener<P>`
> - [packages/core/src/confirmation/types.ts:378-442](../../../packages/core/src/confirmation/types.ts#L378-L442) — `IConfirmationBroker` 接口
> - [packages/core/src/confirmation/broker.ts:92-200](../../../packages/core/src/confirmation/broker.ts#L92-L200) — `ConfirmationBroker` 实现(无 listener 时走 `nonInteractiveResolver`,默认 `failToDenyResolver`)
> - [packages/core/src/security/permission-store.ts:188-266](../../../packages/core/src/security/permission-store.ts#L188-L266) — `PermissionStore.match()` —— **alwaysAllow 真相源**(规则表),非 broker.resolvedRecent
> - [packages/server/src/confirmation/hub.ts:81-125](../../../packages/server/src/confirmation/hub.ts#L81-L125) — `ConfirmationHub.attach`(INV-H1: 同 conversationId 至多一个 broker)

---

## 0. 概念与背景

### 0.1 子 agent 是什么

**子 agent**(sub-agent):由主 agent 通过 Task 工具显式派生的独立 agent loop 实例,与父共享同一进程、同一 Node.js 事件循环、同一 conversationId、**同一 transcript**。它有:

- 独立的 system prompt(由 `AgentRoleProfile` 渲染,不继承父 prompt)
- 独立的 conversation context window(空白起始,只看自己被分配的 task)
- 独立的工具子集(按 `subAgentSafe` capability tag 过滤,Task 自身 `false` 实现深度限制)
- 独立的 `ConfirmationBroker`(default `failToDenyResolver` → 自动拒绝 / 通过共享 PermissionStore 自动继承父 alwaysAllow)
- 独立的 `IEventBus`(子 bus,事件自动冒泡到父 bus,通过 listener meta 携带 `lineage`)
- 独立的 `AbortController`(`forkController(parentSignal)` 衍生:父 abort → 子立即停;子 abort 不反向)
- 独立的 `AgentRoleProfile` 实例(per spawn)

子 agent **不**有的(关键):
- **不**写独立 `Turn` 记录入 transcript —— 子整个执行 = 主 turn 中一个 Task 工具调用,sub 中间过程通过 EventBus 实时可见,**不持久化**
- 不创建新 conversation
- 不持有 TranscriptStore 引用(它根本不需要直接访问 transcript)
- 不起 worker thread / child process

### 0.2 业界三家做法 vs 我们

| 维度 | Claude Code | OpenClaw | Hermes | 我们 |
|---|---|---|---|---|
| 子 agent 持久化 | sidechain 独立 JSONL 文件 + UUID parent chain | 独立 sessionFile + `parentSession` 链 | SQLite 同库 + `parent_session_id` FK | **不持久化中间过程**,父 Turn.toolCalls 含 Task 调用记录 |
| 子→父 LLM 上下文污染防护 | UI 后处理过滤 sidechain 显示 | 物理两 sessionFile | DB 查询过滤 + UI 默认隐藏 | **天然不污染**(子根本不在 transcript 中) |
| daemon 重启子状态恢复 | sidechain 文件读回 | 孤儿恢复扫描 | DB row 状态修复 | **零恢复协议**(子未完成则父 turn 也未提交,主中断协议已覆盖) |
| 父→子 abort cascade | shareAbortController flag | 显式 cascadeKill 工具 | 父 interrupt 末尾遍历 _active_children | `forkController(parentSignal)` + typed `AbortReason.parent-abort` —— **底座原语已具备,业界唯一** |
| Confirmation 父子关系 | toolPermissionContext 派生 + 强制 avoid prompt | 全局 broker 不分父子 | TLS / ContextVar 黑魔法 | **共享 PermissionStore**(父 alwaysAllow 自动惠及子)+ ChildBroker default deny |

我们的优势:
- **零持久化复杂度** —— 子不写 Turn,无 turnId / parentTurnId / commit 顺序约束 / orphan handling 等业界都在挣扎的机制
- **天然不污染主 LLM history** —— 子不在 transcript 中,主 LLM 下次 LLM 调用拿到的 messages 自然不含子内容
- **typed abort cascade** —— `parent-abort` typed kind + `parentReason` 透传,业界都没有

### 0.3 触发立项的真实问题

可在当前代码路径上观察到具体缺失:

**问题 1**:[packages/tools-builtin/](../../../packages/tools-builtin/) 现有 8 个工具,**无 Task 委托**。LLM 无法在一个 turn 里派生独立调研任务让中间产物的 token 不污染主对话上下文。

**问题 2**:[packages/cli/src/run-agent.ts:206](../../../packages/cli/src/run-agent.ts#L206) `createAgentRuntime` 工厂在 `cli` 包内,但 `server` 通过 [packages/cli/src/serve/session-adapter.ts](../../../packages/cli/src/serve/session-adapter.ts) 反向依赖 cli 来装配 runtime。**包架构债** —— server 反向依赖 cli。

**问题 3**:本仓 `AbortReason.parent-abort` typed cascade + `forkController` + `ConfirmationBroker.failToDenyResolver` 默认行为 + `PermissionStore.match` 共享语义,这套设施已具备,**子 agent 是这些设施的自然产品** —— 不做就在产品上代差。

### 0.4 不做什么——范围边界

本规格**不做**以下能力:

- **不做角色化 RoleTask**(`{ role: "critic" }` surface)—— v2+,见草稿决策 #2
- **不做 BackgroundAgent**(异步 fire-and-forget)—— Step 22 单独交付
- **不做 WorkflowTask / BatchTask** —— v2+
- **不做用户自定义 agent 角色** —— v1 不开放
- **不做 worktree / 远程 sandbox 隔离** —— 子共享父工作目录
- **不做子 agent 的飞书 thread binding** —— 走默认事件流
- **不做用户主动取消单个子 agent** —— v1 abort 颗粒度 = 整 turn 级联
- **不做子 agent 之间的横向通信** —— 主是唯一编排者
- **不做 token budget 硬上限触发硬 kill** —— 软上限 finalize partial
- **不持久化子 agent 中间步骤** —— 见 §1 INV-S1。如未来需要 audit log,另起 audit-log spec

### 0.5 与既有组件的关系(精确)

| 现有组件 | 当前角色 | 本规格上线后 |
|---|---|---|
| `createAgentRuntime` | [cli/run-agent.ts:206](../../../packages/cli/src/run-agent.ts#L206) `(options): Promise<AgentRuntime>` | M1.2 整体搬到 `@zhixing/orchestrator`;入参加 `enableTaskTool?: boolean`(默认 false,主路径 cli 入口传 true) |
| `AgentRuntime` 接口 | [cli/run-agent.ts:96-128](../../../packages/cli/src/run-agent.ts#L96-L128) | **零字段变更**(provider / llmRoles 等"子 agent 复用"需求由 Task closure 在 `createAgentRuntime` 内 capture 局部变量满足,不通过 AgentRuntime 接口暴露,避免 leaky abstraction) |
| **cli/runtime 模块下层化**(M1.2 关键前置) | `cli/src/security/{secure-executor,request-builder}.ts` / `cli/src/{compact-accumulator,compaction-llm,project-context,system-prompt}.ts` 当前都被 createAgentRuntime 直接 import | 它们都是**runtime 装配**关注点(非 CLI UI),M1.2 同步搬到 `orchestrator` 内 —— 否则 createAgentRuntime 搬到 orchestrator 后会立刻产生 `orchestrator → cli` 反向依赖编译错(详见 §2.4 / §15 M1.2) |
| **render 订阅解耦**(M1.2 关键前置) | [cli/run-agent.ts:455-498](../../../packages/cli/src/run-agent.ts#L455-L498) `run()` 内 `eventBus.on("retry:*", ...)` 等 7 处 cli 渲染订阅嵌在 runtime 主流程 | 改为 orchestrator 暴露 `decorateRunBus?: (ctx: { bus }) => () => void` 钩子;cli 入口通过 `createRenderSubscribers(renderer)` 工厂闭包持有 renderer 后注入装饰器;runtime 与 UI 严格分层(UI 概念不进 runtime API) |
| `RunParams` / `RunResult` | [cli/run-agent.ts:149-198](../../../packages/cli/src/run-agent.ts#L149-L198) + [core/loop/types.ts:266-316](../../../packages/core/src/loop/types.ts#L266-L316) | **零字段变更**(主 turn 不感知 sub) |
| `Turn` schema | [core/transcript/types.ts:34-43](../../../packages/core/src/transcript/types.ts#L34-L43) | **零字段变更**(子不写独立 Turn) |
| `TranscriptStore.commitTurn` | [core/transcript/store.ts:155-204](../../../packages/core/src/transcript/store.ts#L155-L204) | **零签名变更** |
| `IEventBus` / `EventBus` | [core/events/event-bus.ts](../../../packages/core/src/events/event-bus.ts) | M1.5 扩 `createEventBus({ parent?, lineage? })` 选项 + listener 第二可选参 `meta?: EventMeta`;现有 callsite 零改动 |
| `ToolDefinition` | [core/types/tools.ts:246-342](../../../packages/core/src/types/tools.ts#L246-L342) | M1.6 加 `subAgentSafe?: boolean`(默认 false / fail-closed) |
| `ToolResult` | [core/types/tools.ts:193-204](../../../packages/core/src/types/tools.ts#L193-L204) | **零字段变更**(子 usage 不入 ToolResult,见 §12) |
| `ToolExecutionContext` | [core/types/tools.ts:129-188](../../../packages/core/src/types/tools.ts#L129-L188) | **零字段变更**(Task 工具用 closure 注入父 env,不污染 ctx) |
| `ConfirmationBroker` | [core/confirmation/broker.ts:92-200](../../../packages/core/src/confirmation/broker.ts#L92-L200);构造选项 `ConfirmationBrokerOptions` | M2.2 扩 `parentBrokerId?: string` / `sourceAgentId?: string`(审计血缘,**不影响**核心逻辑) |
| `PermissionStore` | [core/security/permission-store.ts:188-266](../../../packages/core/src/security/permission-store.ts#L188-L266) | **零字段变更**(子共享父实例,`match()` 自动判 alwaysAllow) |
| `ConfirmationHub.attach` | [server/src/confirmation/hub.ts:81-125](../../../packages/server/src/confirmation/hub.ts#L81-L125)(`(brokerId, broker, opts?: { conversationId? }): void`,INV-H1: 同 conversationId 至多一个 broker) | **v1 子 broker 不挂 hub**(无 conversationId 冲突);v2+ 若需 RPC 推子 confirmation 再设计 |
| `forkController` / `AbortReason.parent-abort` | [core/interrupt/controller.ts:148-167](../../../packages/core/src/interrupt/controller.ts#L148-L167) | **零修改**,直接复用 |
| `buildSystemPrompt` | [cli/system-prompt.ts](../../../packages/cli/src/system-prompt.ts) `(opts): string` 单体函数 | M1.7 重构为多段可参数化(主 / 子各自的 segment 集) |

**协议层零修改** —— 没有 IEventBus 公开方法签名变化(只增可选字段)、没有 ITranscriptStore 签名变化、没有 Turn schema 变化、没有 ToolResult / ToolExecutionContext 变化。所有现有 callsite 零回归。

---

## 1. 不变量(Invariants)

本规格**继承**:
- 主中断协议模块 [INV-1 ~ INV-14](./interruptible-agent-loop-execution.md)
- 远程中断模块 [INV-R1 ~ INV-R8](./remote-interruption-execution.md)

本节列**子 agent 特定新增不变量**。

**INV-S1. 子 agent 执行内部于 Task 工具,不写独立 Turn 记录**:子 agent 整个生命周期(spawn → LLM 多轮 → 工具多次 → finalize)发生在 Task 工具 `call()` 函数内部。完成后 Task 工具返回 `ToolResult { content, isError }`,内容是子 final assistant text(加 `<usage>` trailer)。**不**调用 `transcriptStore.commitTurn`、**不**写 sub Turn,父主 turn 的 `toolCalls` 数组里有一条 Task 调用记录承载子调用结果。

**INV-S2. 子共享父持久状态,隔离 per-spawn 状态**:
- **共享**:`SecurityPipeline`、`PermissionStore`(父 alwaysAllow 规则自动惠及子调用)、`MemoryStore`(只读访问,Memory 工具 `subAgentSafe: false` 已硬隔离写)、provider / API key、tool registry、project context
- **隔离 per spawn**:`AgentRoleProfile`、`IEventBus`(子 bus)、`AbortController`(forkController 派生)、`ConfirmationBroker`(子 broker 默认 `failToDenyResolver`)、conversation messages(空白起始,只含 synthetic Begin)

**INV-S3. profile.enabledTools 单一真相源(决定 #10)**(2026-05-11 更新:实现已改为 profile 驱动,不再用 `subAgentSafe` capability tag——`ToolDefinition.subAgentSafe` 字段已从 `packages/core/src/types/tools.ts` 删除):子 agent 工具子集由 sub-agent `AgentRoleProfile.enabledTools` 显式声明驱动(`packages/orchestrator/src/profile/agent-role-profile.ts:44`),tools[] 装配以 `profile.enabledTools` 为唯一权威源(`packages/orchestrator/src/runtime/create-agent-runtime.ts:387-483`)。**禁止**维护独立黑名单 / 白名单。
- 防递归由 sub-agent profile 的 `enabledTools` 不含 `"Task"` 实现(原"Task 自身 `subAgentSafe: false`"机制已废弃)
- fail-closed:profile 未声明的工具名不进入装配
- 配置 `intent.subagent.maxDepth` 默认 1;若放宽到 2+,`runChildAgent` 检测当前深度 + 1 < maxDepth 时显式注入 Task closure 到子 tools

**INV-S4. AbortReason.parent-abort 单向 typed cascade(决定 #10)**:父 abort 触发的子 abort **必须**携带 `AbortReason { kind: "parent-abort", parentReason }`(由 [`forkController`](../../../packages/core/src/interrupt/controller.ts#L148-L167) 已自动注入)。子 fail / 子超时 / 子主动 user-cancel **不**反向触发父 abort,父继续运行,子失败包成 `tool_result.is_error: true` 由父 LLM 决定后续。
- `forkController(parentSignal)` 已具备此语义,本不变量是**禁止**未来在 orchestrator 加"子 fail 反向 abort 父"的 anti-pattern

**INV-S5. EventBus lineage 单调前缀延伸(决定 #6)**:子 EventBus 的 `lineage` **必须**以父 lineage + `"/"` 开头。
- 形式:`"main"` → `"main/sub-<uuid>"` → `"main/sub-<u1>/sub-<u2>"`
- 渲染层按 `meta.lineage?.startsWith("main/sub-")` 检测子事件
- 工厂创建时校验,违反 throw

**INV-S6. runChildAgent 永不抛**:`runChildAgent` 内部捕获所有错误 / abort,**永远**返回 `ChildAgentResult` 之一(`status: "completed" | "failed" | "aborted"`)。Task 工具据此构造 `ToolResult`。这保证主 LLM 永远看到结构化 tool_result 而非 unhandled exception。

**INV-S7. Confirmation 共享 PermissionStore + 子 broker auto-deny(决定 #5)**:子 agent 调用工具时,`SecurityPipeline.evaluate` 走**父子共享的** `PermissionStore`,父已 `allow-session/workspace/global` 的规则自动命中(子无需弹)。
- 仅当 `PermissionStore.match()` 不命中且 `SecurityPipeline` 判 `requiresConfirmation: true` 时,才走子 broker
- 子 broker 默认 `nonInteractiveResolver: failToDenyResolver` —— 无 UI listener → 自动拒绝(已是 broker 的 default 行为,**无需新逻辑**)
- `SubAgentConfirmationPolicy` 类型仅含生产安全字面值(`inherit-or-deny` / `auto-deny`,均映射到 `failToDenyResolver`);测试 / 开发需要 auto-approve 行为时**直接构造 broker 注入 `failToAllowResolver`**,不通过 policy 字符串路径(详见 §8.2.2)

**INV-S8. 子 turn 不污染主 LLM history**:由 INV-S1 自动保证 —— 子不写 Turn,主 agent 下次 LLM 调用时拿到的 messages 自然不含子的中间消息。无需 `commitTurn` 视图过滤、无需 UI 过滤、无需任何"保护"机制。

---

## 2. 模块边界:`@zhixing/orchestrator` 包

### 2.1 为什么独立成包(决定 #12)

- **core**:基础设施层(transcript / event / confirmation / interrupt / agent-loop / context-engine / security-pipeline / types)—— **稳定**,变化频率低
- **orchestrator**:基础设施的**组合应用层** —— 装配 agent runtime / Task 委托 / 子 agent lifecycle / 未来 BackgroundAgent / RoleTask / WorkflowTask / BatchTask
- 当前 [createAgentRuntime](../../../packages/cli/src/run-agent.ts#L206) 在 `cli`,导致 `server` 反向依赖 `cli`
- 拒绝塞进 core(职责正交,且 core 无 providers/network/tools-builtin 依赖,orchestrator 都要)
- 拒绝留 cli(server 反向依赖 cli 不合理;v2+ 多 surface 全归此层)

### 2.2 包依赖图

```
                            ┌──────────────┐
                            │     core     │ (transcript / event / confirmation /
                            │              │  interrupt / agent-loop / context-engine /
                            │              │  security-pipeline / types)
                            └──────┬───────┘
                                   │
                ┌─────────┬────────┼──────────┐
                ▼         ▼        ▼          ▼
            providers  network                tools-builtin
            (LLM SDK)  (egress)               (8 builtin I/O 工具:
                                               Read / Glob / Grep /
                                               Edit / Write / Bash /
                                               WebFetch / Memory —
                                               不含 Task)
                                                    │
                                                    ▼
                      ┌─────────────────────────────────┐
                      │    @zhixing/orchestrator        │
                      │    ────────────────────         │
                      │    • createAgentRuntime         │
                      │    • createTaskTool(env)        │
                      │    • runChildAgent              │
                      │    • AgentRoleProfile + 渲染    │
                      │    • buildSystemPrompt 多段     │
                      │    • (v2+) BackgroundAgent /    │
                      │      RoleTask / WorkflowTask    │
                      └────────────┬────────────────────┘
                                   │
                       ┌───────────┴────────────┐
                       ▼                        ▼
                  ┌────────┐               ┌────────┐
                  │  cli   │               │ server │ (RPC / channel /
                  │        │               │        │  scheduler / outbox)
                  └────────┘               └────────┘
```

**约束**:
- `orchestrator` 依赖 `core` / `providers` / `network` / `tools-builtin`
- `cli` / `server` 依赖 `orchestrator`,不再相互反向依赖
- Task 工具因为是"编排器入口",归 `orchestrator/src/tools/task.ts`,**不**在 `tools-builtin` —— 依赖图严格 acyclic

### 2.3 `@zhixing/orchestrator` 包结构

```
packages/orchestrator/
├── package.json                        // dependencies: @zhixing/core, providers, network, tools-builtin
├── src/
│   ├── index.ts                        // public API barrel
│   ├── runtime/
│   │   ├── create-agent-runtime.ts     // (M1.2b) 从 cli/run-agent.ts 搬主体;M2.3 加 enableTaskTool 选项 + ALS 主路径包裹 + Task closure 注入
│   │   ├── system-prompt.ts            // (M1.6) buildSystemPrompt 多段可参数化(从 cli/system-prompt.ts 搬来重构)
│   │   ├── run-context.ts              // (M2.1) runContextStorage = AsyncLocalStorage<RunContext>;M2.3 主路径 run() 入口包裹
│   │   ├── track-messages.ts           // (M1.6) 从 cli/run-agent.ts:638 抽出,主 / 子共用 yields → messages 累积
│   │   ├── compact-accumulator.ts      // (M1.2a) 从 cli/compact-accumulator.ts 搬来 — runtime 数据收集
│   │   ├── compaction-llm.ts           // (M1.2a) 从 cli/compaction-llm.ts 搬来 — runtime 用 flush callLLM 构造
│   │   └── project-context.ts          // (M1.2a) 从 cli/project-context.ts 搬来 — 项目元信息装配
│   ├── security/
│   │   └── secure-executor.ts          // (M1.2a) 从 cli/security/secure-executor.ts 搬来 — runtime 装配 tool dispatcher 包装(主 / 子共用)
│   //  注:request-builder.ts 同步搬到 core/src/confirmation/ (它本属 ConfirmationRequest 的 builder,与类型同包)
│   ├── profile/
│   │   ├── agent-role-profile.ts       // AgentRoleProfile 类型
│   │   ├── default-profiles.ts         // mainProfile() / subAgentProfile()
│   │   └── render-identity.ts          // identity 段渲染(主 / 子 共用)
│   ├── subagent/
│   │   ├── factory.ts                  // (M2.1) runChildAgent 主入口
│   │   ├── loop-runner.ts              // (M2.1) runSubAgentLoop 薄封装(直接调 core agentLoop,不走 createAgentRuntime 重型)
│   │   ├── lineage.ts                  // deriveChildLineage
│   │   ├── budget.ts                   // SubAgentBudget 默认值 + 软上限触发
│   │   ├── result-classifier.ts        // classifyResult / extractFinalAssistantText / extractPartialText
│   │   └── abort-format.ts             // formatAbortReasonForLLM
│   ├── tools/
│   │   ├── task.ts                     // (M2.3) Task 工具 — closure 注入父 env,调 runChildAgent
│   │   └── format-result.ts            // formatChildResultAsToolResult(三态文本协议)
│   ├── confirmation/
│   │   └── child-broker.ts             // (M2.2) resolveSubAgentResolver 策略路由(子 broker 装配 helper)
│   └── __tests__/                      // 单元 + 集成测试
└── tsconfig.json
```

### 2.4 跨包重构方案(M1)

按以下顺序原子提交,每步独立可验证:

**M1.1 — 建包骨架**
- `packages/orchestrator/{package.json, tsconfig.json, src/index.ts}` 创建,空 export
- 加入 monorepo workspace
- `pnpm build` 通过

**M1.2 — 搬 `createAgentRuntime`(分三步,顺序不可乱)**

`createAgentRuntime` 直接 import 6 个 cli 内部模块,不能"整体搬"—— 必须按依赖反向先搬下层,再搬主体,最后解耦 UI 订阅。

**M1.2a — 把 runtime 级模块从 cli 下沉到 orchestrator / core**(`createAgentRuntime` 还在 cli,先把它的依赖搬走):

| 模块 | 当前位置 | 目标位置 | 性质 |
|---|---|---|---|
| `secure-executor.ts` | `cli/src/security/` | `orchestrator/src/security/` | runtime 装配 tool dispatcher 的包装(子 agent 也用)。**前置:删除 legacy prompt path**(见下) |
| `request-builder.ts` | `cli/src/security/` | `core/src/confirmation/` | `ConfirmationRequest` 的 builder,与类型同包更合理 |
| `compact-accumulator.ts` | `cli/src/` | `orchestrator/src/runtime/` | runtime 数据收集(订阅 compact 事件累积 marker) |
| `compaction-llm.ts` | `cli/src/` | `orchestrator/src/runtime/` | runtime 用 flush callLLM 构造(LLMRoles 薄包装) |
| `project-context.ts` | `cli/src/` | `orchestrator/src/runtime/` | 项目元信息装配 / enrichContext / injectContext |
| `system-prompt.ts` | `cli/src/` | `orchestrator/src/runtime/` | M1.6 同步多段重构(主 byte-equal) |

每个模块独立 commit,验证 cli 现有 import 路径(改为从 orchestrator/core re-import)+ 全 e2e 全绿。

**secure-executor legacy prompt path 删除(M1.2a 必做前置)**:

[cli/security/secure-executor.ts:35-41](../../../packages/cli/src/security/secure-executor.ts#L35-L41) 当前对 cli UI 模块 `./confirmation-ui.js` 有 4 个 import(`renderBlockedMessage / renderUserDeniedMessage / showConfirmationDialog / type PromptFn`),仅 legacy prompt path 使用(`prompt?: PromptFn` 入参 + `pickPath` 选路逻辑)。这条路径在 broker / Renderer 体系建立后已是历史遗留,只在 `ZHIXING_CONFIRMATION_RENDERER=legacy` 调试 env 下激活,**生产 v1 完全不用**。

直接搬 secure-executor 到 orchestrator 会引入 `orchestrator → cli/security/confirmation-ui` 反向依赖,**和 M1.2a 试图解决的问题一模一样**。

**修法**(同一次 commit 内完成):
1. 删除 `SecureExecuteToolOptions.prompt?: PromptFn` 字段 + `pickPath(broker, prompt, env)` 选路逻辑
2. 删除对 `./confirmation-ui.js` 的 4 个 import 与对应使用点
3. 删除 `cli/run-agent.ts` 调用处的 `prompt: params.securityPrompt` 入参
4. `RunParams.securityPrompt` 字段删除(legacy 不再支持)
5. 现在 `secure-executor.ts` 仅依赖 `@zhixing/core` + 同包 `./request-builder.js`(后者也一起下沉到 core/confirmation)—— 干净下沉
6. `confirmation-ui.ts` 留在 `cli/src/security/`,继续供 `terminal-renderer.ts` 使用

**M1.2b — 把 `createAgentRuntime` 主体搬到 orchestrator**(此时所有依赖已就位):
- `cli/run-agent.ts:206-650` 主体搬到 `orchestrator/src/runtime/create-agent-runtime.ts`
- `AgentRuntime` 接口跟搬到 `orchestrator/src/runtime/types.ts`
- `cli/run-agent.ts` 改为 re-export
- 跑 cli + server + RPC 全 e2e 全绿

**M1.2c — render 订阅解耦**(切断 orchestrator → cli/render 反向依赖):

`createAgentRuntime` 入参加可选钩子:
```typescript
/**
 * 装饰器入参 —— 仅暴露当前 run 的 EventBus。
 *
 * 严格约束:任何 UI 概念(spinner 暂停 / 终端清屏 / 状态消息编辑等)
 * 都不应作为字段进入此接口。装饰器自身的 UI 依赖(如 renderer 实例、
 * channel adapter 句柄)应通过工厂层 closure 捕获,在创建时注入,
 * 保持 runtime API 与展示层零耦合。
 */
export interface RunBusContext {
  bus: IEventBus<AgentEventMap>;
}

export type DecorateRunBusFn = (ctx: RunBusContext) => () => void;

export interface CreateAgentRuntimeOptions {
  // ... 既有字段
  /**
   * Per-run EventBus 装饰钩子。
   * runtime.run() 创建 per-run eventBus 后调用,让调用方挂载渲染 / 监听器,
   * 返回 dispose 函数,run() 结束的 finally 调用。
   *
   * 设计为 ctx 形态而非 (bus) 直传:扩展性更优(未来加 run 元信息字段不破坏
   * 调用方签名),但严禁向 ctx 添加 UI 概念字段 —— UI 通过 closure 注入。
   *
   * - cli REPL 入口:工厂 `createRenderSubscribers(renderer)` 闭包持有 renderer
   * - server 入口:不传(channel adapter 自管)或工厂闭包持有 RPC bridge
   * - 子 agent 路径(runChildAgent → runSubAgentLoop):不传,子 bus 由 orchestrator 自管
   */
  decorateRunBus?: DecorateRunBusFn;
}
```

`runtime.run()` 内部:
```typescript
const eventBus = createEventBus<AgentEventMap>({ lineage: "main" });
// ctx 仅含 bus —— UI 依赖由工厂层 closure 提供,runtime 主流程零 UI 概念。
const disposeRender = options.decorateRunBus?.({ bus: eventBus });
try {
  // RunContext 字段名为 bus(对齐 packages/orchestrator/src/runtime/run-context.ts);
  // ALS 透传层不重命名,Task closure 拿到的就是 createEventBus 返的实例
  return await runContextStorage.run({ bus: eventBus, lineage: "main" }, async () => {
    // ... agent loop
  });
} finally {
  disposeRender?.();
}
```

cli 入口(`cli/src/run-agent.ts` runOnce + `cli/src/repl.ts` startRepl)用工厂模式注入装饰器:
```typescript
import { createAgentRuntime } from "@zhixing/orchestrator/runtime";
import { createRenderer, createRenderSubscribers } from "./render.js";

// REPL 路径:renderer 由工厂 closure 捕获,装饰器内部派生 pauseUI = renderer.stop()
const renderer = createRenderer();
const runtime = await createAgentRuntime({
  ...opts,
  decorateRunBus: createRenderSubscribers(renderer),
});
```

`cli/src/render.ts` 暴露 `createRenderSubscribers(renderer?: Renderer): DecorateRunBusFn` 工厂:
- renderer 在工厂层通过参数注入,工厂返回的装饰器函数闭包持有它
- 装饰器内部用 `bus.on("retry:*", ...)` 订阅事件,渲染前调 `renderer.stop()` 暂停 spinner
- 同时调 `setupInterruptRendering(bus, pauseUI)` 装载中断事件渲染
- M2.4 起并列扩充 `setupSubAgentStatus(bus, pauseUI)` 装载子 agent 状态条(详见 §11.2 / §15 M2.4),与 `setupInterruptRendering` 共享 `pauseUI` 钩子与 dispose 路径
- renderer 缺省(serve 模式无 spinner)时 pauseUI 退化为 no-op,事件仍渲染但不驱动 spinner

**M1.2 完成后**:`orchestrator → cli` 零反向依赖;cli/render 是 UI subscribers,通过工厂注入,不嵌入 runtime 主流程,UI 概念也不出现在 runtime API 中。

**M1.3 — cli/serve adapter 直接 import orchestrator**
- `cli/serve/session-adapter.ts` 把 `import { createAgentRuntime } from "../run-agent"` 换成 `import { createAgentRuntime } from "@zhixing/orchestrator/runtime"`
- 包依赖图断开 cli ← server 反向依赖(`@zhixing/server` 自身不依赖 orchestrator,
  通过 `RuntimeFactory` 抽象解耦;cli/serve 作为 server 的具体宿主,把
  orchestrator 与 server 的 RuntimeFactory 在此层组合)

**M1.4 — `EventBus` 扩 hierarchical(meta 侧通道)**
- `core/events/event-bus.ts` + `core/events/types.ts` 扩:
  - `EventBusOptions.{ parent?: IEventBus<TMap>, lineage?: string }`
  - `Listener<P> = (payload: P, meta?: EventMeta) => void | Promise<void>`(第二参可选,向后兼容)
  - 内部 `emitFromChild(event, payload, meta)` 透传父接口(非 public)
- 默认无参 = 现有平面行为(snapshot test 保证)
- INV-S5 校验 `lineage` 前缀关系

**M1.5 — `ToolDefinition.subAgentSafe` 字段 + 8 个 builtin 声明**
- `core/types/tools.ts` `ToolDefinition` 加 `subAgentSafe?: boolean`(默认 fail-closed = false)
- 8 个 builtin 工具按 §3.5 表逐个声明
- 测试:`tools.filter(t => t.subAgentSafe === true)` 输出符合预期

**M1.6 — `AgentRoleProfile` 类型 + `mainProfile()` + system-prompt 多段重构**
- `orchestrator/profile/` 模块落地
- `orchestrator/runtime/system-prompt.ts` 提供 `buildSystemPrompt(opts)`,接受 `profile + segments + tools + project + ...` 多段参数
- `cli/system-prompt.ts:buildIdentity` 删除 / 替换;主 path 调 `buildSystemPrompt({ profile: mainProfile(), segments: ALL_SEGMENTS, ... })`
- 主 agent system prompt **byte-equal** 旧实现(snapshot test 保证)

**M1 完成后**:零业务功能变化,所有现有 e2e 全绿,只是包结构重整 + 数据结构扩字段为 M2 准备。

---

## 3. 核心抽象与数据结构

### 3.1 `AgentRoleProfile`

**位置**:`packages/orchestrator/src/profile/agent-role-profile.ts`

```typescript
export interface AgentRoleProfile {
  /** 显示名,用于 system prompt 与状态条。e.g. "知行" / "Sub-Agent #a3f" */
  name: string;
  /** 角色标识。v1: "main" | "sub";v2+ 扩展 "researcher" | "critic" | ... */
  role: string;
  /** 核心指令(身份段主体) */
  instructions: string;
  /** 硬约束(逐条注入到 Constraints 段) */
  constraints: readonly string[];
  /** 语气 / 风格指引(可选,默认中性) */
  tone?: string;
  /** 能力声明(只读元数据,渲染层据此调整 prompt) */
  capabilities?: ProfileCapabilities;
}

export interface ProfileCapabilities {
  /** 是否能派生子 agent。v1: main=true, sub=false */
  canSpawnSubAgents: boolean;
  /** 输出是否给最终用户看。false → 输出回写父作为 tool_result */
  userFacing: boolean;
}
```

### 3.2 默认 profile

**位置**:`packages/orchestrator/src/profile/default-profiles.ts`

```typescript
export function mainProfile(): AgentRoleProfile {
  return {
    name: getAgentIdentity(),                  // 复用既有 setAgentIdentity / getAgentIdentity 单例
    role: "main",
    instructions: MAIN_IDENTITY_INSTRUCTIONS,   // 从 cli/system-prompt.ts buildIdentity 文本 verbatim 迁移
    constraints: [],
    capabilities: { canSpawnSubAgents: true, userFacing: true },
  };
}

export function subAgentProfile(opts: {
  subAgentId: string;
  task: string;
}): AgentRoleProfile {
  return {
    name: `Sub-Agent #${opts.subAgentId.slice(0, 6)}`,
    role: "sub",
    instructions:
      `# Your Role\n` +
      `You are a sub-agent dispatched by the main agent to perform the following task:\n\n` +
      `\`\`\`\n${opts.task}\n\`\`\``,
    constraints: [
      "Your output is read by the main agent only — the user does not see it. Make your output self-contained; do not reference 'just now' or other context the user might assume.",
      "Use as few tool calls as possible. When you have enough to answer, finalize.",
      "You do not have access to the Task tool — you cannot dispatch further sub-agents.",
      "Stay focused on the assigned task. Do not initiate user conversation, do not send external messages.",
    ],
    capabilities: { canSpawnSubAgents: false, userFacing: false },
  };
}
```

### 3.3 system prompt 多段装配

**位置**:`packages/orchestrator/src/runtime/system-prompt.ts`(M1.6 从 [cli/system-prompt.ts](../../../packages/cli/src/system-prompt.ts) 搬来重构)

```typescript
export interface PromptBuildContext {
  /** profile 决定身份段;不传退化为 mainProfile() */
  profile?: AgentRoleProfile;
  /** 启用哪些段;不传退化为 MAIN_AGENT_SEGMENTS */
  segments?: readonly SystemPromptSegment[];
  /** 工具描述段输入(已按 subAgentSafe 过滤);驱动 tool-usage / skill-evolution 段 */
  tools: ToolDefinition[];
  /** 必填动态字段,出现在缓存分界后的环境段 */
  cwd: string;
  workspace?: string | null;
  workspaceSource?: string;
  globalConfigPath?: string;
  shell?: string;
}

/**
 * 段语义:6 个静态段(主) / 4 个静态段(子)+ 1 个动态环境段(总在 CACHE_BOUNDARY 之后)
 * 段落选择按"代码行为驱动"而非"用户上下文驱动" —— 与历史 cli/system-prompt.ts 等价重构。
 */
export type SystemPromptSegment =
  | "identity"           // renderIdentity(profile) - 身份/Tone/Constraints
  | "principles"         // 工作原则 - "Read before edit" 等硬约束
  | "tool-usage"         // 工具使用偏好 - 按 ctx.tools 列表动态生成 + systemPromptHints 透传
  | "skill-evolution"    // 技能进化引导 - 仅当 tools 含 memory 工具时生效(返回 null 跳过)
  | "style"              // 输出风格 - 主对话风格(简洁/不用 emoji 等)
  | "safety";            // 安全边界 - destructive 命令防护

/** 主 agent 默认全集,顺序与历史 cli prompt 一致(byte-equal 锚点) */
export const MAIN_AGENT_SEGMENTS: readonly SystemPromptSegment[] =
  ["identity", "principles", "tool-usage", "skill-evolution", "style", "safety"];

/** 子 agent 默认段集 —— 任务专注、prompt cache 友好(同角色子 agent 跨 spawn 静态前缀 byte-identical) */
export const SUB_AGENT_SEGMENTS: readonly SystemPromptSegment[] =
  ["identity", "principles", "tool-usage", "safety"];

export function buildSystemPrompt(ctx: PromptBuildContext): string;
```

**子 agent 段集合的设计取舍**(每段保留/排除的理由):

| 段 | 主 | 子 | 理由 |
|---|---|---|---|
| identity | ✓ | ✓ | 角色身份 / Constraints 是 system prompt 起点 |
| principles | ✓ | ✓ | "Read before edit" 等硬约束子 agent 同样适用 |
| tool-usage | ✓ | ✓ | 工具描述按子 agent 装配的 childTools 动态生成 |
| skill-evolution | ✓ | ✗ | Memory 工具 `subAgentSafe:false` 已硬隔离写入,提示反思保存技能对子是无效噪声 |
| style | ✓ | ✗ | 子输出回写父 tool_result,不直接对话用户;风格指引("be concise"等)会让子误解为对话场景 |
| safety | ✓ | ✓ | destructive 命令防护是绝对底线,子 agent 不可豁免 |

**子 agent 不继承的内容**(与主 agent 行为差异):

- **项目上下文(ZHIXING.md / enriched skills)** —— 由主 agent 在 Task prompt 中显式提炼
  相关部分传给子,避免子 system prompt 膨胀。代价是主 agent 需要"挑出相关上下文"的判断力,
  收益是同角色子 agent 跨 spawn 的**静态前缀 byte-identical**(prompt cache 命中)。
- **用户记忆段** —— 同上,且 `memory` 工具不在子 agent 工具集里,即使带也用不上。

**为什么参数化 `segments` 而非硬编码主 / 子两条路径**:
- 未来 RoleTask 各角色可自选段组合(researcher 可能复用 skill-evolution,critic 可能去掉 style)
- 主 / 子是 segment 集合的两个特例,不是平行实现 —— `buildSystemPrompt` 单一调用点支持所有形态

**`renderIdentity(profile)`** —— 实际实现(身份段头由 `profile.instructions` 自身拥有):

```typescript
export function renderIdentity(profile: AgentRoleProfile): string {
  const parts: string[] = [];
  if (profile.tone) parts.push(`# Tone\n${profile.tone}`);
  parts.push(profile.instructions);              // profile 自带 markdown 头(主默认无头/子带 "# Your Role")
  if (profile.constraints.length > 0) {
    parts.push(`# Constraints\n` + profile.constraints.map(c => `- ${c}`).join("\n"));
  }
  return parts.join("\n\n");
}
```

主 agent 路径的输出 = `buildSystemPrompt({ profile: mainProfile(), segments: MAIN_AGENT_SEGMENTS, ... })`,
**byte-equal** 历史 `cli/system-prompt.ts` 输出(M1.6 双 snapshot 锚点保证):
- `主路径静态区(默认 profile + 默认 segments,无 memory 工具)` —— 5 段
- `主路径静态区(默认 profile + 含 memory 工具)完整 6 段` —— 6 段(skill-evolution 激活)

子 agent 路径的输出 = `buildSystemPrompt({ profile: subAgentProfile({ subAgentId, task }), segments: SUB_AGENT_SEGMENTS, tools: childTools, ... })`,
**byte-equal** 锁定(M1.6 第三 snapshot):
- `子 agent SUB_AGENT_SEGMENTS 4 段(无 memory / 无 style / 无 skill-evolution)` —— 4 段

### 3.4 Hierarchical EventBus

**位置**:`packages/core/src/events/event-bus.ts`(M1.4 扩展)

```typescript
// 新增 EventBusOptions 字段
export interface EventBusOptions {
  // 既有字段...
  /**
   * 父 bus —— emit 自动冒泡到父(及递归向上),meta 透传。
   *
   * 类型为具体类 EventBus 而非 IEventBus 接口:实现层依赖类内部
   * `emitFromChild` 私有方法转发,接口无法承载该契约;子 spawn 把
   * ALS 中的父 bus(就是 EventBus 实例)直接透传到这里,类型链一致。
   */
  parent?: EventBus<EventMap>;
  /** 当前 bus 的 lineage 路径。e.g. "main", "main/sub-a3f" */
  lineage?: string;
}

// 扩 Listener 类型(向后兼容:旧 listener 仅接收 payload,忽略 meta)
export interface EventMeta {
  /** emit 来源 bus 的 lineage 路径 */
  lineage?: string;
  /** emit 时刻 epoch ms */
  emittedAt?: number;
  // 未来字段(深度、agentId 等)按需扩展
}

export type Listener<P> = (payload: P, meta?: EventMeta) => void | Promise<void>;
```

**行为**:
- emit 内部从 bus.lineage 构造 `meta = { lineage: bus.lineage, emittedAt: Date.now() }`(若 bus.lineage 未设,meta.lineage 为 undefined)
- 派发顺序:**子本地 listener 先,父 listener 后**(深度优先,从子到根)。子内部消费者先于父渲染层看到事件
- 旧 listener(单 payload 参)继续工作 —— meta 是 optional 第二参
- 新 listener(`(payload, meta) => meta?.lineage?.startsWith("main/sub-")`)按需读 meta
- payload 类型严格保持 `TMap[K]`,**不**注入任何字段 —— meta 走侧通道,**类型系统不被污染**
- INV-S5: `opts.lineage` 必须以 `opts.parent?.lineage + "/"` 开头(若 parent 提供 lineage),违反 throw

**派发到父**:子 bus emit 时,把 meta 透传给父 bus 的内部 `emitFromChild(event, payload, meta)` 通道(非 public);父 bus 据此调本地 listener 时传**同一份** meta(不重新构造),保证 `meta.lineage` 始终标识**最初 emit 的子 bus**,无论冒泡多少层。

**派生子 lineage**(`packages/orchestrator/src/subagent/lineage.ts`):

```typescript
export function deriveChildLineage(
  parentLineage: string | undefined,
  subAgentId: string,
): string {
  const base = parentLineage ?? "main";
  return `${base}/sub-${subAgentId.slice(0, 8)}`;
}
```

### 3.5 子 agent 工具过滤:`profile.enabledTools`

> 2026-05-11 更新:本节原描述 `ToolDefinition.subAgentSafe` capability tag 过滤方案,该字段已从代码删除。实现已改为 sub-agent `AgentRoleProfile.enabledTools` 显式声明驱动(`agent-role-profile.ts:44` + `create-agent-runtime.ts:387-483` 为唯一权威装配源)。下方原 `subAgentSafe` 字段定义与"8 个 builtin 默认值"表保留为决策痕迹,**不代表当前代码**——sub-agent 实际可用工具集以 sub-agent profile 的 `enabledTools` 列表为准。

**位置**:[core/types/tools.ts:246-342](../../../packages/core/src/types/tools.ts#L246-L342)(M1.5 加字段)

```typescript
export interface ToolDefinition {
  // ... 既有字段
  /**
   * 是否安全暴露给子 agent。**默认 false**(fail-closed,与 `isParallelSafe` /
   * `needsPermission` 保持一致的保守哲学)。
   *
   * 设为 false 的工具不会出现在子 agent 的工具列表中,实现:
   *  - 防递归(Task 工具自身)
   *  - 防权限提升(Memory 写主用户记忆)
   *  - 后续可扩展(如某些只主 agent 应该用的工具)
   *
   * 子 agent 装配过滤:`tools.filter(t => t.subAgentSafe === true)`
   */
  subAgentSafe?: boolean;
}
```

**8 个 builtin 工具默认值**(M1.5 逐个声明):

| 工具 | `subAgentSafe` | 理由 |
|---|---|---|
| Read | `true` | 只读,完全安全 |
| Glob | `true` | 只读 |
| Grep | `true` | 只读 |
| Edit | `true` | 子 agent 可改文件;权限由共享 PermissionStore + ChildBroker 兜底 |
| Write | `true` | 同上 |
| Bash | `true` | 子需要 shell 调研能力(grep / git log 等);沙箱 + 共享权限规则兜底 |
| WebFetch | `true` | 子调研常需拉外部内容 |
| **Memory** | **`false`** | 子不污染主用户持久记忆 |
| **Task**(orchestrator 包内) | **`false`** | 自我排除,实现深度限制 |

**`isParallelSafe` 真伪**(M0 实测后填):

| 工具 | `isParallelSafe` | 理由 |
|---|---|---|
| Read / Glob / Grep / WebFetch | `true` | 只读,无副作用 |
| Edit / Write / Bash | `false` | 同 path / 共享 cwd / 环境变量,有 race |
| Memory | `false` | 写共享存储 |
| Task | `true` | 子 agent 之间 LLM I/O bound 独立 |

dispatcher 改造(M2.5)按 `isParallelSafe` 过滤分组:全 safe → `Promise.allSettled`;含 unsafe → 顺序回退(算法见 §15 M2.5)。

---

## 4. Surface:Task 工具

### 4.1 工具元信息 + closure 工厂

**位置**:`packages/orchestrator/src/tools/task.ts`(**不**在 tools-builtin)

```typescript
import { runChildAgent } from "../subagent/factory.js";
import { runContextStorage } from "../runtime/run-context.js";

/**
 * Task closure 持有的"父级共享服务" —— 不包 AgentRuntime 整体引用,
 * 直接 capture createAgentRuntime 内部局部变量,避免 forward reference 问题。
 *
 * 字段对齐 RunChildAgentOptions 的"shared 子集"(剔除 task / parentBus /
 * parentLineage / parentSignal —— 这些走 ALS / ToolExecutionContext);
 * 工作区相关字段平铺(workspace / workspaceSource / globalConfigPath),
 * 与 PromptBuildContext / RunChildAgentOptions 字段形态一致,装配时无需解构。
 */
export interface TaskToolEnv {
  // 共享服务(子复用)
  provider: LLMProvider;
  model: string;
  llmRoles: LLMRoles;
  securityPipeline: SecurityPipeline;
  workspace: string | null;
  workspaceSource?: string;
  globalConfigPath?: string;
  // 父独占
  parentBroker: IConfirmationBroker;
  /** 父运行时的工具列表(子 capability filter 输入) */
  parentTools: readonly ToolDefinition[];
}

/** Task 工具自身的边界声明 —— 详见本节末"Boundaries 声明"段。 */
export const TASK_TOOL_BOUNDARIES: readonly BoundaryCrossing[] = [
  { boundaryType: "process", access: "exec", dynamic: false },
];

export function createTaskTool(env: TaskToolEnv): ToolDefinition {
  return {
    name: "Task",
    description: TASK_TOOL_PROMPT,             // §4.5 原文
    inputSchema: TASK_INPUT_SCHEMA,             // §4.2
    isReadOnly: false,
    isParallelSafe: true,                       // 决定 #9:LLM I/O bound,可并发
    needsPermission: false,                     // 不弹用户(子内部决策)
    subAgentSafe: false,                        // 决定 #10:防递归
    interruptBehavior: "cancel",                // ctx.abortSignal 抛 AbortError 即停
    boundaries: [...TASK_TOOL_BOUNDARIES],      // SecurityPipeline 分类锚点,见末段"Boundaries 声明"
    call: async (input, ctx): Promise<ToolResult> => {
      // 前置契约校验集中在工具入口 —— fail-fast 而非 fallback,避免主 LLM
      // 用残缺输入派出"无任务"子 agent 浪费 token / 产出垃圾 tool_result
      const runCtx = runContextStorage.getStore();
      if (!runCtx) throw new Error("Task tool called outside agent run context");
      if (!ctx.abortSignal) throw new Error("Task tool requires ctx.abortSignal");
      const description = String(input["description"] ?? "").trim();
      const prompt = String(input["prompt"] ?? "").trim();
      if (!description) throw new Error("Task tool requires non-empty 'description'");
      if (!prompt) throw new Error("Task tool requires non-empty 'prompt'");

      const result = await runChildAgent({
        provider: env.provider,
        model: env.model,
        llmRoles: env.llmRoles,
        securityPipeline: env.securityPipeline,
        workspace: env.workspace,
        workspaceSource: env.workspaceSource,
        globalConfigPath: env.globalConfigPath,
        parentBus: runCtx.bus,                   // ALS 取当前 run 的 bus
        parentLineage: runCtx.lineage,           // ALS 取当前 run 的 lineage
        parentBroker: env.parentBroker,
        parentTools: env.parentTools,
        parentSignal: ctx.abortSignal,
        task: prompt,
      });
      // description 仅 Task closure 自持(用于 ToolResult 错误标签 / CLI 状态条),
      // 不传 runChildAgent —— 子 agent 任务全文已在 system prompt "Your Role" 段,
      // description 是父侧呈现层概念,不是子业务层概念,YAGNI 单一职责
      return formatChildResultAsToolResult(result, description);
    },
  };
}
```

**`ToolExecutionContext` 接口零变动** —— Task 通过 `env` closure 持具体服务引用,通过 `runContextStorage`(AsyncLocalStorage)取 per-run bus/lineage;ctx 不污染。

**为什么 env 不持 `parentRuntime: AgentRuntime`**:在 `createAgentRuntime` 函数内 `createTaskTool` 调用时,AgentRuntime return 对象**尚未构造**(返回语句还没执行)。直接 capture 装配期局部变量(`provider / model / llmRoles / securityPipeline / workspace / workspaceSource / globalConfigPath / parentBroker / parentTools` —— 字段集与 `TaskToolEnv` 接口严格一致,见上方 L695-708)避免 forward reference / 循环引用,且更精确表达"Task 需要哪些服务"。

**AgentRuntime 接口零字段变更** —— 不暴露 `provider` / `llmRoles` 等内部实例(避免 leaky abstraction 让外部代码 bypass runtime 装配链直接 `.chat()`)。runChildAgent 的测试由调用方构造 mock services,不通过 AgentRuntime 提取。

**Boundaries 声明(SecurityPipeline 分类锚点)**:Task 工具显式声明 `boundaries: [{ boundaryType: "process", access: "exec", dynamic: false }]`(本文件 export `TASK_TOOL_BOUNDARIES`,作为常量被 `createTaskTool` 与装配方共享)。

为什么必须声明,**不能省**:
- `BoundaryImpactClassifier` 在 SecurityPipeline 的 middleware 链中按 boundaryRegistry 查工具语义;**未注册**的工具走 fail-closed 默认 → 升级为 `critical` 操作类。
- 在非交互模式(CI / `--noninteractive` / serve no-broker)下,`PermissionMatcherMiddleware` 对 `critical`(经 `OperationClassifierMiddleware` 升级为 `confirm`)的操作默认拒绝,因为没有 UI 让用户确认。
- 结果:Task 工具被静默阻止,主 agent 收到 `tool_result.isError=true` "操作被阻止",子 agent 永远跑不起来。

`process/exec` 的语义:Task 工具的副作用是"派生子 agent loop 运行"——子 loop 内部有自己的 SecurityPipeline 评估真实工具,Task 自身不直接动文件 / 网络 / shell;最贴近的边界是"派生子进程式的执行单元",分类器据此把 Task 归为 `internal`(无需用户确认,直接放行)。

`dynamic: false`:运行时不变 —— 静态可知 Task 一定是 `process/exec`,无运行时分支(对比 bash 工具 `dynamic: true`,需要解析具体 cmd 才能判断 readonly vs 写文件)。

**注册时机**:`createTaskTool` 仅返回带 `boundaries` 的 `ToolDefinition`;**装配方负责把 `boundaries` 注入到 mutable `boundaryRegistry`** —— 详见 §4.4 装配代码示例。这是 `boundaries` 自描述模式的核心契约:工具方声明语义,装配方负责注入安全管道(避免每个工具自己 import 全局 registry)。

### 4.2 `inputSchema`

```typescript
export const TASK_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "A short (3-5 word) summary of the task, shown in status bar.",
    },
    prompt: {
      type: "string",
      description: "Detailed task for the sub-agent. This is the only place the task is described — do not repeat it in any other field.",
    },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
};
```

**为什么不加 `subagent_type`**:v1 单一 role(`"sub"`),没有 researcher/critic 等具体角色。让 LLM 不必学习这字段,prompt 紧凑。v2+ 引入 RoleTask 时再扩。

**为什么不加 `model` / `run_in_background` / `isolation` / `cwd`**:
- model:子复用父 model
- run_in_background:Step 22 单独工具
- isolation:不做 worktree / remote
- cwd:子共享父工作目录

### 4.3 `output` 三态(`tool_result.content` 文本协议)

子 agent 完成后,`formatChildResultAsToolResult(result, description)` 把 `ChildAgentResult` 转换成 `ToolResult { content, isError }`:

```typescript
function formatChildResultAsToolResult(
  result: ChildAgentResult,
  description: string,
): ToolResult {
  switch (result.status) {
    case "completed":
      return {
        content:
          result.finalAssistantText +
          `\n\n<usage>tokens: ${result.usage.totalTokens}, tool_uses: ${result.toolUses}, duration_ms: ${result.durationMs}, sub_id: ${result.subAgentId.slice(0, 6)}</usage>`,
        isError: false,
      };

    case "failed":
      return {
        content:
          `[Task "${description}" failed: ${result.error?.message ?? "unknown error"}]\n\n` +
          (result.partial ? `Partial output:\n${result.partial}\n\n` : "") +
          `<usage>tokens: ${result.usage.totalTokens}, duration_ms: ${result.durationMs}, sub_id: ${result.subAgentId.slice(0, 6)}</usage>`,
        isError: true,
      };

    case "aborted":
      const reasonStr = formatAbortReasonForLLM(result.abortReason!);
      return {
        content:
          `[Task "${description}" aborted: ${reasonStr}]\n\n` +
          (result.partial ? `Partial output:\n${result.partial}\n\n` : "") +
          `<usage>tokens: ${result.usage.totalTokens}, duration_ms: ${result.durationMs}, sub_id: ${result.subAgentId.slice(0, 6)}</usage>`,
        isError: true,
      };
  }
}
```

**`formatAbortReasonForLLM`**(`orchestrator/src/subagent/abort-format.ts`):

| `AbortReason.kind` | LLM 看到的文本 |
|---|---|
| `user-cancel` | `"user cancelled the parent task"` |
| `idle-timeout` | `"sub-agent LLM stream idle for too long"` |
| `parent-abort` | `"parent agent was aborted"` |
| `external` | `"external abort: ${origin}"`(若 origin 提供) |

### 4.4 Task 工具装配时机

`createTaskTool` 由 orchestrator 在装配主 runtime 时调用,**不**通过 `attachTool` 后置注入。`createAgentRuntime` 接受 `enableTaskTool?: boolean`(默认 false):

```typescript
// packages/orchestrator/src/runtime/create-agent-runtime.ts

export async function createAgentRuntime(options: {
  // ... 既有字段
  enableTaskTool?: boolean;        // 默认 false;主路径 cli/server 入口何时传 true 见 §15 M2.4
}): Promise<AgentRuntime> {
  // ... 装配 securityPipeline / broker / boundaryRegistry / workspace 等
  // workspace: ResolvedWorkspace = resolveWorkspace(config, ...) —— 装配期非空(类型契约保证)

  // baseTools 是不含 Task 的"基础工具集",作为 Task 的 parentTools 传入(子按
  // subAgentSafe 过滤后从中派生);双引用风格(baseTools / tools)清晰区分两个语义,
  // 比 mutable push 更安全(避免后续装配步误改原集合污染子工具池)
  const baseTools: ToolDefinition[] = [
    createReadTool(), createWriteTool(), /* ... */
    ...(options.extraTools ?? []),
  ];

  let tools: ToolDefinition[] = baseTools;

  if (options.enableTaskTool) {
    // Task closure capture 装配期已知的服务(避免 forward ref AgentRuntime);
    // per-run 的 eventBus / lineage 走 runContextStorage(ALS),见 §4.1
    //
    // 双层契约:
    //   - `workspace` 对象本身:resolveWorkspace 类型签名返 ResolvedWorkspace 非
    //     undefined,装配期保证可解引用 .path / .source 不抛
    //   - `workspace.path` 字段:ResolvedWorkspace.path 类型 `string | null`,
    //     在 ci 模式且无 cli/config workspace 配置时为 null(`source: "none"`);
    //     交互模式 cwd 兜底时非 null
    //   - 直接透传到 TaskToolEnv.workspace(类型签名 `string | null` 兼容此情况);
    //     buildSystemPrompt 在 workspace=null 时跳过工作区路径段渲染,无运行期错
    const taskTool = createTaskTool({
      provider: roles.main.provider,
      model: roles.main.model,
      llmRoles: roles,
      securityPipeline,
      workspace: workspace.path,
      workspaceSource: workspace.source,
      globalConfigPath: getGlobalConfigPath(),
      parentBroker: confirmationBroker,
      parentTools: baseTools,        // 直接传 ref(不 spread),子工具池来源不变
    });
    tools = [...baseTools, taskTool];

    // 把 Task 的 boundaries 注入 mutable boundaryRegistry —— SecurityPipeline
    // 分类必须的一步,见 §4.1 末"Boundaries 声明"。省略则 Task 在非交互模式
    // 被 fail-closed 阻止
    if (taskTool.boundaries && taskTool.boundaries.length > 0) {
      boundaryRegistry.register(taskTool.name, taskTool.boundaries);
    }
  }

  // ... 用 tools(含或不含 Task)装配 systemPrompt / 返 runtime
}
```

**为什么 Task 是少数走"装配方注册 boundaries"路径的工具**:绝大多数 builtin 工具(read / write / bash / ...)由 `boundaryRegistry` 在初始化阶段从静态 `BUILTIN_TOOL_BOUNDARIES` 表预注册;Task 工具是**条件性装配**(`enableTaskTool` 控制),且属于 orchestrator 包(builtin 表在 core 包,跨包加 Task 会破坏依赖方向)—— 因此走"工具自带 boundaries 字段 + 装配方动态注册"路径,是 capability-tag 自描述模式的扩展。

**关键细节 — EventBus 是 per-run,通过 `AsyncLocalStorage` 传递到 Task closure**:

[create-agent-runtime.ts:546](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts#L546) `const eventBus = createEventBus<AgentEventMap>({ lineage: "main" })` 在 `runtime.run()` 入口创建,run 结束 GC。Task 工具实例在 `createAgentRuntime` 时构造(此时尚无 eventBus),必须有机制让 Task closure 在 `call()` 执行时读到当前 run 的 bus。

**正解:Node.js `AsyncLocalStorage`**(`node:async_hooks`)—— 自动按异步上下文隔离 per-run 状态,无 mutable runtime 字段,天然支持未来并发 run。

```typescript
// orchestrator/src/runtime/run-context.ts

import { AsyncLocalStorage } from "node:async_hooks";

export interface RunContext {
  // 用具体类 EventBus(不是 IEventBus 接口):Task 工具拿这个 bus 透传到
  // runChildAgent 作 parentBus,createEventBus 的 parent 字段要求 EventBus 类。
  bus: EventBus<AgentEventMap>;
  lineage: string;     // 主 = "main";嵌套层级时 "main/sub-.../sub-..."
}

export const runContextStorage = new AsyncLocalStorage<RunContext>();
```

`runtime.run()` 入口包裹 agent loop 调用:

```typescript
async run(params: RunParams): Promise<RunResult> {
  const eventBus = createEventBus<AgentEventMap>({ lineage: "main" });   // 显式 lineage
  // ... 既有装配
  return await runContextStorage.run(
    { bus: eventBus, lineage: "main" },
    async () => {
      // 既有 agent loop 主流程,在此 ALS 上下文内执行
      return await runAgentLoopAndAssemble({...});
    },
  );
}
```

Task 工具 closure(完整接口见 §4.1):

```typescript
// closure 内通过 ALS 拿当前 run 上下文,无需 mutable cell
export function createTaskTool(env: TaskToolEnv): ToolDefinition {
  return {
    // ...
    call: async (input, ctx) => {
      const runCtx = runContextStorage.getStore();
      if (!runCtx) throw new Error("Task tool called outside agent run");
      return await runChildAgent({
        ...env,                              // 共享服务 + parentBroker + parentTools
        parentBus: runCtx.bus,              // ← ALS 取
        parentLineage: runCtx.lineage,      // ← ALS 取
        parentSignal: ctx.abortSignal!,
        task: input.prompt as string,
        description: input.description as string,
      });
    },
  };
}
```

**为什么 ALS 比 mutable cell 优**:
- 自动按异步上下文隔离,**支持并发 run**(将来若服务端单 runtime 跑多 conversation,无需重构)
- 无 stateful runtime 字段,符合 "AgentRuntime 纯计算"分层
- Node 14+ 标准 API,无依赖

**子 agent 嵌套**(maxDepth > 1):`runChildAgent` 内部也调 `runContextStorage.run({ bus: childBus, lineage: childLineage }, async () => runAgentLoop(...))`,孙子 Task closure 自动取到 sub 当前的 bus 和 lineage,无需手工传递。

### 4.5 Task 工具 prompt(给 LLM 的描述)

```
Launch a sub-agent to perform a research-style sub-task with isolated context.

When to use:
- Researching a topic that requires multiple Read/Grep/WebFetch rounds — sub-agent's intermediate results stay in its own context, not polluting yours.
- Comparing alternatives (A vs B vs C) — dispatch parallel Tasks, then synthesize.
- Multi-perspective analysis (e.g. security / performance / readability review) — dispatch parallel Tasks with different prompts.

When NOT to use:
- Single-file Read / Glob / Grep — use those tools directly. Task is overhead.
- Simple yes/no factual questions — answer directly.
- When the user asked something that needs your direct response — sub-agent output is internal, you must still synthesize and respond.

Concurrency: You may launch up to 3 Tasks in a single turn. They run in parallel.

Recursion: Sub-agents do not have access to the Task tool — they cannot dispatch further sub-agents.

Failure handling: If a Task fails, you will receive a tool_result with `is_error: true`. You MUST acknowledge the failure in your final response (e.g. "Task#X failed; the following is based on other sources") — do not pretend it succeeded or omit it silently.

Output format: The sub-agent's final response is returned as the tool_result content. Use it to inform your synthesis. The user does not see the sub-agent's intermediate steps.

Each Task is stateless — you cannot send follow-up messages to a running Task.
```

主 agent system prompt 在 §6.4 也加一段 Sub-Agent Delegation 鼓励合理使用。

---

## 5. State 边界矩阵

子 agent 与父在哪些资源上共享、哪些独立。

### 5.1 全字段表

| 资源 | 父子关系 | 实现 |
|---|---|---|
| LLM Provider 实例 | **共享**(per-runtime 单例) | Task closure 在 createAgentRuntime 内 capture `roles.main.provider`,经 TaskToolEnv 透传到 runChildAgent → runSubAgentLoop → runAgentLoop |
| API key / auth | **共享** | provider 内部封装 |
| Model 配置 | **共享**(子用父 model) | 同上,closure capture `roles.main.model` |
| LLMRoles(main / secondary) | **共享**(供子工具如 WebFetch distill 用) | 同上,closure capture `roles` |
| Tool registry(builtin) | **共享读,独立装配视图**(按 `subAgentSafe` filter) | `parentTools.filter(...)` |
| Working directory | **共享**(子可读写父 cwd) | `process.cwd()` 共享 |
| ConversationId | **不适用**(子不接 transcript,无 commit / load 路径,conversationId 对子无意义) | — |
| TranscriptStore | **不直接持** | 子不调 commitTurn |
| Conversation 历史 messages | **不共享**(子初始 = synthetic Begin) | sub agent loop 起空白 |
| `AgentRoleProfile` | **独立**(每次 spawn 新建 sub profile) | `subAgentProfile({...})` |
| System prompt | **独立**(`buildSystemPrompt` SUB_AGENT_SEGMENTS) | 子 segment 集 |
| Conversation context window | **独立** | 子有自己的 messages 列表 |
| `ConfirmationBroker` | **独立**(child broker,默认 `failToDenyResolver`) | new ConfirmationBroker(...) |
| `IEventBus` | **独立 child bus**,父 bus 自动接收冒泡 | `createEventBus({ parent, lineage })` |
| AbortController | **由 `runAgentLoop` 内部派生**(传入 `parentSignal: parentRuntimeAbortSignal`,runAgentLoop 入口 `createInterruptController({ parent })` 自动 fork,见 [agent-loop.ts:98](../../../packages/core/src/loop/agent-loop.ts#L98)) | runAgentLoop 入参 |
| AbortReason 父→子 | typed `parent-abort { parentReason }`(`createInterruptController({ parent })` → `forkController` 链路自动注入) | controller 内部已具备 |
| `MemoryStore` | **共享底座**(理论可用),但**子不暴露 Memory 工具 + 子 system prompt 不含 memory 段** —— 子既不读也不写主用户记忆 | createAgentRuntime 局部 + 子 tool/segment 双重过滤 |
| `SecurityPipeline` | **共享**(子 tool 调用走同一权限评估) | Task closure capture `securityPipeline`(局部变量) |
| `PermissionStore` | **共享**(父 `allow-session/workspace/global` 自动惠及子) | 通过 SecurityPipeline 共享(persistentStore 局部变量) |
| `ContextEngine` | **v1 子不创建**(子任务短,靠 `maxTurns`(20)+ `maxTokens`(50K)budget 截断;不接 `runAgentLoop.contextManager`) | runAgentLoop `contextManager: undefined` |
| Project context | **共享**(同项目) | parent 传入 |
| `AbortReason 子主动` | `idle-timeout` / `external` 各按需 | 子 runtime 决定 |

### 5.2 与业界对比

| 维度 | 我们 | Claude Code | OpenClaw | Hermes |
|---|---|---|---|---|
| 持久化 | **不持久化子中间过程** | sidechain 文件 | 独立 sessionFile | SQLite parent_session_id FK |
| Memory 隔离 | capability-tag(单一真相源) | 黑名单 ALL_AGENT_DISALLOWED_TOOLS | 黑名单 SUBAGENT_TOOL_DENY_ALWAYS | 黑名单 DELEGATE_BLOCKED_TOOLS |
| Confirmation 边界 | 共享 PermissionStore + 子 broker auto-deny | toolPermissionContext 派生 + 强制 avoid prompt | 全局 broker 不分父子 | TLS / ContextVar |
| AbortController 边界 | `parentSignal` 链(loop 内部 `createInterruptController({ parent })` 自动 fork,typed `parent-abort`) | shareAbortController flag | 完全独立(必须显式 cascadeKill) | 父 interrupt 末尾遍历 _active_children |

我们的优势:每一行都是协议,不是绕路。

---

## 6. 子 agent 执行协议

### 6.1 `runChildAgent` 主入口

**位置**:`packages/orchestrator/src/subagent/factory.ts`

```typescript
export interface RunChildAgentOptions {
  // 共享服务(子复用父构造好的实例,避免 createProviderRoles 等重复装配)
  provider: LLMProvider;
  model: string;
  llmRoles: LLMRoles;
  securityPipeline: SecurityPipeline;
  // 工作区相关字段平铺(对齐 buildSystemPrompt PromptBuildContext 的字段形态,
  // 子 system prompt 装配时直接透传 opts.* 即可,无中间结构):
  //   - workspace            工作区路径(null 表示无工作区)
  //   - workspaceSource      工作区来源标识(cli / directory-config / global-config / cwd-fallback)
  //   - globalConfigPath     全局配置路径(独立概念,与 workspace 来源不同)
  workspace: string | null;
  workspaceSource?: string;
  globalConfigPath?: string;
  // 父级 spawn 上下文
  // parentBus 必须是具体类 EventBus(不是 IEventBus 接口):createEventBus 的
  // EventBusOptions.parent 字段在实现层依赖类内部的 emitFromChild 私有方法,
  // 接口类型无法承载该契约;Task 工具拿 ALS 中的 runCtx.bus(就是 EventBus 实例)
  // 透传到这里,类型链一致。
  parentBus: EventBus<AgentEventMap>;
  parentLineage: string;
  parentBroker: IConfirmationBroker;
  parentTools: readonly ToolDefinition[];
  parentSignal: AbortSignal;

  /** 任务文本(进 system prompt 的 "Your Role" 段,不进 user message) */
  task: string;
  /** 资源预算(可选,默认见 §7) */
  budget?: SubAgentBudget;
}

export interface ChildAgentResult {
  status: "completed" | "failed" | "aborted";
  subAgentId: string;
  /** 子 agent 最后 assistant 文本(空字符串 if 没有) */
  finalAssistantText: string;
  /** 子 LLM 用量(子内部 sum) */
  usage: TokenUsage;
  /** 子工具调用次数 */
  toolUses: number;
  durationMs: number;
  /** status === "aborted" 才有 */
  abortReason?: AbortReason;
  /** status === "failed" 才有 */
  error?: { message: string; type: string };
  /** failed/aborted 时若已有部分 assistant 文本 */
  partial?: string;
}

export async function runChildAgent(
  opts: RunChildAgentOptions,
): Promise<ChildAgentResult>;
```

**实现要点**(伪代码):

```typescript
async function runChildAgent(opts: RunChildAgentOptions): Promise<ChildAgentResult> {
  const subAgentId = randomUUID();
  const profile = subAgentProfile({ subAgentId, task: opts.task });
  const childLineage = deriveChildLineage(opts.parentLineage, subAgentId);

  // 1. 派生子原语 —— **不**手工 forkController,runAgentLoop 内部 createInterruptController
  //    会自动用 parentSignal 派生 child controller 并注入 parent-abort kind
  //    (见 [agent-loop.ts:98](../../../packages/core/src/loop/agent-loop.ts#L98))
  const childBus = createEventBus<AgentEventMap>({
    parent: opts.parentBus,
    lineage: childLineage,
  });

  // budget 必须先经 resolveSubAgentBudget 投影成 ResolvedSubAgentBudget,
  // 再读 budget.confirmationPolicy(全字段完备,缺省自动 fallback DEFAULT_SUB_CONFIRMATION_POLICY)
  // —— 不要直接读 opts.budget?.confirmationPolicy,后者绕过单一真相源,默认值同步将断裂
  const budget = resolveSubAgentBudget(opts.budget);

  // child broker 不注入 eventBus —— 与主 broker 装配模式一致(broker 内部 emit
  // 事件不依赖 bus 路径,审计字段通过 snapshot() 接口暴露,EventBus 路径预留未来接入);
  // 字段顺序与 ConfirmationBrokerOptions 结构一致,parentBrokerId / sourceAgentId
  // 是审计血缘元信息,broker emit 事件 / snapshot() 时透传
  const childBroker = new ConfirmationBroker({
    parentBrokerId: opts.parentBroker.id,
    sourceAgentId: subAgentId,
    nonInteractiveResolver: resolveSubAgentResolver(budget.confirmationPolicy),
  });
  // 默认 policy "inherit-or-deny" → failToDenyResolver(broker 已默认行为);
  // 父 alwaysAllow 通过共享 PermissionStore 自动命中,根本不进 broker

  // 2. 装配子 tools(capability filter)
  const childTools = opts.parentTools.filter(t => t.subAgentSafe === true);

  // 3. 装配子 system prompt
  //    注意:不传 project context / 用户记忆 / 父反思 —— 子 agent 任务专注,
  //    跨 spawn 的静态前缀 byte-identical 利于 prompt cache(详见 §3.3 / §6.3)
  const   systemPrompt = buildSystemPrompt({
    profile,
    segments: SUB_AGENT_SEGMENTS,
    tools: childTools,
    cwd: process.cwd(),
    workspace: opts.workspace,
    workspaceSource: opts.workspaceSource,
    globalConfigPath: opts.globalConfigPath,
  });

  // 4. 注入极短 user message(决定 #11)
  const initialUserMessage: Message = {
    role: "user",
    content: `Begin. Your task is in the system prompt under "Your Role". Depth: 1/1.`,
  };

  // 5. 跑 child agent loop —— 通过 ALS 装上 child run context 后调 runSubAgentLoop
  const startTime = Date.now();
  let runResult: SubAgentLoopResult | null = null;
  let caughtError: unknown = null;

  try {
    runResult = await runContextStorage.run(
      { bus: childBus, lineage: childLineage },
      async () =>       runSubAgentLoop({
        profile,
        systemPrompt,
        messages: [initialUserMessage],
        tools: childTools,
        // 共享父持久原语
        provider: opts.provider,
        model: opts.model,
        llmRoles: opts.llmRoles,
        securityPipeline: opts.securityPipeline,
        confirmationBroker: childBroker,
        // per-spawn
        eventBus: childBus,
        parentSignal: opts.parentSignal,         // ← 直接透传给 runAgentLoop;loop 内部 fork
        // budget —— 全字段读 resolveSubAgentBudget 投影后的对象,不要再写
        // `opts.budget?.X ?? DEFAULT_X` 散落 fallback,后者绕过单一真相源
        maxTurns: budget.maxTurns,
        maxTokens: budget.maxTokens,
        watchdog: createWatchdogPolicy({
          idleTimeoutMs: budget.llmIdleTimeoutMs,
        }),
        wallClockTimeoutMs: budget.wallClockTimeoutMs,
      }),
    );
  } catch (err) {
    caughtError = err;
  } finally {
    // 6. cleanup discipline(无 child controller 引用 —— runAgentLoop 自管;只清外部资源)
    childBus.removeAllListeners?.();
    childBroker.cancelAll("session-end");
  }

  // 7. 分类 + 提取
  const kind = classifyResult(runResult, caughtError);
  const finalText = extractFinalAssistantText(runResult?.messages ?? []);
  const partial = kind === "completed"
    ? undefined
    : (finalText || extractPartialText(runResult?.messages ?? []));

  // 8. 返回 ChildAgentResult —— **永不抛**(INV-S6)
  return buildChildResult({
    kind,
    subAgentId,
    finalText,
    partial,
    usage: runResult?.usage ?? EMPTY_USAGE,
    toolUses: runResult?.toolUseCount ?? 0,
    durationMs: Date.now() - startTime,
    error: caughtError,
    abortReason: runResult?.abortReason,        // 由 runSubAgentLoop 从 AgentResult.aborted.abortReason 透传
  });
}
```

**`runSubAgentLoop`**(`orchestrator/src/subagent/loop-runner.ts`):内部用 `drainAgentLoop`([agent-loop.ts:501](../../../packages/core/src/loop/agent-loop.ts#L501))驱动 `runAgentLoop`,做三件事:
1. 用 `createSecureExecuteTool({ pipeline, broker, originalExecute })` 把子 tools 包装成走共享 securityPipeline + 子 broker 的 `executeTool`
2. 通过 `deps.executeTool` 注入到 runAgentLoop
3. drainAgentLoop 的 yields 通过类似 [run-agent.ts:638 `trackMessages`](../../../packages/cli/src/run-agent.ts#L638) 收集成完整 messages 数组

签名:
```typescript
export interface SubAgentLoopResult {
  /** Conversation messages 数组(含初始 Begin + 所有 LLM / tool 消息) */
  messages: Message[];
  /** 累计 token usage(来自 AgentResult.usage) */
  usage: TokenUsage;
  /** budget 软上限触发种类(max_turns / max_tokens / wall_clock 统一建模);未触发时 undefined */
  budgetExceededKind?: BudgetExceededKind;
  /** tool 调用次数(由 yields 中 tool_end 计数) */
  toolUseCount: number;
  /** AgentResult 终止原因 — completed/max_turns/aborted/error */
  reason: AgentResult["reason"];
  /** abort 透传(reason="aborted" 时由 AgentResult.aborted.abortReason 取) */
  abortReason?: AbortReason;
}

export async function runSubAgentLoop(opts: {
  profile: AgentRoleProfile;                 // 仅供 audit log,不再二次拼 prompt
  systemPrompt: string;
  messages: Message[];
  tools: readonly ToolDefinition[];
  provider: LLMProvider;
  model: string;
  llmRoles: LLMRoles;
  securityPipeline: SecurityPipeline;
  confirmationBroker: IConfirmationBroker;
  // 与 runChildAgent.parentBus / RunContext.eventBus 同型(EventBus 类),
  // 子 loop 内若再 spawn 孙子 agent 时把此 bus 当作 parentBus 透传,类型链一致。
  eventBus: EventBus<AgentEventMap>;
  parentSignal: AbortSignal;                 // ← runAgentLoop 内部 fork
  maxTurns: number;
  maxTokens: number;
  watchdog: WatchdogPolicy;
  wallClockTimeoutMs: number;
}): Promise<SubAgentLoopResult>;
```

实现骨架(伪代码):
```typescript
async function runSubAgentLoop(opts) {
  // wallClockTimeout 通过外置 setTimeout 设 external signal
  const wallClockController = new AbortController();
  const wallClockTimer = setTimeout(
    () => abortWithReason(wallClockController, { kind: "external", origin: "subagent-wall-clock-timeout" }),
    opts.wallClockTimeoutMs,
  );

  try {
    // 包装 secure-executor — 共享 pipeline,子 broker
    const secureExecuteTool = createSecureExecuteTool({
      pipeline: opts.securityPipeline,
      originalExecute: (tool, input, ctx) => tool.call(input, ctx),
      broker: opts.confirmationBroker,
      sessionType: "interactive",                // 子默认 interactive(不弹也是因 broker 无 listener,自动 deny)
    });

    // drain agent loop 收集 yields 与 result
    const messages: Message[] = [...opts.messages];
    let toolUseCount = 0;

    const gen = runAgentLoop({
      provider: opts.provider,
      model: opts.model,
      tools: [...opts.tools],
      messages: opts.messages,
      systemPrompt: opts.systemPrompt,
      eventBus: opts.eventBus,
      parentSignal: opts.parentSignal,             // ← runAgentLoop 内部派生 child controller(parent-abort kind)
      abortSignal: wallClockController.signal,      // wallClock external signal(loop 内部包装为 externalSignals[0],external kind)
      watchdog: opts.watchdog,
      maxTurns: opts.maxTurns,
      llmRoles: opts.llmRoles,
      deps: {
        callLLM: undefined,                         // 走 default(provider.chat)
        executeTool: secureExecuteTool,
      },
    });

    let agentResult: AgentResult;
    while (true) {
      const { value, done } = await gen.next();
      if (done) { agentResult = value; break; }
      if (value.type === "tool_end") toolUseCount++;
      trackMessages(value, messages, []);          // 复用 run-agent.ts 的 helper
    }

    return {
      messages,
      usage: agentResult.usage,
      toolUseCount,
      reason: agentResult.reason,
      budgetExceeded: agentResult.reason === "max_turns",
      abortReason: agentResult.reason === "aborted" ? agentResult.abortReason : undefined,
    };
  } finally {
    clearTimeout(wallClockTimer);
  }
}
```

**关键注**:
- `runSubAgentLoop` 自行管理 wallClockController(setTimeout 触发 `abortWithReason(controller, { kind: "external", origin: "subagent-wall-clock-timeout" })`),把 `wallClockController.signal` 作为 `runAgentLoop.abortSignal` 单 slot 传入(loop 内部已包装为 `externalSignals[0]`,见 [agent-loop.ts:98-100](../../../packages/core/src/loop/agent-loop.ts#L98-L100)) —— **无需扩 AgentLoopParams**
- `parentSignal` 单独 slot 透传给 runAgentLoop,内部 createInterruptController 自动派生 child controller 并注入 `parent-abort` kind
- `trackMessages` helper 现在 cli/run-agent.ts 内部,M1.6 抽到 `orchestrator/src/runtime/track-messages.ts` 主子共用

### 6.2 启动序列图

```
父 turn N (main):
  ├─ runtime.run():
  │    1. 创建 per-run eventBus({ lineage: "main" })
  │    2. runContextStorage.run({ bus: eventBus, lineage: "main" }, async () => {...agent loop...})
  │       —— RunContext 字段名为 bus(对齐 run-context.ts);ALS 透传不重命名
  ├─ user msg
  ├─ assistant tool_use(Task, { description, prompt })   ← 父 LLM 决定派 Task
  │
  └─[ tool dispatcher 调 Task.call(input, ctx) ]
        │
        ▼
     Task.call (closure 持具体共享服务;ALS 取 per-run state):
       1. runCtx = runContextStorage.getStore() → { bus, lineage: "main" }
       2. ctx.abortSignal → parentSignal(父 controller.signal)
       3. 调 runChildAgent({
            provider, model, llmRoles, securityPipeline,                           ← closure 持
            workspace, workspaceSource, globalConfigPath,                          ← closure 持(平铺)
            parentBus: runCtx.bus, parentLineage: runCtx.lineage,                  ← ALS 取
            parentBroker, parentTools,                                             ← closure 持
            parentSignal: ctx.abortSignal,                                         ← ctx
            task: prompt,                                                          ← input(description 不下传)
          })
            │
            ▼
        runChildAgent:
          1. subAgentId = randomUUID()
          2. profile = subAgentProfile({ subAgentId, task })
          3. childLineage = "main/sub-<subAgentId.slice(0,8)>"
          4. childBus = createEventBus({ parent: parentBus, lineage: childLineage })
          5. childBroker = new ConfirmationBroker({ parentBrokerId, sourceAgentId, nonInteractiveResolver })
          6. childTools = parentTools.filter(t => t.subAgentSafe === true)
          7. systemPrompt = buildSystemPrompt({ profile, segments: SUB_AGENT_SEGMENTS, ... })
          8. await runContextStorage.run({ bus: childBus, lineage: childLineage }, async () =>
               runSubAgentLoop({
                 ..., parentSignal: opts.parentSignal,           // ← runAgentLoop 内部派生 child controller
                                                                  // 自动注入 parent-abort kind
                 ...,
               })
             )
          9. cleanup (finally): childBus.removeAllListeners / childBroker.cancelAll
                                  ↑ 无 child controller 可调 — runAgentLoop 自管
          10. classifyResult / extractFinalAssistantText / extractPartialText
          11. return ChildAgentResult { status, finalText, usage, abortReason?, ... }    ← **永不抛**
            │
            ▼
       4. formatChildResultAsToolResult(result, description) → ToolResult { content, isError }
          —— description 仅 Task closure 自持(错误标签 / 状态条),不传 runChildAgent
       5. return ToolResult

父 turn N (continued):
  ├─ tool dispatcher 把 ToolResult 转 tool_result block
  ├─ assistant final text   ← 父 LLM 综合子结果
  └─ runtime.run() return RunResult { turn, ... }

REPL/SessionRuntime:
  └─ store.commitTurn(conversationId, { turn })   ← 主 turn 完整落盘,toolCalls 含 Task 调用记录
```

**关键时序点**:
- 父 abort cascade 路径:`runtime.run()` 入口 controller → `ctx.abortSignal` → `runChildAgent.opts.parentSignal` → `runSubAgentLoop` 透传给 `runAgentLoop.parentSignal` → `createInterruptController({ parent })` 在 child loop 内派生 controller 并自动 fork(`parent-abort` typed kind)
- 子的所有事件实时通过 EventBus 冒泡到父(渲染层立即看见,但**不持久化**)
- 父 turn 的 commitTurn 是唯一一次 transcript 写入,包含父的 user/assistant + 含 Task 工具的 toolCalls
- 子整个生命周期内子 turn **从不 commit**
- ALS(`runContextStorage`)自动按异步上下文隔离 per-run/per-spawn 的 eventBus 和 lineage,**自动支持嵌套 sub agent 与并发 run**

### 6.3 子 agent 初始 user message(决定 #11)

固定模板,极短:

```
Begin. Your task is in the system prompt under "Your Role". Depth: 1/1.
```

**为什么**:
- task 文本只在 system prompt(`profile.instructions`)出现一次。重复在 user message = input token 翻倍 + prompt cache miss(OpenClaw issue #72019 已论证)
- "Depth: N/M" 让子自知深度,与决定 #3 配合
- v1 默认 `1/1`;maxDepth > 1 时动态填充

**不含的内容**(子 agent 不继承父上下文):

- ❌ 项目上下文(ZHIXING.md / enriched skills) —— 主 agent 已在 `task` 中显式提炼相关部分
- ❌ 父对话历史 —— 子 agent 任务专注,不需要主 agent 与用户的来回上下文
- ❌ 用户身份段(memory:identity) —— 子不直接对话用户,身份信息无意义
- ❌ 反思 / 技能注入 —— `memory` 工具不在子 agent 工具集(subAgentSafe:false)

设计目的(详见 §3.3 子 agent 段集合的设计取舍):
1. **prompt cache 友好** —— 同角色子 agent 跨 spawn 静态前缀 byte-identical
2. **任务专注** —— 子 agent 输出不被无关上下文干扰
3. **职责分明** —— 主 agent 负责"挑出相关上下文",子 agent 负责"执行任务",不混淆

### 6.4 主 agent system prompt 增强

实现位置:`packages/orchestrator/src/runtime/system-prompt.ts` —— 作为**条件性 segment**(`sub-agent-delegation`),**不**写入 `mainProfile().instructions`。

段文本(导出常量 `SUB_AGENT_DELEGATION_TEXT`,作为 byte-equal 锚点供测试断言):

```markdown
## Sub-Agent Delegation (Task tool)

You have access to a `Task` tool that lets you launch sub-agents for research-style sub-tasks with isolated context.

When to use Task:
- Research tasks needing multiple Read/Grep/WebFetch rounds (sub-agent's intermediate results don't pollute your context window)
- Comparison/contrast tasks (dispatch parallel Tasks, e.g. "compare A vs B vs C" → 3 Tasks)
- Multi-perspective analysis (e.g. security review + performance review + readability review)

You may launch up to 3 Tasks in a single turn. They run in parallel.

When a Task fails, you MUST surface the failure in your final response — do not silently continue or pretend it succeeded.
```

**条件渲染契约**(`buildSubAgentDelegation(tools)` in `system-prompt.ts`):
- `tools` 含 name === "Task" 工具 → 返回 `SUB_AGENT_DELEGATION_TEXT`
- 不含 → 返回 `null`,被 `buildSystemPrompt` 跳过(无空白噪声)

**段位置**:`MAIN_AGENT_SEGMENTS` 中紧跟 `tool-usage` —— delegation 在概念上是 Task 工具使用的延伸说明,放工具段后是自然语义流。

**为什么是 segment 而非 `mainProfile().instructions`**:
- **条件性渲染**:`tools` 不含 Task 时 byte-equal 历史输出(从未启用过 Task 的 server / 测试场景无回归)。若硬编码到 instructions,无 Task 工具时 LLM 会看到不存在的 Task 引用,误导决策。
- **架构对称**:`skill-evolution` 段已经走"tools 含 memory 才渲染"的相同模式,delegation 跟随 → 段集驱动设计统一,非主路径下 `mainProfile()` 文本恒定 byte-equal。
- **测试锁定**:`SUB_AGENT_DELEGATION_TEXT` 作为常量导出后,byte-equal 锚点测试直接断言 `prompt.contains(SUB_AGENT_DELEGATION_TEXT)`,文案改动一目了然。

**`SUB_AGENT_SEGMENTS` 不含 `sub-agent-delegation`** —— 子 agent 工具集自然不含 Task(`subAgentSafe: false` 防递归),delegation 段对子无意义;即便子工具集出错地含 Task,segment 未启用是最后一道防线。

### 6.5 完成 / 失败 / 中止三态

`runChildAgent` 严格返回三态之一:

| 触发条件 | status | 说明 |
|---|---|---|
| 子 LLM 输出 final text 且无 tool_use | `completed` | 正常完成 |
| 子 LLM 调用抛非 abort 异常 | `failed` | network / provider / context overflow |
| 子工具调用抛异常 | `failed` | tool error |
| 子 maxTokens 软上限触发 | `failed`(`error.type: "max_tokens_exceeded"`) | partial 进 result.partial |
| 子 wallClockTimeout 触发 | `failed`(`error.type: "wall_clock_timeout"`) | 同上 |
| 子 LLM idle timeout(主模块协议) | `aborted`(`abortReason.kind: "idle-timeout"`) | 同上 |
| 父 abort 级联 | `aborted`(`abortReason.kind: "parent-abort"`) | parentReason 透传 |

**`extractFinalAssistantText` / `extractPartialText` 精确规则**(`orchestrator/src/subagent/result-classifier.ts`):

```
extractFinalAssistantText(messages):
  // 取最后一条 assistant message 中所有 text 块拼接;无 text 块返回 ""
  const lastAssistant = messages.findLast(m => m.role === "assistant");
  if (!lastAssistant) return "";
  return lastAssistant.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n\n");

extractPartialText(messages):
  // failed/aborted 时拼接所有 assistant message 的 text 块
  return messages
    .filter(m => m.role === "assistant")
    .flatMap(m => m.content.filter(b => b.type === "text").map(b => b.text))
    .join("\n\n");

classifyResult(runResult, caughtError, signal):
  if (caughtError instanceof AbortError || signal.aborted) return "aborted";
  if (caughtError != null) return "failed";
  if (runResult?.budgetExceeded) return "failed";
  return "completed";
```

**partial 抓取**:三态中失败 / 中止两态都尝试抓取 `partial`,作为部分输出回主。**比 Hermes 强**(Hermes 子失败父只看 status,不看 partial)。

---

## 7. 资源预算

### 7.1 字段定义

```typescript
export interface SubAgentBudget {
  /** 子 agent loop 最大交互轮次(对应 runAgentLoop.maxTurns)。子任务专注,不需要长链。默认 20(主 agent 默认 100) */
  maxTurns?: number;
  /** 单子 agent token 软上限。超过时 finalize current turn,不 mid-tool kill。默认 50_000 */
  maxTokens?: number;
  /** 子 LLM 流 idle 超时(ms)。继承主模块 idle watchdog。默认 90_000 */
  llmIdleTimeoutMs?: number;
  /** 子 agent 总 wall-clock 超时(ms)。默认 600_000(10 分钟) */
  wallClockTimeoutMs?: number;
  /** confirmation 策略。默认 "inherit-or-deny";v1 生产集 = inherit-or-deny / auto-deny(全部 fail-deny);测试 escape hatch 走 broker 直接构造 failToAllowResolver,不在本枚举,详见 §8.2 */
  confirmationPolicy?: SubAgentConfirmationPolicy;
}
```

### 7.2 默认值与配置项

**位置**:`packages/orchestrator/src/subagent/budget.ts`

| 名称 | 默认值 | 配置项(`config.intent.subagent.*`) | 备注 |
|---|---|---|---|
| `maxTurns` | 20 | `maxTurns` | runAgentLoop 入参;主默认 100,子专注短任务 |
| `maxTokens` | 50_000 | `maxTokensPerSub` | 保守软上限,触发 finalize partial |
| `llmIdleTimeoutMs` | 90_000 | `llmIdleTimeoutMs` | 与主模块 idle watchdog 一致 |
| `wallClockTimeoutMs` | 600_000 | `wallClockTimeoutMs` | 10 分钟,长任务上限 |
| `maxConcurrent`(同 turn 并发数) | 3 | `maxConcurrent` | 决定 #1;dispatcher 层校验 |
| `maxDepth` | 1 | `maxDepth` | 决定 #3;capability-tag 实现 |
| `confirmationPolicy` | `"inherit-or-deny"` | `confirmationPolicy` | v1 生产集 = `inherit-or-deny` / `auto-deny`(全部 fail-deny);测试 auto-approve 走 broker 直接构造,不在本枚举(`inherit-or-prompt` v2+ 见 §16);§8 |

### 7.3 软上限触发协议

`maxTokens` 触发时机:子 runtime 每次 LLM call 完成后,检查累计 tokens > maxTokens。若超:
1. **不**中断当前正在跑的 LLM call 或 tool call(graceful)
2. 在下一次 LLM call 之前,把 budget exceeded 标记为 stop 条件
3. 当前 partial assistant 文本 → `finalAssistantText` 返回
4. `runChildAgent` 返回 `status: "failed"`,`error.type: "max_tokens_exceeded"`,`partial` 字段填充

`wallClockTimeoutMs` 类似:setTimeout 触发时,标记 budget exceeded,下一次 LLM call 前停。**不 mid-call 强 kill**。

`llmIdleTimeoutMs` 走主模块 idle watchdog 协议,触发 `AbortReason.idle-timeout`,本规格 `status: "aborted"`。

---

## 8. Confirmation 协议

### 8.1 核心机制(决定 #5)

**关键洞察**:`alwaysAllow` 真相源是 [`PermissionStore`](../../../packages/core/src/security/permission-store.ts#L188)(规则表),**不是** broker.resolvedRecent(grace 周期内的瞬时缓存)。

当用户在父 agent 中选 `allow-session/workspace/global` 时,decision 携带 `pattern: SuggestedPattern` → secure-executor 持久化为 `PermissionStore` 规则。下次相同模式的请求,`SecurityPipeline.evaluate()` 调 `permissionStore.match()` 命中规则 → **不再触发 confirmation**。

子 agent **共享父的 SecurityPipeline + PermissionStore**(§5.1),所以:
- 父批了 `Edit /tmp/foo` allow-session → 规则进 PermissionStore
- 子调 `Edit /tmp/foo` → SecurityPipeline.evaluate 走同一 store,命中规则 → 不弹
- 子调 `Edit ~/.ssh/id_rsa` → 不命中规则 → 走 child broker → 默认 `failToDenyResolver` → auto-deny

**子 broker 的角色**就是处理那些**没匹配 PermissionStore 规则**的 confirmation 请求。它是一个 vanilla `ConfirmationBroker`,不挂 UI listener(子无 UI),自然走 `nonInteractiveResolver`。**不需要新设计 ChildBroker 类**。

### 8.2 v1 生产策略 + 测试 escape hatch

#### 8.2.1 生产策略集合

`SubAgentConfirmationPolicy` 联合类型仅含**生产安全**字面值 —— 配置文件 / API caller
无论传哪个值都不会绕过审批流程:

```typescript
export type SubAgentConfirmationPolicy =
  | "inherit-or-deny"     // 默认,实际行为 = 共享 PermissionStore + child broker failToDenyResolver
  | "auto-deny";           // 同上(语义上等价,显式名称)
// inherit-or-prompt 见 §16,v2+ 引入(需 hub 双向 UI 路由)
```

实现:`runChildAgent` 内部根据 policy 选 resolver(签名 policy 参数**必填,无字面默认**——
单一真相源 `DEFAULT_SUB_CONFIRMATION_POLICY` 收敛在 [subagent/budget.ts](../../../packages/orchestrator/src/subagent/budget.ts)):
```typescript
function resolveSubAgentResolver(
  policy: SubAgentConfirmationPolicy,
): NonInteractiveResolver {
  switch (policy) {
    case "inherit-or-deny":
    case "auto-deny":
      return failToDenyResolver;       // broker 默认行为
  }
}
```

#### 8.2.2 测试 escape hatch(`failToAllowResolver`)

测试 / 开发场景需要"auto-approve all"行为时,**不通过 `SubAgentConfirmationPolicy` 字符串**,
而是直接构造 broker 注入 `failToAllowResolver`:

```typescript
import { ConfirmationBroker, failToAllowResolver } from "@zhixing/core";
const testBroker = new ConfirmationBroker({ nonInteractiveResolver: failToAllowResolver });
```

**架构契约**:该设计让"生产策略"与"测试 escape hatch"在**类型层面**完全分离 ——
配置文件 / API caller 不可能通过 `SubAgentConfirmationPolicy` 字符串误传 auto-approve,
**杜绝因 misuse 造成的安全事故**。"刻意显式构造 broker"动作即是最好的防御:
- ✅ zhixing.config.json schema 校验只能传 `inherit-or-deny` / `auto-deny`,自然拒绝 auto-approve
- ✅ `runChildAgent` 调用方编译期保护:`budget.confirmationPolicy` 只能赋两值之一
- ✅ 测试 escape hatch 走 broker 直接构造,审查时一眼可见,可追责

v2+ 若引入"测试自定义 resolver"等高阶场景(预审批 resolver、chat-bot 介入等),
可在 `RunChildAgentOptions` 加显式字段(如 `_unsafeNonInteractiveResolver?`),
保持本约束:任何"绕过 fail-deny 默认姿态"的 API 都必须语义层面"危险"显式化。

### 8.3 子 broker 的 audit 元信息

**位置**:[core/confirmation/types.ts](../../../packages/core/src/confirmation/types.ts) + [core/confirmation/broker.ts](../../../packages/core/src/confirmation/broker.ts) ✅ M2.2 已落地:

```typescript
export interface ConfirmationBrokerOptions {
  // 既有字段:eventBus, nonInteractiveResolver, resolvedGraceMs, maxQueueDepth, now
  /** broker 实例 id —— 缺省 randomUUID(),仅测试需稳定 id 时显式传 */
  id?: string;
  /** 父 broker 的 id(审计血缘,不影响 broker 行为) */
  parentBrokerId?: string;
  /** 派生此 broker 的 sub-agent 实例 UUID(审计追溯) */
  sourceAgentId?: string;
}

export interface IConfirmationBroker {
  /** broker 实例 id —— 审计血缘真相源 */
  readonly id: string;
  // ... 既有方法
}

export interface BrokerSnapshot {
  /** 与 IConfirmationBroker.id 一致 */
  id: string;
  /** 子 broker 才有此字段;主 broker 缺省 */
  parentBrokerId?: string;
  /** 子 broker 才有此字段;主 broker 缺省 */
  sourceAgentId?: string;
  // ... 既有字段
}
```

`ConfirmationBroker` 内部 `emitEvent` 自动把 `brokerId` / `parentBrokerId?` / `sourceAgentId?` 注入所有 6 个事件 payload(主 broker 仅含 `brokerId`,子 broker 必有全三字段)。`snapshot()` 接口同样透传,审计层 / 测试可据此重建"哪个 sub-agent dispatch 派生了哪个 broker、其父是谁"的完整血缘链。**不影响 broker 任何业务逻辑**。

`runChildAgent` 装配 child broker:
```typescript
const budget = resolveSubAgentBudget(opts.budget);   // 全字段完备的 ResolvedSubAgentBudget
childBroker = new ConfirmationBroker({
  parentBrokerId: opts.parentBroker.id,              // RunChildAgentOptions.parentBroker 必填字段
  sourceAgentId: subAgentId,                          // randomUUID() 派生的子 agent UUID
  nonInteractiveResolver: resolveSubAgentResolver(budget.confirmationPolicy),
  // budget.confirmationPolicy 已 fallback DEFAULT_SUB_CONFIRMATION_POLICY,resolveSubAgentResolver
  // 不再持有字面默认值 —— 单一真相源严格收敛在 subagent/budget.ts
});
```

### 8.4 v1 不挂 ConfirmationHub

由于 [ConfirmationHub.attach](../../../packages/server/src/confirmation/hub.ts#L81-L125) INV-H1 限制(同 conversationId 至多一个 broker),v1 子 broker **不**挂 Hub。RPC 推送 / 远程 UI 路由对子 agent 不需要(子无 UI)。

v2+ 若引入 `inherit-or-prompt` 策略需要把子 confirmation 弹回父用户,再设计:可能需要 Hub 加 `agentLineage` 维度的多 broker per conversation 索引。届时单独 spec。

### 8.5 与业界对比

| 维度 | 我们 | Claude Code | OpenClaw | Hermes |
|---|---|---|---|---|
| 父子 broker 关系 | 共享 PermissionStore + child broker auto-deny | toolPermissionContext 派生 + 强制 avoid prompt | 全局 broker 不分父子 | TLS / ContextVar |
| inherit 实现 | PermissionStore.match() 自动命中(规则真相源) | 派生 mode + auto bubble | 弹父用户 UI(同 process) | TLS auto-deny |
| 审计血缘 | parentBrokerId / sourceAgentId 元信息 | 无 | 无 | 无 |
| 默认未匹配规则行为 | broker `failToDenyResolver` 兜底 deny | mode 派生 / fallback to user | 弹父用户 | TLS auto-deny |

我们的优势:**复用既有 PermissionStore 单一真相源**,不引入"子 broker 自己查父 snapshot"的脆弱机制。

---

## 9. 错误语义

### 9.1 三类错误源

1. **子 LLM 调用失败**(network / provider / context overflow)→ `status: "failed"`,`error.type` 标识
2. **子工具调用失败**(tool throw)→ 进子 conversation 的 tool_result.is_error,子 LLM 决定后续(可能 retry / 报告);若子 LLM 自己 unhandled,泡到 runChildAgent → `status: "failed"`
3. **abort**(idle-timeout / parent-abort / external)→ `status: "aborted"`,`abortReason` 携带

### 9.2 子 fail 不反向 abort 父(INV-S4)

子失败 / 中止 / 超时 → **父继续运行**,失败包成 `tool_result.is_error: true` 由父 LLM 看到。父 LLM system prompt 已硬要求"必须 surface 失败"(§6.4)。

### 9.3 partial-result 复用

子中止 / 失败时若已生成部分 assistant 文本,**作为 `result.partial` 返回**。Task 工具据此把 partial 拼到 `tool_result` 文本(见 §4.3)。

业界对比:
- Claude Code 同步路径有 `finalizeAgentTool` 提取 partial(强,我们对齐)
- OpenClaw `subagent-announce.ts:findings` 字段从 transcript 抓最后 assistant message(同语义)
- Hermes 失败只 status 不 partial(弱)

### 9.4 4 种失败语义分级(草稿 12 关键点 #12)

| 失败类型 | v1 是否处理 | 协议 |
|---|---|---|
| 单 agent 失败(子 fail / abort) | ✅ | §9.2 + tool_result.is_error |
| 串行链断("先 A 后 B,A 挂了") | ❌ v1 不处理 | 主 agent 多次 Task 退化模式自然处理 |
| 并行某分支挂(3 个 Task 中 1 挂) | ✅ | §9.5 |
| workflow 撤销 | ❌ v1 不处理 | WorkflowTask 是 v2+ |

### 9.5 并行子 agent 部分失败的聚合策略

主 agent 一个 turn 派 N 个 Task,M2.5 dispatcher 启用 `Promise.allSettled`:

```typescript
const results = await Promise.allSettled(
  toolUses.map((tu) => executeOne(tu)),
);
// 每个 tool_use 都拿到独立 tool_result,不会因为某个挂掉影响其他
```

主 LLM 在下一轮看到 N 份 tool_result(混合 success / is_error),按 system prompt 要求 surface 失败 + 综合成功结果。

**为什么用 `allSettled` 而不是 `all`**:`Promise.all` 任一失败立即 reject 留 unhandled,违反"主 LLM 看到完整 tool_result 集"的契约。

---

## 10. Abort 级联

### 10.1 父 → 子(`createInterruptController` 链 — 全部内部自动)

```
父 runtime.run() 入口:createInterruptController({ parent: params.abortSignal })
  → 父 controller.signal
       │
       ▼ (透传给 ctx.abortSignal)
       │
       ▼
Task.call(input, ctx) → runChildAgent({ parentSignal: ctx.abortSignal, ... })
       │
       ▼
runSubAgentLoop({ parentSignal, ... })
       │
       ▼
runAgentLoop({ parentSignal, ... })
  → 内部 createInterruptController({ parent: parentSignal })
       │
       ▼ child controller.signal(loop 内部使用,外部 runChildAgent 不可见)
```

父 abort(用户 Esc / RPC abort / scheduler shutdown / connection close)→ 父 signal 触发 → `createInterruptController({ parent })` 通过 `forkController` 自动 propagate 到 child signal(自动注入 `{ kind: "parent-abort", parentReason }`)→ child loop 退出 → `runAgentLoop` 返回 `AgentResult.aborted` 含 `abortReason` → `runSubAgentLoop` 透传 → `runChildAgent` 返回 `status: "aborted"`,`abortReason` 全程 typed 不丢。

**关键**:
- 无需 orchestrator 显式遍历子 list
- 无需 runChildAgent 手工 forkController(loop 内部已做)
- `parentSignal` 链通过 AbortSignal 自动级联,**业界三家手工 cascadeKill / `_active_children` 遍历的 first-class 替代**

### 10.2 子 → 父(单向不反向)

INV-S4 已写明:子 abort / fail / 超时 **不**反向 abort 父。父 LLM 看 tool_result.is_error 自决。

### 10.3 父 → 多个并行子

父一个 turn 派 N 个 Task → N 个 runAgentLoop 各自内部 `createInterruptController({ parent: parentSignal })` 派生独立 child controller → 父 abort 一次 → N 个 child signal 通过 forkController 链同步 abort,所有 child loop 级联 stop。

**时序保证**:`Promise.allSettled` 等所有子 finalize(包括 abort 后 cleanup),父 turn 才 commit。

### 10.4 与业界对比

| 机制 | 我们 | Claude Code | OpenClaw | Hermes |
|---|---|---|---|---|
| 父→子 cascade 协议 | `parentSignal` 链(loop 内部自动 fork)+ typed `parent-abort` kind | shareAbortController flag | 必须显式 cascadeKill | 父 interrupt 末尾遍历 _active_children |
| typed reason 透传 | ✅(parent-abort.parentReason) | ❌ | ❌ | ❌ |
| 异步子默认行为 | n/a v1;Step 22 设计为独立 controller | 异步独立(不 link 父) | 默认独立(不 cascade) | 默认级联 |
| partial 保留 | ✅(`result.partial`) | ✅(同步路径 finalizeAgentTool) | ✅(announce findings) | ❌ |

---

## 11. 流式可见性与 UX

### 11.1 hierarchical EventBus 是数据底座

子 agent 所有内部事件通过 child bus emit,自动:
- 携带 `meta.lineage: "main/sub-<id>"`(listener 第二可选参,**不**注入 payload)
- 冒泡到父 bus(再冒泡到 root bus,如有)

任何 channel adapter / renderer 订阅 root bus 即收到所有事件,在 listener 第二参中读 `meta.lineage` 过滤展示。

### 11.2 CLI 状态条(v1 必做)

**位置**:核心订阅器 [packages/cli/src/sub-agent-status.ts](../../../packages/cli/src/sub-agent-status.ts);装载入口 [packages/cli/src/render.ts](../../../packages/cli/src/render.ts) 的 `createRenderSubscribers`;主 / 状态条两路渲染策略表 [packages/cli/src/tool-render-strategy.ts](../../../packages/cli/src/tool-render-strategy.ts)。详见 §15 M2.4 已落地清单与 §17 anchor table。

订阅入口(`createRenderSubscribers` 内并列装载,与 `setupInterruptRendering` 形状对齐):

```typescript
import { setupSubAgentStatus } from "./sub-agent-status.js";

// 在 createRenderSubscribers(renderer) 装饰器内:
const handle = setupSubAgentStatus(bus, pauseUI);
// handle.dispose() 在 run 结束 finally 释放 listener,避免跨 run 累积
```

订阅器内部按 listener 第二参 `meta.lineage` 区分:
- `meta.lineage === "main"` + 工具名命中策略表 `sub-agent-status` → 起一个新 Task 状态条
- `meta.lineage` 以 `"main/sub-"` 开头 → 关联到当前 Task,刷新最近子工具进度
- `agent:run_end` 兜底重置(异常退出 / Task 未自然收尾)

显示格式(TTY 模式 `\r` 单行原地刷新,只显示**最近一个**子工具,避免视觉堆叠):

```
  ⌬ [Task#1: 调研竞品功能] 启动子 agent...           ← Task 起始整行(\n)
  ⌬ [Task#1: 调研竞品功能] read foo.md ...           ← 子工具 in-flight,\r 刷新
  ⌬ [Task#1: 调研竞品功能] read foo.md ✓ 12ms       ← 子工具完成,\r 刷新行尾追加状态 + 耗时
  ⌬ [Task#1: 调研竞品功能] grep "feature" ...        ← 下一个子工具,\r 覆盖上一行
  ⌬ [Task#1: 调研竞品功能] ✓ 5.2s                    ← Task 收尾整行(\n),收尾 = ✓/✗ + 总耗时
```

- "Task#N: <description>" — N 是本 run 内累积顺序号(跨 turn 持续),description 是 Task 工具 `input.description`(超 30 字符截断带 …);description 缺失兜底 `(unnamed task)`
- 子工具中间帧 `\r` 单行刷新最近工具:`<name> [path/cmd/pattern]` + `... → ✓/✗ <duration>ms`
- Task 收尾帧 `\n` 整行输出:`✓ <total>s`(成功)/ `✗ <total>s`(失败);失败的 `<error type>` 不进状态条(信息走 EventBus / Task 工具 `tool_result.content` 的 `<usage>` trailer,避免单行视觉爆炸)
- `Esc` 杀整 turn(主中断协议已具备)→ 所有子级联停 → `agent:run_end` 兜底重置状态条

**非 TTY 模式(CI / pipe / 重定向 / serve daemon 日志)**:Task 起止帧仍各打整行,中间子工具事件 stdout 静默(可观测性走 EventBus 直采,避免日志爆炸)

**默认不显示**:
- 子内部 LLM 流式 token(避免视觉混乱)
- 子工具的详细 input 全文(`read/write/bash/grep/glob` 显示截断的关键参数,其他工具只显示名)

### 11.3 RPC stream-json(v1 必做,自动)

EventBus 事件携带 `meta.lineage`,RPC bridge 透传所有事件 + envelope 派生 `lineage` 字段 → IDE / web client 自决渲染。

### 11.4 飞书 channel(v1 默认事件流)

inbound-router 不 forward EventBus 流(飞书是 non-streaming channel)。子流不在飞书呈现中间步骤 —— 飞书只在父 turn 完成时呈现最终结果(主综合后的 final assistant text)。

V2+ 若需"飞书侧子进度卡片",另起 channel 适配规格。

### 11.5 daemon 重启

由于子**不持久化**(INV-S1),daemon 重启场景极简:
- 若父 turn 正在跑(含子内部执行),daemon 死 → 父 turn 没 commit → transcript 不变 → 重启后回到上一个完整主 turn,等用户重发指令
- 没有孤儿子 turn 概念
- 没有恢复协议

---

## 12. Token / 成本归属

### 12.1 v1 简化策略(决定 #7)

主 Turn.usage = **主 LLM 用量**(沿用现有 agent-loop 实现)。子 LLM 用量**不进** Turn.usage。

理由:
- Turn schema 不动 → 零迁移
- 子 usage 仍可见(EventBus 事件 + Task 工具 tool_result 文本的 `<usage>` trailer)
- v1 个人助手用户对"精确成本归属"需求弱;运行时观测(EventBus + CLI 状态条)足够

### 12.2 子 usage 的多通道可见性

```
sub LLM 调用完成
  → child agent loop emit "llm:request_end" with usage payload
  → 通过 hierarchical EventBus 自动冒泡到 parent bus
  → CLI render 订阅,在子状态条上显示 token count
  → RPC bridge 透传给 IDE
  → run-agent.ts 主 run 的 EventBus 也收到(meta.lineage 含 "/sub-"),
     可选:聚合到 per-run 总 usage 供 spinner 显示(不持久化)

sub agent finalize
  → ChildAgentResult.usage 包含子总 usage
  → Task 工具 tool_result.content 末尾 <usage>tokens: N, ...</usage>
  → LLM 看见;同时主 turn.toolCalls[].result 包含此文本(随 transcript 持久化)
```

**`/usage` 命令**(`packages/cli/src/` —— ✅ 已落地):
- 主 Turn.usage 段保持既有(`renderUsageReport` 主体)
- 子 Task 拆分段([packages/cli/src/parse-task-usage.ts](../../../packages/cli/src/parse-task-usage.ts)):`parseTaskUsageFromMessages(messages)` 纯函数扫 transcript 配对 Task tool_use ↔ tool_result,正则提取 `<usage>` trailer + 推断 succeeded/failed/aborted 状态;[packages/cli/src/render.ts](../../../packages/cli/src/render.ts) 的 `renderSubAgentUsageSection` 在主段后追加渲染(无 Task 调用时跳过,向后兼容)
- 解析层 best-effort(format 不匹配的 entry 跳过不抛),trailer 协议契约由 [orchestrator/src/tools/task.ts](../../../packages/orchestrator/src/tools/task.ts) 的 `formatUsageTag` 单测守护(单一真相源)

实际呈现示例(主 5.1K + 3 个 Task 子调研):

```
  Token 用量
  ─────────────────────────────
  上下文容量     4%  (5.1K / 130K)
  上下文窗口     200K
  会话轮次       3 轮
  ─────────────────────────────
  子 agent 拆分 (3 个 Task)
  + Task#1 (调研模块结构)            ✓ 35.4K  (5 tool_uses, 8.00s)
  + Task#2 (查 API)                  ⚠ 12.3K  (failed)
  + Task#3 (总结实现要点)            ✓ 7.4K   (1 tool_use, 2.10s)
  ─────────────────────────────
  Sum            55.1K (子总计,best-effort 解析)
```

### 12.3 v2+ 演进

若需"精确成本会计"(企业用户),v2+ 引入 `Turn.subUsages?: Array<{ subAgentId, usage }>` 字段,主 turn commit 时包含。届时 schema 扩展是 additive,与本规格无矛盾。

### 12.4 与业界对比

| 维度 | 我们 | Claude Code | OpenClaw | Hermes |
|---|---|---|---|---|
| 子 usage 持久化 | v1 仅 `<usage>` text,v2+ 可选 sub-usages 数组 | tool_result `<usage>` 文本 + setResponseLength 父 spinner | sessionFile JSONL 各 message 后 usage | child.cost 抓快照,父 += 折回 |
| 双写 | ❌ 单源(EventBus 实时 + tool_result text;无 metadata 字段) | 双(metrics + tool_result text) | 双(per-message + 累计) | 单 |
| 父子拆分呈现 | `/usage` 解析 toolCalls text | UI 不区分,SDK 拆 | 按 sessionFile 物理拆 | 用户不可见 |

---

## 13. UX 三端(channel-agnostic)

| 端 | v1 呈现 | v1 控制 | 实现 |
|---|---|---|---|
| **CLI** | 状态条:Task#N 进度 + 失败图标(§11.2) | Esc 杀整 turn(级联) | M2.4(状态条扩展);Esc 已具备 |
| **飞书** | 走默认事件流(不专门渲染子) | 关键词("停"/"取消")已具备 | 无新代码 |
| **RPC** | 全流式事件透传(envelope 携 `lineage`,从 EventBus meta 派生) | client UI 自决 | EventBus 自动支持 |

**架构原则**:所有 channel 收到同一份 EventBus 事件,呈现各自决定,实现不能 channel-couple。CLI 优先做对,作为模板。

---

## 14. 测试拓扑

### 14.1 单元测试

| 模块 | 单测覆盖 |
|---|---|
| `runAgentLoop({ parentSignal })` 父子 abort 隔离 | 父 abort → loop 内部 controller.signal 触发 + AgentResult.aborted.abortReason={kind:"parent-abort"};loop 内部 abort 不影响父 signal |
| `tools.filter(t => t.subAgentSafe === true)` | 8 个 builtin 过滤后符合 §3.5 表 |
| `mainProfile()` / `subAgentProfile()` 渲染 | 主 profile 渲染 byte-equal 旧 buildIdentity;sub profile 含 4 句话 + task 段 |
| `buildSystemPrompt({ segments })` | 主 segments byte-equal 旧 buildSystemPrompt;子 segments 不含 scope/memory/examples |
| `createEventBus({ parent, lineage })` | listener 第二参 meta 含 lineage;父 listener 同样收到 meta;payload 类型零污染;INV-S5 前缀校验 |
| `runContextStorage`(ALS) | runtime.run() 内部包裹 → Task closure `getStore()` 拿 per-run bus/lineage;嵌套 sub agent ALS 自动隔离 |
| `runSubAgentLoop` 单测 | secureExecuteTool 包装正确(共享 pipeline + 子 broker);drainAgentLoop 收集 messages 与 toolUseCount |
| `runChildAgent` happy path | profile 装配 / lineage 派生 / cleanup 在 finally(无 child controller 引用) |
| `runChildAgent` failure path | LLM throw → status=failed,partial 抓取 |
| `runChildAgent` abort path | parent abort → status=aborted,abortReason.kind="parent-abort";cleanup 仍执行 |
| `runChildAgent` cleanup discipline | finally 块即使 happy path 也执行 childBus.removeAllListeners / childBroker.cancelAll |
| `formatChildResultAsToolResult` | 三态文本格式精确(snapshot test) |
| `extractFinalAssistantText` / `extractPartialText` | 多种 messages 形态(只 user / 只 tool / 混合 / 中途 abort)按 §6.5 规则抽取 |
| `resolveSubAgentResolver` | `SubAgentConfirmationPolicy` 全集字面值都映射到对应 resolver(`exhaustivePolicyList` 编译期 exhaustive 锁强制新增 policy 时同步更新) |

### 14.2 集成测试

| 集成场景 | 覆盖 |
|---|---|
| Task 工具端到端(单 Task) | 主 → Task → 子 → tool_result 回主;transcript 只含主 turn,toolCalls 含 Task 记录 |
| Task 工具端到端(并发 3 个) | 3 个并发 all settled;主 LLM 看到 3 份 tool_result;transcript 只含主 turn |
| 父 abort 级联 | 主 turn 跑 3 个 Task,触发 abort → 所有 sub status=aborted,parent-abort kind |
| 子 fail 不反向 abort 父 | 1 个 Task 子 LLM throw → tool_result is_error;主 agent 继续完成 turn |
| Confirmation 父 alwaysAllow 命中 | 父批 `Edit /tmp` allow-session;子调 `Edit /tmp` 自动通过(规则匹配,broker 不参与) |
| Confirmation 子未匹配规则 | 默认 inherit-or-deny → 子调 `Edit ~/.ssh/id_rsa` 走 broker → failToDenyResolver → deny |
| EventBus lineage 冒泡 | 父 listener 收到 3 个子事件,`meta.lineage` 字段正确;payload 类型不被污染 |
| 主 LLM 上下文不被子串扰 | 主 agent 第二轮 run 时 messages 不含子的 synthetic Begin 或子 assistant content |

### 14.3 E2E 测试(M2.7)

| E2E 场景 | 覆盖 |
|---|---|
| CLI 真实派 3 个 Task | 用户输入"对比 A/B/C 库",主派 3 Task → 综合 → 输出 |
| 飞书远程 abort 子 turn | 用户在飞书发"取消",in-flight turn(含子)级联停;反馈"已停止" |
| RPC stream-json 透传 lineage | RPC client 订阅 events,envelope 含 lineage,sub 事件 lineage 含 `/sub-` |
| daemon 重启 in-flight 子 | 模拟 kill -9 daemon 中断 in-flight 子 turn → 重启后 transcript 完整(主 turn 未 commit,子状态全无,无 orphan) |

### 14.4 平台测试

| 平台 | 覆盖 |
|---|---|
| Windows | path normalization 在子 Read/Glob 路径正确;abort signal cross-event-loop |
| Unix | SIGTERM / SIGINT 触发 cleanup 链 |

### 14.5 性能基准

| 指标 | 期望 |
|---|---|
| 单子 spawn overhead | < 50ms(从 Task.call 到 child loop 第一次 LLM call) |
| 3 个 Task 并发的实际并行度 | LLM call 真正 overlap(可观测时间为 max(单 Task 时间) + small overhead,而非 sum) |

---

## 15. 渐进式实现计划

每个里程碑独立可验证,失败可回滚。

### M0 — spec 锁定 + 元信息盘点

**目标**:本规格定稿评审通过 + 不影响业务的元信息落地。

**交付**:
1. **本文档评审**——1-2 轮架构评审,关键决策达成共识
2. **`isParallelSafe` 真伪盘点(实测)**——按 §3.5 末段验证 8 个 builtin 工具的并发安全性,M2.5 改造前必须有此盘点
3. **`mainProfile().instructions` 文本来源确定**——从 cli/system-prompt.ts buildIdentity 静态文本 verbatim 准备好,M1.6 直接复制

**验证**:评审通过 / spec 文档 merge / `isParallelSafe` 盘点报告

**独立性**:M0 完全无业务行为变更,可单独 merge

### M1 — orchestrator 包 + 跨包重构 + 数据结构扩展

**目标**:`@zhixing/orchestrator` 包落地 + 现有 runtime 跨包搬家 + EventBus / ToolDefinition 扩字段;**零业务功能变化**。

| 子 ms | 内容 | 验证 |
|---|---|---|
| M1.1 | 建 `packages/orchestrator/` 包骨架 | `pnpm build` 通过;空 export |
| **M1.2a** | runtime 级模块从 cli 下沉:`secure-executor`(**先删 legacy prompt path** 再搬,详见 §2.4)/ `compact-accumulator` / `compaction-llm` / `project-context` / `system-prompt`(雏形)→ orchestrator;`request-builder` → core/confirmation。cli 现有 import 改路径 | 每模块独立 commit;secure-executor 删 legacy 后无 cli UI 依赖;cli + server + RPC e2e 全绿 |
| **M1.2b** | `createAgentRuntime` 主体 + `AgentRuntime` 接口从 cli 搬到 orchestrator;cli/run-agent.ts 改 re-export 主流程 | cli + server e2e 全绿;包依赖图 `orchestrator → cli` 仍有(render 订阅尚未解耦,M1.2c 处理) |
| **M1.2c** | `decorateRunBus?: (ctx: RunBusContext) => () => void` 钩子加入 `CreateAgentRuntimeOptions`(`RunBusContext = { bus }`,UI 概念严禁入字段);`runtime.run()` 内调用钩子 + finally dispose;cli 入口通过 `createRenderSubscribers(renderer)` 工厂闭包持有 renderer 后注入;run-agent.ts run() 内的 7 处直接 `eventBus.on` 订阅全部移出 | 包依赖图 acyclic(`orchestrator → cli` 反向依赖归零) |
| M1.3 | `cli/serve/session-adapter.ts` 改 `import "@zhixing/orchestrator/runtime"` 替代 `import "../run-agent"`,断 `cli ← server` 反向依赖(`@zhixing/server` 自身仅依赖 `@zhixing/core`,通过 `RuntimeFactory` 抽象解耦) | 包依赖图严格 acyclic |
| M1.4 | `EventBus` 扩 hierarchical(`parent` + `lineage`)+ listener `meta` 第二参 | 既有 callsite 零改动(snapshot test);INV-S5 校验 |
| M1.5 | `ToolDefinition.subAgentSafe` 字段 + 8 个 builtin 声明 | 过滤函数测试 |
| M1.6 | `AgentRoleProfile` + `mainProfile()` + `subAgentProfile()` + `renderIdentity` + `buildSystemPrompt` 多段重构(基于 M1.2a 的 system-prompt 雏形);抽出 `trackMessages` helper 到 orchestrator/runtime/track-messages.ts(internal,见 M1.7) | 主 agent system prompt byte-equal 旧实现(snapshot test) |
| **M1.7** | API 治理收尾:`runtime/index.ts` barrel 仅暴露真公共 API(`createAgentRuntime` + 7 类型 / `buildSystemPrompt` 系列 / `EnrichOptions`),8 个 internal helper(`subscribeCompactAccumulator` / `trackMessages` / `createCompactionFlush` / `loadProjectContext` / `enrichContext` / `injectContext` / `REFLECTION_THRESHOLD` / `ProjectContext`)从 barrel 移除;同包测试用 `import "../X.js"` 直访 sub-module。死代码清退:`enrichContextWithSkills` 等 deprecated stub 一并移除,`@deprecated` 不留长期未清退残留。**生命周期契约测试**入位:`create-agent-runtime.test.ts` 覆盖 lineage="main" / decorateRunBus 1:1 / safeDispose 故障隔离 / per-run 隔离。**`safeDispose(label, fn)` 模块级辅助**抽出,`run()` 与 `forceCompact()` 共用同一防御契约 | 新测试全绿(10+ 用例);顶级 barrel d.ts 表面缩减(衡量公共 API 收紧) |

**M1 完成后**:零业务功能变化,所有现有 e2e 全绿。

### M2 — 子 agent 业务交付

**目标**:Task 工具上线,子 agent 同步并行委托可用,产品兑现"3 并发"。

#### M2.1 — `runChildAgent` 骨架(无 Task 工具接入) ✅ 已完成

- ✅ `packages/orchestrator/src/subagent/factory.ts` 实现 `runChildAgent`(顶层 try/catch 兜底 + 阶段化 try/catch + cleanup discipline)
- ✅ `subAgentProfile()` 默认值早在 M1 阶段已落地
- ✅ 工具函数全部到位:
  - `packages/orchestrator/src/subagent/lineage.ts` — `deriveChildLineage`
  - `packages/orchestrator/src/subagent/abort-format.ts` — `formatAbortReasonForLLM`
  - `packages/orchestrator/src/subagent/result-classifier.ts` — `extractFinalAssistantText` / `extractPartialText` / `classifyResult`
  - `packages/orchestrator/src/subagent/budget.ts` — `SubAgentBudget` 接口 + 默认常量 + `resolveSubAgentBudget`
- ✅ `packages/orchestrator/src/subagent/loop-runner.ts` 薄封装 `runSubAgentLoop`(直接调 `drainAgentLoop`,不走 `createAgentRuntime` 重型封装),处理 wall-clock 超时与子 broker 装配
- ✅ `packages/orchestrator/src/runtime/run-context.ts` 提前落地 `runContextStorage = new AsyncLocalStorage<RunContext>()`(让 factory 代码与 spec 完美对齐,M2.3 加 Task closure 时无需改动 factory)
- ✅ `packages/orchestrator/src/subagent/index.ts` 公共 API barrel + 顶级 `index.ts` re-export + `package.json` `./subagent` sub-path + `tsup.config.ts` entry
- ✅ 单测覆盖:
  - `subagent/__tests__/lineage.test.ts`(派生路径 + 嵌套 + 短 ID)
  - `subagent/__tests__/abort-format.test.ts`(全 `AbortReason.kind` 变体)
  - `subagent/__tests__/result-classifier.test.ts`(空消息 / 多 assistant / 全状态分类矩阵)
  - `subagent/__tests__/budget.test.ts`(默认值 sentinel + 部分覆盖 + 显式 0)
  - `subagent/__tests__/loop-runner.test.ts`(happy / max_turns / provider error / parent abort / wall-clock 超时 fake timers / cleanup 监控 setTimeout/clearTimeout)
  - `subagent/__tests__/factory.test.ts`(三态 + lineage 派生 / `subAgentSafe` 过滤 / cleanup discipline / INV-S6 永不抛兜底验证)

**验证**:`subagent` 模块共 47 个用例全绿;orchestrator 全套 149 个用例全绿;cli + server 跨包 typecheck 全绿;build 产出 `dist/subagent/index.d.ts` 类型声明完整

**独立性**:M2.1 输出是 orchestrator 内部 API,无 LLM-facing 暴露;Task 工具(M2.3)接入后即变 LLM-facing

**与 §6.1 理想态的差异(YAGNI 渐进上线,避免接口债务)**:M2.1 交付的 `RunChildAgentOptions` 不含 `parentBroker` 字段(本阶段无消费方);M2.2 加回 `parentBroker`(必填,作为 audit 血缘真相源),调用方升级时通过 TypeScript 类型错误自动发现。`runSubAgentLoop` 在 M2.1 不作为 `@zhixing/orchestrator/subagent` 公共 API 导出(仅同包 internal 消费);未来如有 background agent 等场景需要细粒度控制,在 `subagent/index.ts` 显式追加导出 + 补完使用文档。`description` 字段不进 `RunChildAgentOptions` —— Task 工具呈现层概念(标签 / 错误格式化),由 Task closure 自持,与子 agent 业务层(任务全文走 `task` 字段进 system prompt)严格解耦,符合单一职责

#### M2.2 — Confirmation 子 broker 元信息 + audit ✅ 已完成

- ✅ `IConfirmationBroker.id` 字段(broker 实例审计血缘起点);`ConfirmationBrokerOptions.{ id?, parentBrokerId?, sourceAgentId? }` 字段
- ✅ `BrokerSnapshot.{ id, parentBrokerId?, sourceAgentId? }` 字段透传(测试与审计场景的稳定接口)
- ✅ `ConfirmationEventMap` 6 个事件 payload 加可选 `brokerId` / `parentBrokerId?` / `sourceAgentId?`,broker 内部 `emitEvent` 自动注入(主 broker 仅含 `brokerId`,子 broker 必有全三字段)
- ✅ `failToAllowResolver`(name="fail-to-allow")新增,`getBuiltinNonInteractiveResolver` 加分支;**生产严禁注入**,**唯一启用路径**是测试代码直接构造 broker(`new ConfirmationBroker({ nonInteractiveResolver: failToAllowResolver })`),**不再通过 sub-agent confirmationPolicy 字符串暴露** —— 类型层面杜绝 misuse(详见 §8.2.2)
- ✅ `SubAgentConfirmationPolicy` 联合类型仅含生产安全字面值(`inherit-or-deny` / `auto-deny`),配置文件 / API caller 不可能通过字符串误传 auto-approve
- ✅ `packages/orchestrator/src/confirmation/child-broker.ts` 实现 `resolveSubAgentResolver(policy)`:
  - 签名 `policy: SubAgentConfirmationPolicy` **必填,无字面默认值** —— 单一真相源 `DEFAULT_SUB_CONFIRMATION_POLICY` 严格收敛在 `subagent/budget.ts`,避免本函数与 budget.ts 各自维护字面 default 导致 silent 行为不一致
  - `inherit-or-deny` / `auto-deny` → `failToDenyResolver`
- ✅ `packages/orchestrator/src/confirmation/index.ts` 公共 API barrel + 顶级 `index.ts` re-export + `package.json` `./confirmation` sub-path + `tsup.config.ts` entry
- ✅ `runChildAgent` `RunChildAgentOptions` 加回 `parentBroker: IConfirmationBroker` 字段(必填,M2.1 临时移除现按 spec 显式破坏性变更引入);装配 child broker 透传 `parentBrokerId: parentBroker.id` / `sourceAgentId: subAgentId` / `nonInteractiveResolver: resolveSubAgentResolver(budget.confirmationPolicy)` —— 用 `resolveSubAgentBudget` 投影后的 ResolvedBudget 字段,**不直接读 `opts.budget?.confirmationPolicy`** 以避免绕过单一真相源
- ✅ 单测 / 集成测覆盖:
  - `core/confirmation/__tests__/broker.test.ts` 加 7 用例(自动 UUID id / 显式 id 注入 / snapshot audit 透传 / 6 事件 payload 含 audit 字段 / 主 broker 不污染父字段 / `failToAllowResolver` 行为)
  - `orchestrator/confirmation/__tests__/child-broker.test.ts`(策略路径 + 必填参数防御 + 安全姿态契约 + broker 集成路径,共 7 用例)
  - `orchestrator/subagent/__tests__/factory.test.ts` 加 4 用例(audit 字段透传 / 缺省 policy → fail-to-deny / `auto-deny` → fail-to-deny)+ 1 个端到端集成用例(子调未注册边界工具 → SecurityPipeline 升级 critical → child broker fail-deny → tool_result.isError → 子 LLM 看到后 reply)
- ✅ child broker 不注入 `eventBus`(与主 broker 装配模式一致);audit 字段验证走 `vi.spyOn(ConfirmationBroker.prototype, 'cancelAll')` 拦截 cleanup 时点的 broker 实例 + `instance.snapshot()`,无需引入"为测试而设的 API 字段"

**验证**:`core` 全套 1883 用例全绿(+7);`orchestrator` 全套 159 用例全绿(+10);cli + server 跨包 typecheck + 全套 491 用例 server vitest 全绿;build 产出 `dist/confirmation/index.d.ts` 完整

**独立性**:M2.2 不依赖 Task 工具,通过 M2.1 的 `runChildAgent` + spy 拦截直接验证装配契约;父子共享 PermissionStore 命中规则的"父 alwaysAllow"集成场景不重复测(M1 已通过 SecurityPipeline 共享单元测试覆盖,子 agent 复用同一 pipeline 实例自动命中)

**audit 字段的当前消费方与未来路径**:M2.2 阶段 child broker 不接 eventBus,audit 字段通过 `snapshot()` 接口暴露,供未来审计工具消费(eventBus 路径 + 自动注入逻辑已就位,后续接入零额外改造)

#### M2.3 — Task 工具实现 ✅ 已完成

- ✅ `packages/orchestrator/src/tools/task.ts` 落地:`createTaskTool(env)` 工厂 + `TaskToolEnv` 接口 + `TASK_INPUT_SCHEMA` + `TASK_TOOL_PROMPT` + `TASK_TOOL_BOUNDARIES`(`process/exec` 静态边界声明,SecurityPipeline 分类锚点)+ `formatChildResultAsToolResult` 三态文本协议(`<usage>` 尾巴 byte-equal)
- ✅ env 持 createAgentRuntime 内部局部变量 capture(`provider / model / llmRoles / securityPipeline / workspace / workspaceSource / globalConfigPath / parentBroker / parentTools`),避免 AgentRuntime forward reference;per-run `bus / lineage` 通过 `runContextStorage.getStore()` 取
- ✅ `runtime.run()` 入口用 `runContextStorage.run({ bus: eventBus, lineage: "main" }, async () => runMainLoop())` 包裹整个 agent loop 主体,让 Task closure 在 `call()` 时能取到 per-run bus / lineage(`disposeAll()` 留在外层 finally 保证清理)
- ✅ `createAgentRuntime` 加 `enableTaskTool?: boolean` 选项(默认 false);开启时:
  - `createTaskTool` 在 `baseTools` 与 `securityPipeline / boundaryRegistry` 装配后调用,产出的 `taskTool` 追加进 `tools` 数组
  - `taskTool.boundaries` 显式注册到 mutable `boundaryRegistry` —— **这一步关键**,省略则 Task 在 fail-closed 默认下被 `BoundaryImpactClassifier` 升级为 `critical`,在非交互模式下被 `PermissionMatcherMiddleware` 默认拒绝
  - `systemPrompt` 用最终 `tools`(含 Task)构建,`buildSubAgentDelegation` 检测到 Task 工具自动渲染 delegation 段
- ✅ 主 agent system prompt 加 `sub-agent-delegation` segment(§6.4):**条件性 segment**(tools 含 Task 才渲染,常量 `SUB_AGENT_DELEGATION_TEXT` byte-equal 导出),不写入 `mainProfile().instructions` —— mainProfile 不变保证无 Task 场景 byte-equal 历史输出
- ✅ `package.json` 加 `./tools` 子路径 + `tsup.config.ts` 加 `src/tools/index.ts` entry + `packages/orchestrator/src/tools/index.ts` barrel + 顶级 `index.ts` re-export
- ✅ 单测覆盖:
  - `tools/__tests__/task.test.ts`(32 用例:`formatChildResultAsToolResult` 三态 + `<usage>` 尾巴 + sub_id 截断 + cache tokens 不暴露(回归保护)+ `TASK_INPUT_SCHEMA` 结构契约 + `TASK_TOOL_PROMPT` 关键句 + `createTaskTool` 元信息 + 契约前置校验集中(ALS 缺失 / `ctx.abortSignal` 缺失 / `description` 空 / `prompt` 空 / `trim()` 接受) + happy path 集成)
  - `runtime/__tests__/system-prompt.test.ts` 加 8 用例(MAIN/SUB segments 集成 + 条件渲染 + byte-equal 锚点 + 段顺序 + 子 agent 安全门)
  - `runtime/__tests__/create-agent-runtime.test.ts` 加 5 用例(ALS 透传契约 + 两个并发 run() 各自 ALS 不串扰 + `enableTaskTool=true` happy path 三轮 LLM 调用 + `enableTaskTool=true` 时 Task `subAgentSafe===false` 防递归不变量 + `enableTaskTool` 默认 false 向后兼容)

**验证**:`orchestrator` 全套 204 用例全绿(M2.2 后 +45);typecheck 全绿;build 产出 `dist/tools/index.d.ts` 完整

**独立性**:M2.3 完成后 Task 工具技术能力 + 装配契约就绪,但**生产入口(cli REPL / cli runOnce / serve 持久会话 / serve ephemeral 共四处)默认 `enableTaskTool: false`** —— 状态条未上线前打开 Task 等于让用户看子 agent 黑盒,UX 不可接受,故工具能力 / 用户可见性 / 生产开关三件作为整体在 M2.4 一次性配套上线(见下条);此外 dispatch 仍串行(M2.5 之前并发不真),"3 并发"产品语义未完全兑现 —— prompt 已引导 LLM "up to 3 Tasks per turn",并发实际兑现等 M2.5 tool-executor 改造

#### M2.4 — CLI 状态条(子可见性) + 生产入口启用 Task ✅ 已完成

- ✅ `packages/cli/src/sub-agent-status.ts` 落地:`setupSubAgentStatus(bus, pauseUI)` EventBus 订阅器,按 `meta.lineage` 把"派发型工具"主调用与子 agent 冒泡事件关联,显示 `[Task#N: <desc>] <最近工具>` 单行状态;Task 起止帧(`writeFrameLine` 整行 + `\n`)与子工具中间帧(`writeStreamLine` `\r` 单行刷新)分通道写 stdout;`pauseUI` 钩子在状态条输出前停 spinner 避免动画覆盖
- ✅ `packages/cli/src/tool-render-strategy.ts` 落地(单一事实源策略表):`ToolRenderStrategy = "default" | "sub-agent-status"` 联合类型 + `TOOL_RENDER_STRATEGY` Readonly 映射(当前 `Task → "sub-agent-status"`)+ `getToolRenderStrategy(name)` 唯一查询入口(未注册兜底 `"default"`)。**关键架构选择**:`tool-executor` 同时产出 `yield tool_start/tool_end`(主路径 `renderer.handleEvent`)与 `emit tool:call_start/end`(EventBus listener),若 Task 工具两路同时渲染则形成 ⟡ 卡片 + 状态条双重视觉混乱;策略表让 `renderer.handleEvent` 与 `setupSubAgentStatus` 共享同一查询入口,任何加表 / 改表两侧自动一致,杜绝两侧硬编码漂移
- ✅ `packages/cli/src/render.ts` 改造:`renderEvent` 在 `tool_start` / `tool_end` 分支查策略表,`getToolRenderStrategy(event.name) !== "default"` 时直接 `break`(不渲染 ⟡ 卡片),让位给专用订阅器;`createRenderSubscribers` 内装载 `setupSubAgentStatus(bus, pauseUI)` 与既有 `setupInterruptRendering` 并列,共享 `pauseUI` 钩子与 `dispose` 路径
- ✅ TTY / 非 TTY 行为差异:TTY 模式 `\r` 单行刷新最近工具进度(spec 要求"只显示最近一个,避免堆叠");非 TTY 模式仅 Task 起止打整行,中间子工具事件 stdout 静默(可观测性走 EventBus 直采,避免 CI / pipe 日志爆炸)。状态机内部仍维护 `currentTask` / `currentSubLineage`(逻辑层不分支,仅输出层 TTY/非 TTY 二选一),保证 Task 收尾路径在两种模式下一致
- ✅ 顺序匹配的"已知退化点":本里程碑落地时 dispatch 仍串行,"首个未关联的 sub-X lineage" 即视为"当前正在跑的 Task#N",匹配精确;后续 M2.5 dispatch 改造为真并发后,多 Task 并发场景下顺序匹配会因 N 个 sub agent 同时启动而 lineage 串扰,UX 退化但**功能不破**(单 Task / N=1 仍精确)。精确归属升级横跨 4 包(详见 §15 M2.5 "已知 trade-off" 段),作为独立工单跟进;模块 JSDoc 显式标注此 trade-off
- ✅ **生产入口启用 Task 工具** —— 四处 `createAgentRuntime({ ..., enableTaskTool: true })` 显式开启:[cli REPL](../../../packages/cli/src/repl.ts#L659) / [cli runOnce](../../../packages/cli/src/run-agent.ts#L56) / [serve 持久会话](../../../packages/cli/src/serve/command.ts#L172) / [serve ephemeral](../../../packages/cli/src/serve/command.ts#L284)。M2.3 完成时仅实现"装配选项 + 测试覆盖",**生产路径默认 false** 是有意为之:状态条未就绪前打开 Task = 用户看子 agent 黑盒(不可接受 UX)。M2.4 一次性收口"工具能力 + 用户可见性 + 生产开关"三件配套上线
- ✅ 单测覆盖(共 +28 用例):
  - `cli/__tests__/sub-agent-status.test.ts`(16 用例:TTY 模式 13 个 `[Task#1: desc]` 起始 / 子工具 \r 刷新 / ✓✗ 状态 / Task 收尾 \n / 跨 Task N 累积 / 顺序匹配 / `agent:run_end` 兜底 / dispose / description 缺失兜底 / 超长截断 / 非 Task 工具不响应;非 TTY 模式 3 个 整行起止 / 中间帧 stdout 零写入 / 收尾不受影响)
  - `cli/__tests__/tool-render-strategy.test.ts`(5 用例:`Task → "sub-agent-status"` / 未注册工具兜底 default / 空串与未来未知工具防御 / `TOOL_RENDER_STRATEGY` byte-equal 锚点 / Readonly 类型契约)
  - `cli/__tests__/render.test.ts` 加 7 用例(`Renderer.handleEvent · 派发型工具不渲染 ⟡ 卡片` 5 个:default `read` 正常 ⟡ / Task `tool_start` stdout 零写入 / Task `tool_end` stdout 零写入 / default 工具 ✓ + 耗时 / 混合序列 read+Task+write 仅 read/write 渲染;`createRenderSubscribers · SubAgentStatus 集成` 2 个:装载后主 Task 事件 stdout 出现 `[Task#1: ...]` / dispose 全清覆盖 SubAgentStatus + InterruptRendering + retry/context 订阅)

**验证**:
- `cli` 全套 437 用例全绿(M2.3 后 +28);`orchestrator` 全套 204 用例全绿(M2.4 不改 orchestrator);`server` 全套 491 用例全绿;cli typecheck 全绿
- 双重渲染回归保护:`render.test.ts · 派发型工具不渲染 ⟡ 卡片` 5 用例锁定"主路径 handleEvent 对 Task 工具完全静默",任何回退到硬编码或漏查策略表的改动都会被这 5 个测试拦截
- 集成连通性:`createRenderSubscribers · SubAgentStatus 集成` 直接验证装载链路,通过 `decorateRunBus` 钩子拿到 per-run bus,断言事件流出现 `tool:call_start { name: "Task" }` 后状态条 stdout 出现 `[Task#1: ...]` 输出
- system prompt 含 Task 工具 / `Sub-Agent Delegation` 段的 byte-equal 锚点已由 `system-prompt.test.ts` 8 用例覆盖,本里程碑无需重复

**独立性**:渲染改造与生产开关绑定一起上线 —— 两者解耦无意义(打开开关无渲染 = 黑盒 / 渲染就绪不开开关 = 无内容);策略表设计让未来加新派发型工具(如 BackgroundTask)只需在 `TOOL_RENDER_STRATEGY` 注册 + 写新订阅器接管,`renderer.handleEvent` 主路径零改动

#### M2.5 — Tool dispatcher 并发改造(决定 #9 兑现) ✅ 已完成

- ✅ [packages/core/src/loop/tool-executor.ts](../../../packages/core/src/loop/tool-executor.ts) 改造:抽出 `runSerialBatch`(私有)+ `runParallelBatch`(私有)两层 generator,主函数 `executeToolCalls` 仅做分组判断 + 委托
- ✅ 分组策略 `canRunParallel`:N≥2 且 `toolCalls` 全部命中已注册工具且 `isParallelSafe===true` → 并发分支;否则(N=1 / 含 unsafe / 含未注册工具)回退串行(完全保留现有 yield/event/abort 协议)。**关键架构选择**:不做"局部并发分组"(如 [safe,unsafe,safe] 拆 [safe]‖[unsafe]‖[safe])—— 顺序读写依赖难静态推断(Edit 后的 Read 必须看到新内容),实现复杂度爆炸,价值有限;v1 简单优先,任一 unsafe 整批回退串行
- ✅ 并发分支 yield/event 协议:`tool_start` 同步全发(N 个,顺序 = 输入顺序,批次启动可见性给状态条 / RPC 订阅者)→ `Promise.allSettled` 等齐 → 按输入顺序遍历 settled,fulfilled / 非 abort error 立即 yield `tool_end` + emit `tool:call_end` + 累积 results;abort reject 进 `unexecutedToolUses` 不 yield(由 cleanup 在末尾统一 yield placeholder,与串行模式同款)
- ✅ **tool_result 顺序契约的精确边界**:
  - 非 abort 路径(完整 turn / 单工具 throw 但 batch 整体跑完):严格按 tool_use 输入顺序 → user message 与串行模式 byte-equal
  - abort 中途 + 工具响应不一致(部分 fulfilled 部分 reject AbortError)的混合路径:fulfilled 按输入顺序 yield 在前,abort placeholder 按 `unexecutedToolUses` 顺序在末尾追加 → user message 顺序 = 输入顺序的"fulfilled 子集 ++ abort 子集",**不严格 byte-equal 串行模式**
  - 协议合规性:Anthropic / OpenAI provider 按 `tool_use_id` / `tool_call_id` 匹配 tool_result,顺序无关 → API 不会报 400,LLM 推理对乱序 tool_result robust(transcript rebuild 同样按 ID 匹配,持久化无回归)
  - 实际触发概率:Task 工具内部 parentSignal 链自动级联,abort 时几乎全 reject(顺序不变);Read/Glob/Grep 几乎都同步 fulfilled,reject 极罕见 → 产品现实场景几乎不出现混合形态
  - 强行重排(让 cleanup 按 toolCalls 输入顺序合并 results + placeholder)需改 cleanup 跨模块边界,且无产品收益,故有意保留当前简洁实现
- ✅ 并发分支 abort 路径:入口 abort guard(已 aborted → 不发 tool_start,全部进 unexecutedToolUses,与串行循环顶 guard 等价但批次粒度);`allSettled` 等齐后,fulfilled 进 `completedResults` + yield `tool_end`,rejected 且 `abortSignal.aborted` 进 `unexecutedToolUses` 不 yield(与串行 catch 块 abort 同语义,由 cleanup 注唯一 placeholder,防双 result 进 user message → API 400);非 abort throw 转 isError tool_result(C6 错误隔离)
- ✅ `abortedDuringToolAt`:并发模式记 `Promise.allSettled` 等齐时刻作"整批退出时刻"代理(语义 ≈ max(所有工具响应 abort 退出时刻),与串行 per-tool 时刻贴近,SLO 监控 toolGraceMs 算法不变)
- ✅ 共享 ctx:并发模式 N 工具共享同一 `ToolExecutionContext` 实例(workingDirectory / abortSignal / llm 三字段不应被工具 mutate,与串行 per-call new 等价的引用语义)
- ✅ 8 个 builtin 工具的 `isParallelSafe` 已在 M0 盘点对齐:`Read / Glob / Grep / WebFetch` = `true`(只读无副作用),`Edit / Write / Bash / Memory / Schedule` = `false`(写共享存储 / 同 path / 共享 cwd 有 race);`Task` 工具(orchestrator 包内)= `true`(子 agent LLM I/O bound 独立)
- ✅ 单测覆盖(共 +9 用例,核心 18 用例分串行 / 并发两段):
  - `core/loop/__tests__/tool-executor.test.ts · executeToolCalls · 并发模式`(8 用例:happy 三 yield 顺序 / isError 隔离 + 完整 result 集 / 入口 abort guard 不发 tool_start / 批次进行中 abort fulfilled-vs-reject 路径分流 + abortedDuringToolAt 有值 / 含 unsafe 回退串行 + 调用顺序断言 / N=1 回退串行 / 含未注册工具回退串行 / 并行实证 3 工具 50ms × 3 总耗时 < 120ms / ctx 透传 N 工具同源引用)
  - 同文件 `executeToolCalls · abort 路径` 段已有 6 用例显式 `isParallelSafe=false` 锁定串行路径(此前测试隐式假设串行,M2.5 改造后显式声明让边界归属清晰,且并发路径的 abort 行为另由专属段独立验证)
  - `core/loop/__tests__/agent-loop.test.ts · Tool 阶段 abort(串行路径)` 同款显式 `isParallelSafe: false` 锁串行,跨层 cleanup placeholder 协议不变

**验证**:`core` 全套 1892 用例全绿(M2.4 后 +9);`orchestrator` 204 用例全绿(M2.5 不改 orchestrator);`tool-executor.test.ts · 并发实证`用例锁定 3 个 50ms 工具并发后 elapsed < 120ms(串行需 ≥150ms),性能基准断言锚定在单元测试层避免 e2e 抖动

**独立性**:dispatch 改造对单工具(N=1)/ 含 unsafe / 含未注册工具完全回退串行,行为零差异 —— 现有 9 个 builtin 工具中 4 个 safe 5 个 unsafe,主 LLM 同 turn 派多 unsafe 工具(如 N 个 Edit)自动走串行不破坏既有契约;仅同 turn 派多 safe 工具(如 N 个 Task / N 个 Read)才进入并发分支兑现"3 并发"产品语义

**已知 trade-off(随后续工单升级,不阻塞 M2.5)**:CLI 状态条 [packages/cli/src/sub-agent-status.ts](../../../packages/cli/src/sub-agent-status.ts) 当前用"首个未关联的 sub-X lineage 即当前 Task" 顺序匹配建立 sub_agent_id ↔ Task#N 关联,在并发派多 Task(N≥2)场景下会因 N 个 sub agent 几乎同时启动而 lineage 串扰,导致状态条 UX 退化(单 Task / N=1 完全不变)。**精确归属升级**横跨 4 包:`ToolExecutionContext.toolCallId`(core)+ Task 工具 emit 关联事件(orchestrator)+ `runChildAgent` reserve subAgentId(orchestrator)+ 状态机重写 `currentTask` 为 `Map<toolCallId, TaskState>`(cli),与 dispatch 改造无强耦合,作为独立工单跟进,sub-agent-status.ts JSDoc 已显式标注此演进路径

#### M2.6 — token / budget 软上限 ✅ 已完成

- ✅ `BudgetExceededKind = "max_turns" | "max_tokens" | "wall_clock"` 统一建模三类软上限触发([packages/orchestrator/src/subagent/budget.ts](../../../packages/orchestrator/src/subagent/budget.ts)),classifier 看 kind 优先于 reason 折成 status="failed",deriveErrorMeta 一处映射 error.type,新增 budget kind 时只改一处 —— 替代 v1 的 `budgetExceeded?: boolean` 二元字段(无法区分种类)
- ✅ `maxTokens` 软上限触发([packages/orchestrator/src/subagent/loop-runner.ts](../../../packages/orchestrator/src/subagent/loop-runner.ts)):loop-runner 监听子 EventBus 的 `llm:request_end`,每次累加 `inputTokens + outputTokens`(cache 字段不计 —— budget 监控的是实际消耗,prompt cache 命中不算钱),累计超 `maxTokens` 时 `abortWithReason(maxTokensController, { kind:"external", origin:"subagent-max-tokens-exceeded" })`(graceful,不 mid-call kill);用 `AbortSignal.any([wallClock, maxTokens])` 合成单一 signal 透传给 `runAgentLoop` 的 `abortSignal` 入参(Node ≥22 稳定 API,本仓库 `engines.node:">=22.0.0"` 已锁);单一 first-wins 槽位 `abortBudgetKind` 在 trigger 现场记录"哪个 budget kind 先抢占"(`if (slot === null) slot = kind`),drain 后 `deriveBudgetExceededKind()` 直接给出结构化 kind —— 不依赖 `abortReason.origin` 字符串解析,跨模块边界结构化更鲁棒
- ✅ `wallClockTimeoutMs` 折叠对齐 spec §7.3 软上限协议(同款 budget kind 通道):wallClock setTimeout 触发后 first-wins 入槽 `abortBudgetKind="wall_clock"` + abort,drain 后由 `deriveBudgetExceededKind` 直接给出 kind → status="failed" + error.type="wall_clock_timeout";v1 实现折成 aborted 是 spec/code 不一致,本里程碑一并消除该架构债务,与 maxTokens 同款语义("软上限触发 = failed")
- ✅ `first-wins 槽位语义`([packages/orchestrator/src/subagent/loop-runner.ts](../../../packages/orchestrator/src/subagent/loop-runner.ts)):wallClock / maxTokens 两路 abort 通道触发用单一 `abortBudgetKind: "max_tokens" | "wall_clock" | null` 槽位,在 trigger 现场 `if (abortBudgetKind === null) abortBudgetKind = kind` 表达"先到先得",与 AbortController first-wins 完全对齐 —— 替代 v1 的"两个独立 boolean flag + 后置静态优先级判断"(后者在罕见 race 场景中,wallClock 先抢占 abort signal 但 token 后到的 listener 会让 budgetExceededKind 错误返回 max_tokens,与 abortReason.origin 不一致);槽位 first-wins 让 abort signal 与 budgetExceededKind 同源同向,跨模块边界无双通道歧义;`deriveBudgetExceededKind(reason, abortBudgetKind)` 简化为线性折叠规则(reason="max_turns" → "max_turns";reason="aborted" + 槽位非空 → 槽位值;其他 → undefined),无优先级判断,@internal export 给纯函数 unit test 锁真值表
- ✅ `usageListener` 类型契约绑定 ← 用 `AgentEventMap["llm:request_end"]` 直接 deref EventMap 而非手写 inline type duplicate —— EventBus 契约演进(新增 usage 子字段等)由 TypeScript 强制可见,消除 listener 类型与 EventMap 脱钩的代码债务
- ✅ `classifyResult` ([packages/orchestrator/src/subagent/result-classifier.ts](../../../packages/orchestrator/src/subagent/result-classifier.ts)) 加 `budgetExceededKind` 优先分支 —— 存在即 failed,与 reason 字段无关(max_tokens / wall_clock 走 abort 通道但语义 failed);真正的 abort(parent-abort / idle-timeout / user-cancel)走 reason="aborted" 通道折成 aborted,kind/reason 双通道清晰区分"资源耗尽"与"被中断"
- ✅ `deriveErrorMeta` ([packages/orchestrator/src/subagent/factory.ts](../../../packages/orchestrator/src/subagent/factory.ts)) 加三种 budget kind 映射:`max_turns_exceeded` / `max_tokens_exceeded` / `wall_clock_timeout`,主 LLM 看到 `tool_result.is_error: true` + 文本含 `[Task "..." failed: <message>]` + partial(若有)+ `<usage>` trailer,据此决策(重试 / 改方案 / 报错)
- ✅ `cleanup discipline` 加 `eventBus.off("llm:request_end", usageListener)` —— 与 `clearTimeout(wallClockTimer)` 同款 finally 硬约束,任一漏清理都会跨 dispatch 累积资源(listener 泄漏会让旧 dispatch 的 `cumulativeTokens` 状态污染下次 dispatch 的 budget 判断)
- ✅ `/usage` CLI 命令拆分呈现 sub Task 用量(§12.2):
  - 解析层:[packages/cli/src/parse-task-usage.ts](../../../packages/cli/src/parse-task-usage.ts) `parseTaskUsageFromMessages(messages)` 纯函数,扫 transcript 配对 Task tool_use ↔ tool_result,正则提取 `<usage>tokens: N[, tool_uses: M], duration_ms: D, sub_id: XYZABC</usage>` trailer + 推断 `succeeded` / `failed` / `aborted` 状态(由 tool_result content 前缀 `[Task "..." failed:` / `[Task "..." aborted:` 区分);best-effort 解析,格式不匹配的 entry 跳过(不抛异常,不污染上层)
  - 渲染层:[packages/cli/src/render.ts](../../../packages/cli/src/render.ts) `renderUsageReport` 加可选 `subUsages` 参数(向后兼容 — 不传/空数组时输出与既有 byte-equal),有子 usage 时在主用量段后追加"子 agent 拆分"段(`Task#N (description) ✓/⚠/⏵ tokensFmt (N tool_uses, Ds)`)+ 求和行
  - 入口注入:[packages/cli/src/repl.ts:509](../../../packages/cli/src/repl.ts#L509) `/usage` handler 调 `parseTaskUsageFromMessages(state.messages)` 透传给 `renderUsageReport`
- ✅ 单测覆盖(共 +45 用例,其中 1 个 既有 parent-abort 测试加 budgetExceededKind=undefined 断言加强):
  - `subagent/__tests__/loop-runner.test.ts` (+18):
    - max_tokens 触发 (+4):单次超阈 / 多次累加 / cache 字段不计入 / 极大值 happy
    - listener cleanup (+3):happy / max_tokens / error 三路径 finally 解绑
    - wallClock 真触发 (+1):慢 chat + setTimeout race → kind="wall_clock"
    - first-wins 真值表(纯函数 unit test,+9):覆盖 9 种 reason × abortBudgetKind 组合,锁住 reason="max_turns" 优先于槽位 + reason="aborted" + 槽位非空直给槽位值
    - first-wins 端到端 (+1):token 先 fire(同 LLM call 即超阈)+ 短 wallClockTimeoutMs 来不及 → kind="max_tokens" + abortReason.origin 同源,验证 abort signal 与 budgetExceededKind 双通道一致
  - `subagent/__tests__/factory.test.ts` (+2):max_tokens 端到端折成 failed + max_tokens_exceeded + partial 抓 + provider.callCount=1 / wall_clock 端到端折成 failed + wall_clock_timeout
  - `subagent/__tests__/result-classifier.test.ts` (+4):budgetExceededKind 三种(max_turns / max_tokens / wall_clock)优先 reason 折 failed / caughtError 仍优先于 budgetExceededKind
  - `cli/__tests__/parse-task-usage.test.ts` (+13,新建):空 / 无 Task / 单 succeeded / 单 failed / 单 aborted / 多 entry 顺序 / tool_result 乱序按 id 配对 / 非 Task 工具不收录 / usage 标签缺失/损坏跳过 / 孤儿 tool_result 忽略 / description 缺失空串 / tokens=0 边界
  - `cli/__tests__/render.test.ts` (+8):subUsages 不传/空向后兼容 / succeeded 显示 ✓ + tool_uses + duration / toolUses=1 单数语法 / failed 显示 ⚠ + (failed) / aborted 显示 ⏵ / 多 entry 求和 / description 截断 …

**验证**:`orchestrator` 全套 228 用例全绿(M2.5 后 +24);`cli` 458 用例全绿(M2.5 后 +21,含 parse-task-usage 13 + render 子段 8);`core` 不改;`/usage` 拆分对真实多 Task 场景正确呈现 + 解析失败容错不崩

**独立性**:budget 软上限对未触发的子无影响 —— 默认 `maxTokens=50_000` / `wallClockTimeoutMs=600_000` 极宽松,常规调研型子任务不会触及;失败时 partial 仍可抓取保护用户已生成的中间产物

#### M2.7 — 测试套完整 + 灰度验证

- §14.1-§14.5 全部测试用例覆盖
- 手动灰度:CLI / 飞书 / RPC 三端跑真实子任务
- 性能基准达标
- 文档 / spec / roadmap 更新

**验证**:测试矩阵全绿;性能符合预期

**独立性**:M2.7 是收尾,不引入新代码,只补测试和验证

---

## 16. v2+ 锚点(本规格不实现,但接口预留)

| 能力 | v2+ 落地路径 | 本规格预留 |
|---|---|---|
| RoleTask(researcher / critic / writer / planner / executor) | `AgentRoleProfile` + `buildSystemPrompt(segments)` 抽象复用,新增 5 个 default profile;新工具 `RoleTask` | profile / segments 抽象一次到位 |
| BackgroundAgent | Step 22:`runChildAgent` 加 background 模式,异步走 outbox | `forkController` 异步独立模式预留 |
| WorkflowTask | `AgentRoleProfile` 装配多角色 + 步骤模板执行器 | 不预留,等场景成熟 |
| BatchTask | 同 RoleTask 但批量输入 + Promise.all | 不预留 |
| 嵌套深度 maxDepth > 1 | capability-tag override(§3.5 末段已设计) | 已预留 |
| `inherit-or-prompt` confirmation 策略 | 子未匹配父 alwaysAllow 时弹回**父用户** UI(server 走 ConfirmationHub conversationId 路由扩 agentLineage 维度) | `SubAgentConfirmationPolicy` 字面量类型扩 |
| 子 agent 中间过程持久化(audit log) | 独立 audit log spec —— EventBus 流式日志写盘,与 transcript 解耦 | 不预留 |
| 子 usage 进 Turn 持久化 | Turn schema 加 `subUsages?: Array<{ subAgentId, usage }>`(additive) | 不预留 |
| 飞书 thread binding 子 agent | OpenClaw 经验,但与"主是唯一编排者"心智冲突,需重新设计 | 不预留 |
| 跨 agent 通信(子 → 子) | 业界全没做,不强需 | 不预留 |
| 子 agent worktree / remote isolation | Claude Code 模式;企业场景再说 | 不预留 |
| 子 agent 模型 override | Task input 加 `model` 字段,简单扩展 | 不预留 |
| session-adapter 二期搬到 server 包 | `cli/serve/session-adapter.ts` 当前在 cli;orchestrator 拆出后只解决 `createAgentRuntime` 反向依赖,session-adapter 仍在 cli。二期把 session-adapter 整体搬到 server 包,cli 不再持 server runtime 实现 | session-adapter 接口稳定后即可搬 |

---

## 17. 关键代码接入点速查表

| 接入点 | 文件 | 本规格里程碑 |
|---|---|---|
| `secure-executor` legacy prompt path 删除(下沉前置) | [cli/src/security/secure-executor.ts:35-41](../../../packages/cli/src/security/secure-executor.ts#L35-L41) 删除对 `./confirmation-ui.js` 4 个 import + `prompt?: PromptFn` 字段 + `pickPath` 选路;`RunParams.securityPrompt` / 调用处入参一并删 | M1.2a |
| `secure-executor` 下沉 | [cli/src/security/secure-executor.ts](../../../packages/cli/src/security/secure-executor.ts) → `packages/orchestrator/src/security/secure-executor.ts` | M1.2a |
| `request-builder` 下沉 | [cli/src/security/request-builder.ts](../../../packages/cli/src/security/request-builder.ts) → `packages/core/src/confirmation/request-builder.ts`(与 ConfirmationRequest 类型同包) | M1.2a |
| `compact-accumulator` 下沉 | [cli/src/compact-accumulator.ts](../../../packages/cli/src/compact-accumulator.ts) → `packages/orchestrator/src/runtime/compact-accumulator.ts` | M1.2a |
| `compaction-llm` 下沉 | [cli/src/compaction-llm.ts](../../../packages/cli/src/compaction-llm.ts) → `packages/orchestrator/src/runtime/compaction-llm.ts` | M1.2a |
| `project-context` 下沉 | [cli/src/project-context.ts](../../../packages/cli/src/project-context.ts) → `packages/orchestrator/src/runtime/project-context.ts` | M1.2a |
| `system-prompt` 下沉(雏形) | [cli/src/system-prompt.ts](../../../packages/cli/src/system-prompt.ts) → `packages/orchestrator/src/runtime/system-prompt.ts` | M1.2a |
| `createAgentRuntime` 主体搬家 + `AgentRuntime` 接口 | [packages/cli/src/run-agent.ts:206](../../../packages/cli/src/run-agent.ts#L206) → `packages/orchestrator/src/runtime/create-agent-runtime.ts` | M1.2b |
| `decorateRunBus?: (ctx: RunBusContext) => () => void` 钩子 + cli `createRenderSubscribers(renderer)` 工厂注入 | `packages/orchestrator/src/runtime/create-agent-runtime.ts` 入参(`RunBusContext = { bus }`,UI 字段严禁加入);`cli/src/render.ts` 暴露 `createRenderSubscribers(renderer?)` 高阶工厂;cli REPL / runOnce / serve 三处入口分别用工厂闭包持有自己的 renderer(serve 缺省 = no-op pauseUI) | M1.2c |
| `EventBus` 扩 hierarchical(`parent` + `lineage`)+ listener `meta` 第二参 | [packages/core/src/events/event-bus.ts](../../../packages/core/src/events/event-bus.ts) + types.ts | M1.4 |
| `ToolDefinition.subAgentSafe` 字段 | [packages/core/src/types/tools.ts:246-342](../../../packages/core/src/types/tools.ts#L246-L342) | M1.5 |
| 8 个 builtin 工具 `subAgentSafe` + `isParallelSafe` 声明 | [packages/tools-builtin/src/](../../../packages/tools-builtin/src/) | M1.5 |
| `AgentRoleProfile` + `mainProfile/subAgentProfile` + `renderIdentity` | `packages/orchestrator/src/profile/` | M1.6 |
| `buildSystemPrompt(opts)` 多段重构(基于 M1.2a 雏形) | `packages/orchestrator/src/runtime/system-prompt.ts` | M1.6 |
| `trackMessages` helper 抽出复用(**internal**,不进 barrel) | `packages/orchestrator/src/runtime/track-messages.ts`(从 [cli/run-agent.ts:638](../../../packages/cli/src/run-agent.ts#L638) 抽);M2 子 agent 实现需要时直接 `import "../runtime/track-messages.js"` | M1.6 |
| `runtime/index.ts` 公共 API 收紧 + `safeDispose(label, fn)` 模块辅助 + `create-agent-runtime.test.ts` 生命周期契约测试 | `packages/orchestrator/src/runtime/index.ts`(barrel 9 项 internal 收紧) + `packages/orchestrator/src/runtime/create-agent-runtime.ts`(safeDispose) + `packages/orchestrator/src/runtime/__tests__/create-agent-runtime.test.ts`(新建) | M1.7 |
| `runChildAgent` + `runSubAgentLoop`(internal) + `lineage` + `abort-format` + `result-classifier`(internal) + `budget` + `subagent/index.ts` barrel(仅导出 `runChildAgent` / `deriveChildLineage` / `formatAbortReasonForLLM` / `SubAgentBudget` 等真公共契约;`runSubAgentLoop` / `result-classifier` / `resolveSubAgentBudget` 同包 internal) + 顶级 barrel + `package.json ./subagent` sub-path + `factory.test.ts` 三态/cleanup/INV 集成测试(共 47 个 subagent 用例) | `packages/orchestrator/src/subagent/` + `packages/orchestrator/src/index.ts` + `packages/orchestrator/package.json` + `packages/orchestrator/tsup.config.ts` | M2.1 |
| `runContextStorage = AsyncLocalStorage<RunContext>` per-run/per-spawn 上下文(M2.1 已落地,M2.3 主路径消费) | `packages/orchestrator/src/runtime/run-context.ts` | M2.1 |
| `IConfirmationBroker.id` + `BrokerSnapshot.{ id, parentBrokerId?, sourceAgentId? }` + `ConfirmationBrokerOptions.{ id?, parentBrokerId?, sourceAgentId? }` + `ConfirmationEventMap` 6 事件 payload audit 字段(broker `emitEvent` 自动注入) + `failToAllowResolver` 测试用 | [packages/core/src/confirmation/types.ts](../../../packages/core/src/confirmation/types.ts) + [packages/core/src/confirmation/broker.ts](../../../packages/core/src/confirmation/broker.ts) + [packages/core/src/confirmation/non-interactive.ts](../../../packages/core/src/confirmation/non-interactive.ts) | M2.2 |
| `resolveSubAgentResolver(policy)` + `confirmation/index.ts` barrel + 顶级 barrel + `package.json ./confirmation` sub-path + `tsup.config.ts` entry + `child-broker.test.ts`(三策略路径) | `packages/orchestrator/src/confirmation/child-broker.ts` + `packages/orchestrator/src/confirmation/index.ts` + `packages/orchestrator/src/index.ts` + `packages/orchestrator/package.json` + `packages/orchestrator/tsup.config.ts` | M2.2 |
| `RunChildAgentOptions.parentBroker: IConfirmationBroker` 必填 + `runChildAgent` 装配 child broker 透传 `parentBrokerId` / `sourceAgentId` / 由 `resolveSubAgentResolver(budget.confirmationPolicy)` 决定 resolver(`budget` 为 `resolveSubAgentBudget(opts.budget)` 投影后的 ResolvedBudget,严格走单一真相源) + `factory.test.ts` 加 audit 验证 + 端到端 `tool:call_end.success=false` 不变量验证(audit 1 + 缺省 1 + auto-deny 1 + e2e 1 共 4 个新用例) | `packages/orchestrator/src/subagent/factory.ts` + `packages/orchestrator/src/subagent/__tests__/factory.test.ts` | M2.2 |
| `createTaskTool(env)` Task 工具工厂 + `TaskToolEnv` 接口(`workspace`/`workspaceSource`/`globalConfigPath` 平铺三字段,对齐 `PromptBuildContext`) + `TASK_INPUT_SCHEMA` + `TASK_TOOL_PROMPT` + `TASK_TOOL_BOUNDARIES`(`process/exec` 静态边界声明)+ `assertCallContract` helper(集中 fail-fast 校验:ALS / `ctx.abortSignal` / `description` / `prompt`)+ `formatChildResultAsToolResult` 三态格式化 + `formatUsageTag`(`tokens = input + output`,cache tokens 有意不暴露,详见函数注释)+ `tools/index.ts` barrel + `package.json ./tools` sub-path + `tsup.config.ts` entry + 顶级 barrel re-export + `tools/__tests__/task.test.ts`(32 用例:三态文本 / schema / prompt / 元信息 / 契约前置校验集中 / cache tokens 不暴露回归保护 / happy path) | `packages/orchestrator/src/tools/task.ts` + `packages/orchestrator/src/tools/index.ts` + `packages/orchestrator/src/index.ts` + `packages/orchestrator/package.json` + `packages/orchestrator/tsup.config.ts` + `packages/orchestrator/src/tools/__tests__/task.test.ts` | M2.3 |
| `createAgentRuntime` 加 `enableTaskTool?: boolean` 选项 + `runtime.run()` 入口包裹 `runContextStorage.run({ bus: eventBus, lineage: "main" }, ...)` 整个 agent loop 主体 + 装配阶段把 `taskTool.boundaries` 注册到 mutable `boundaryRegistry`(SecurityPipeline 分类必需,详见 §4.1 末"Boundaries 声明")+ `create-agent-runtime.test.ts` 加 5 个用例(ALS 透传 / 两个并发 run() ALS 不串扰 / `enableTaskTool=true` happy path / Task `subAgentSafe===false` 防递归不变量 / 默认 false 向后兼容) | `packages/orchestrator/src/runtime/create-agent-runtime.ts` + `packages/orchestrator/src/runtime/__tests__/create-agent-runtime.test.ts` | M2.3 |
| `sub-agent-delegation` 条件性 segment(`SUB_AGENT_DELEGATION_TEXT` 常量 byte-equal 导出 + `buildSubAgentDelegation(tools)` 检测 Task 工具决定渲染)+ `MAIN_AGENT_SEGMENTS` 加 `sub-agent-delegation`(紧跟 tool-usage)+ `SUB_AGENT_SEGMENTS` 显式不含(防递归子 agent)+ `system-prompt.test.ts` 加 8 用例(MAIN/SUB segments 集成 / 条件渲染 / byte-equal 锚点 / 段顺序 / 子 agent 安全门) | `packages/orchestrator/src/runtime/system-prompt.ts` + `packages/orchestrator/src/runtime/__tests__/system-prompt.test.ts` | M2.3 |
| CLI 子 agent 状态条订阅器 `setupSubAgentStatus(bus, pauseUI)` —— 按 `meta.lineage` 关联派发型工具主调用与子 agent 冒泡事件 + TTY/非 TTY 行为差异 + 顺序匹配的并发退化标注(M2.5 真并发后多 Task 场景 UX 退化,功能不破)+ 16 用例覆盖 | [packages/cli/src/sub-agent-status.ts](../../../packages/cli/src/sub-agent-status.ts) + [packages/cli/src/__tests__/sub-agent-status.test.ts](../../../packages/cli/src/__tests__/sub-agent-status.test.ts) | M2.4 |
| 工具渲染策略表(单一事实源) `ToolRenderStrategy` + `TOOL_RENDER_STRATEGY` 映射 + `getToolRenderStrategy(name)` 唯一查询入口 —— 让 `renderer.handleEvent` 与 `setupSubAgentStatus` 共享同一查询入口避免双重渲染 + 5 用例覆盖 | [packages/cli/src/tool-render-strategy.ts](../../../packages/cli/src/tool-render-strategy.ts) + [packages/cli/src/__tests__/tool-render-strategy.test.ts](../../../packages/cli/src/__tests__/tool-render-strategy.test.ts) | M2.4 |
| `render.ts` 集成:`renderEvent` 在 `tool_start` / `tool_end` 查策略表跳过非 default 工具(让位状态条)+ `createRenderSubscribers` 装载 `setupSubAgentStatus` 与 `setupInterruptRendering` 并列共享 `pauseUI` / `dispose` + 集成测试 7 用例(派发型工具不渲染 ⟡ 卡片 5 + SubAgentStatus 集成 2) | [packages/cli/src/render.ts](../../../packages/cli/src/render.ts) + [packages/cli/src/__tests__/render.test.ts](../../../packages/cli/src/__tests__/render.test.ts) | M2.4 |
| 生产入口启用 Task 工具 —— 四处装配 `createAgentRuntime({ ..., enableTaskTool: true })`,与状态条同步上线(详见 §15 M2.4 独立性段) | [packages/cli/src/repl.ts:659](../../../packages/cli/src/repl.ts#L659)(REPL)+ [packages/cli/src/run-agent.ts:56](../../../packages/cli/src/run-agent.ts#L56)(runOnce)+ [packages/cli/src/serve/command.ts:172](../../../packages/cli/src/serve/command.ts#L172)(serve 持久会话)+ [packages/cli/src/serve/command.ts:284](../../../packages/cli/src/serve/command.ts#L284)(serve ephemeral) | M2.4 |
| tool-executor 并发改造(`canRunParallel` 分组 + `Promise.allSettled` 真并发):抽出 `runSerialBatch` / `runParallelBatch` 私有 generator + 主函数仅做委托;并发分支 `tool_start` 同步全发 + allSettled 等齐 + 按输入顺序 yield `tool_end` + 入口 abort guard + reject 路径分流(abortSignal.aborted → unexecutedToolUses,否则 isError tool_result);+ 9 个并发用例(8 段并发 + 1 现有改 isParallelSafe=false 锁串行)+ agent-loop.test.ts 1 个串行 abort 测试同款 isParallelSafe=false 显式锁定 | [packages/core/src/loop/tool-executor.ts](../../../packages/core/src/loop/tool-executor.ts) + [packages/core/src/loop/__tests__/tool-executor.test.ts](../../../packages/core/src/loop/__tests__/tool-executor.test.ts) + [packages/core/src/loop/__tests__/agent-loop.test.ts](../../../packages/core/src/loop/__tests__/agent-loop.test.ts) | M2.5 |
| `BudgetExceededKind` 类型(max_turns / max_tokens / wall_clock 三类软上限触发统一建模)+ `SubAgentLoopResult.budgetExceededKind?` 字段(替代 boolean budgetExceeded)+ `resolveSubAgentBudget` 返回 `Required<>` 投影(`maxTokens` / `wallClockTimeoutMs` 默认值收敛单一真相源) | [packages/orchestrator/src/subagent/budget.ts](../../../packages/orchestrator/src/subagent/budget.ts) + [packages/orchestrator/src/subagent/loop-runner.ts](../../../packages/orchestrator/src/subagent/loop-runner.ts) | M2.6 |
| `runSubAgentLoop` 加 `maxTokens` 必填 + 监听 `llm:request_end` listener 累加 input+output(cache 字段不计) + `maxTokensController` abort with `origin="subagent-max-tokens-exceeded"` + `AbortSignal.any([wallClock, maxTokens])` 合并 + finally 双清理(timer + listener)+ 单一 first-wins 槽位 `abortBudgetKind`(在 trigger 现场 `if (slot === null) slot = kind` 表达"先到先得",与 AbortController first-wins 同源)+ `deriveBudgetExceededKind()` 简化为线性折叠规则(reason / 槽位二选一,无静态优先级歧义,@internal export 给纯函数 unit test 锁真值表)+ usageListener 用 `AgentEventMap["llm:request_end"]` 类型契约绑定 | [packages/orchestrator/src/subagent/loop-runner.ts](../../../packages/orchestrator/src/subagent/loop-runner.ts) + [packages/orchestrator/src/subagent/__tests__/loop-runner.test.ts](../../../packages/orchestrator/src/subagent/__tests__/loop-runner.test.ts) | M2.6 |
| `classifyResult` 加 `budgetExceededKind` 优先分支(存在即 failed,与 reason 字段无关)+ `ClassifiableLoopResult` 接口加 `budgetExceededKind?` 字段 + `deriveErrorMeta` 三种 budget kind 映射 `max_turns_exceeded` / `max_tokens_exceeded` / `wall_clock_timeout` + factory 透传 budget.maxTokens 给 loop | [packages/orchestrator/src/subagent/result-classifier.ts](../../../packages/orchestrator/src/subagent/result-classifier.ts) + [packages/orchestrator/src/subagent/factory.ts](../../../packages/orchestrator/src/subagent/factory.ts) + [packages/orchestrator/src/subagent/__tests__/result-classifier.test.ts](../../../packages/orchestrator/src/subagent/__tests__/result-classifier.test.ts) + [packages/orchestrator/src/subagent/__tests__/factory.test.ts](../../../packages/orchestrator/src/subagent/__tests__/factory.test.ts) | M2.6 |
| `parseTaskUsageFromMessages(messages)` 纯函数 —— 扫 transcript 配对 Task tool_use ↔ tool_result,正则提取 `<usage>` trailer + 推断状态;best-effort 解析,格式不匹配的 entry 跳过 | [packages/cli/src/parse-task-usage.ts](../../../packages/cli/src/parse-task-usage.ts) + [packages/cli/src/__tests__/parse-task-usage.test.ts](../../../packages/cli/src/__tests__/parse-task-usage.test.ts) | M2.6 |
| `renderUsageReport` 加可选 `subUsages` 参数(向后兼容)+ `renderSubAgentUsageSection` 子段(succeeded ✓ + tool_uses/duration / failed ⚠ / aborted ⏵ / 求和)+ `/usage` REPL handler 调 `parseTaskUsageFromMessages(state.messages)` 注入 | [packages/cli/src/render.ts](../../../packages/cli/src/render.ts) + [packages/cli/src/repl.ts](../../../packages/cli/src/repl.ts) + [packages/cli/src/__tests__/render.test.ts](../../../packages/cli/src/__tests__/render.test.ts) | M2.6 |

---

## 18. 与 implementation-roadmap.md 的衔接

[implementation-roadmap.md](../implementation-roadmap.md) Step 21 的 M0 / M1 / M2 已与本规格对齐:

- Step 21 P0 = 本规格 M0 + M1 + M2(整体范围)
- 12 关键架构决定 = 草稿 + 本规格已锁定
- Step 22 BackgroundAgent / Step 23 Ctrl+B = 本规格 §16 v2+ 锚点

本规格替代 roadmap Step 21 的"详见 spec"占位 —— 实现按本规格 §15 子里程碑推进。
