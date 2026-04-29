# 子 Agent 体系 — 设计想法草稿

## 维护原则

**只关注当前设计与执行计划**,不维护变更记录、状态进度、历史演化等无效信息。

- **写什么**:长期愿景 / v1 范围(纳入 + 推迟) / 设计原则 / 待 spec 锁定的开放问题
- **不写**:修订记录 / "已拍板"决策时间戳 / "v1 状态: ✅ 必做"进度标签 / "以下保留 N 点"等元注释 / 对历史讨论的回应或心智澄清
- **更新方式**:原地改,不追加历史段;结论变了直接覆盖,不留旧版本注释
- **与其他文档边界**:落地条目和里程碑 → [implementation-roadmap.md](../implementation-roadmap.md);最终架构决策 → `specifications/subagent-execution.md`(spec 阶段产出)

---

## 业界源码参考

- [claudecode](../../source-analysis/claude-code/subagent-and-task-tool.md)
- [hermes](../../source-analysis/hermes-agent/subagent-and-task-tool.md)
- [openclaw](../../source-analysis/openclaw/subagent-and-task-tool.md)

**可行性结论:** 三家全部实现了"独立 conversation context + 工具子集装配 + 父子事件桥 + abort 级联 + 结果回写"的最小子 agent 单元。我们的"最小可组合单元"架构路 100% 可行;护城河不在底座,在 surface 设计 + 可观测性 + 失败语义。

---

## 长期愿景:子 agent 是"AI 工作的最小可组合单元"

子 agent 不是给 Task 工具量身定做的。子 agent 之于 AI 工作,等同于函数之于代码——**最小可组合单元**。函数有入参/出参/副作用边界,可以顺序/并发/嵌套组合;子 agent 同理——指令/结果/工具边界,可以串行/并行/嵌套/角色化组合。

任何健康的抽象都要有"组合代数",否则就是一次性玩具。

### 第一性原理对得上

业界 multi-agent 框架(LangGraph、AutoGen、CrewAI、Anthropic Skills、OpenAI Swarm)在 2026 年是主流方向。我们如果只做"主→子并行委托",2 年后回头看会像 2014 年的 jQuery vs React——一个被淘汰的范式。

### 真实工作场景对得上

人类工作的真实形态不是"单步外包",几乎全是组合形态:

| 场景类型 | 例子 | 组合形态 |
|---|---|---|
| 信息处理 | "先调研市场 → 再分析竞争 → 再给建议" | 串行 |
| 内容生产 | "分别给学生家长 / HR / 技术博主写营销文案" | 并行 |
| 决策支持 | "用乐观派 / 悲观派 / 现实派三视角分析" | 角色化并行 |
| 创意 | "先发散 20 点子 → 筛选 → 深化 top 3" | 串行漏斗 |
| 软件工程 | "安全审计 + 性能审计 + 可维护性审计" | 角色化并行 |
| 教学 | "出题 → 学生 agent 解 → 老师 agent 批" | 角色化串行 |
| 数据分析 | "100 个数据集跑同一套分析" | 批量并行 |
| 翻译/编辑 | "翻译 → 校对 → 风格统一" | 串行流水线 |

只做"并行委托"= 8 类场景只解决前 2 类。**"并行" 是组合算子的一个特例,不是全部**。

### 产品定位对得上

知行是个人助手,不是编程工具。个人助手的真实任务很少是"单步外包",几乎都是"研究 + 综合"、"对比 + 决策"、"分步推进"。**不做组合,产品天花板很低**。

---

## 底座 vs Surface 的分层

这是最关键的产品架构决策。

```
                ┌──────────────────────────────────────┐
                │   Surface 层(给 LLM / 用户的入口)    │
                │   ──────────────────────────────     │
                │   Task 工具(并行 + 隔离)        ✅ v1│
                │   RoleTask(角色化)              v2+ │
                │   WorkflowTask(串行模板)        v2+ │
                │   BatchTask(批量)               v2+ │
                │   BackgroundAgent(异步)         Step22│
                └──────────────┬───────────────────────┘
                               │
                ┌──────────────▼───────────────────────┐
                │   底座层:子 agent = 最小可组合单元   │
                │   ──────────────────────────────     │
                │   • 创建/运行/级联中断/资源回收      │
                │   • 工具子集装配(subAgentSafe tag)  │
                │   • AgentRoleProfile prompt 渲染     │
                │   • hierarchical EventBus + lineage  │
                │   • token / 成本归属(Turn canonical) │
                │   • transcript 父子链(三字段)       │
                │   • 错误传播协议(tool_result.is_error)│
                └──────────────────────────────────────┘
```

**底座设计为通用最小单元**(支持任意组合形态),**v1 仅暴露 Task 一个 surface**。其他组合形态由后续版本按场景成熟度逐步开放——不能挤进一个工具,也不能放出"通用编排器"让用户自己拼。

---

## Surface 形态(完整愿景 + v1 范围)

### v1 唯一交付:Task 工具(并行 + 上下文隔离) ✅

LLM 在一个 turn 里发多个 Task,各自独立调研,主 agent 综合。**最常用、首要 surface**。

### 长期愿景(v1 不交付,留待场景成熟)

#### RoleTask(角色化)
LLM 调用 `RoleTask({ role: "critic", task: "审核这份方案" })`。角色由产品预设(researcher / writer / critic / planner / executor),内置精调过的 system prompt + 工具子集 + 资源预算。用户开箱即用,可扩展但不需要从零写。
**推迟原因**: 第一阶段先打底座,role 是底座之上的薄装配,后期增量。具体角色集等真实场景验证后再定,避免"想象需求"。

#### WorkflowTask(显式串行编排)
"调研 → 报告"等常见模板由产品预设。LLM 调用 `WorkflowTask({ template: "research-then-report", input: ... })`,框架按步骤推进,每步内 LLM 自治,**步骤骨架不交给 LLM 决定**(防长流程走偏)。
**推迟原因**: 见下方"串行为什么不做专门 surface"。

#### BatchTask(批量并行)
对一组输入跑同一个子 agent。"100 个 PR 都过一遍 review" / "一组数据集跑同一套分析"。
**推迟原因**: 个人助手 v1 场景未到。

#### BackgroundAgent(异步派生,Step 22)
"你后台帮我调研 X,我们继续聊别的"——同一底座,异步壳。Step 22 单独交付。

---

## 子 agent 的资源 / 并发模型

### 心智模型:generator coroutine,不是线程也不是进程

子 agent = 同一 Node.js 进程内的**异步生成器(async generator coroutine)**。一个 turn 里所有"并行"子 agent 跑在同一个 event loop 上,通过 `await` LLM API 调用和工具 I/O 实现"并行"——本质是**同时等多个网络 I/O**,不是同时做 CPU 计算。

不走 worker_threads / child_process 的理由:
- LLM 推理 = 网络 I/O bound,根本不需要本地 CPU 并行
- Node 单线程 + 事件循环天然能 overlap 多个 I/O wait
- 起线程/进程会带来 IPC 序列化、内存复制、GC 跨域、debug 噩梦

业界三家(claudecode / hermes / openclaw)都是同进程异步任务,没有一家走 worker / child process。

### 装配模式(factory),不是池化(pool)

"池"(pool)的语义是**预热实例 + 反复复用 + 容量上限**(像 DB 连接池)。子 agent 没有"预热"这件事——它的 state 几乎全是当次任务专属(system prompt、工具子集、conversation history、budget),复用毫无意义且语义危险(上下文串泄漏)。

正确模式是**工厂(每次按需 new)**:
```
SubAgentFactory.create({
  profile,        // AgentRoleProfile 数据结构(决策 #8)
  budget,         // maxTokens / timeout(决策 7 中 canonical 由 Turn 记录)
  parentBus,      // hierarchical EventBus,自动注入 lineage(决策 #6)
  parentSignal,   // forkController(parentSignal):子 abort 不反向(决策 #10 / parent-abort kind)
  parentBroker,   // ChildBroker 注册到 ConfirmationHub(决策 #5)
})
→ 返回一次性 generator
```

每次调用都是 new 一个轻量对象 + 启一个 generator。结束即 GC,不归还到池。

### 三类业务上限(都是产品 / 成本约束,非资源约束)

| 限制 | 含义 | v1 值 | 配置项 |
|---|---|---|---|
| maxConcurrent | 同 turn 内并发 sub-agent 数 | **3** | `intent.subagent.maxConcurrent` |
| maxTokensPerSub | 单个 sub-agent token 预算 | 待对标三家 | `intent.subagent.maxTokensPerSub` |
| maxDepth | 递归深度 | **1** | `intent.subagent.maxDepth` |

---

## v1 范围

### v1 内 ✅

| 项 | 决策 |
|---|---|
| 子 agent 底座 | 一次性 generator + `AgentRoleProfile` 装配 + `forkController(parentSignal)` 子 abort 不反向 + `createInterruptController({ parent })` 父 abort 级联 |
| 唯一 surface | Task 工具(同步并行委托) |
| 同 turn 并发上限 | **3**(M2 启用 dispatcher 的 `isParallelSafe` 并发,M0/M1 串行兜底) |
| 递归深度 | **1**(实现:capability-tag,Task 工具自声明 `subAgentSafe: false`) |
| 进度 surface | hierarchical EventBus(`createEventBus({ parent, lineage })`)→ 自动冒泡 + lineage 标签 → CLI 状态条 |
| 失败标注 | 子 fail 包成 `tool_result.is_error` 给父 LLM(不反向 abort 父)+ 主 system prompt 硬要求不许"圆"过 |
| token / cost 归属 | `Turn.usage` canonical(commitTurn 唯一来源)+ EventBus `agent:run_end` 播报;父子 transcript 一份, 各 Turn 独立计 |
| abort 父→子级联 | `AbortReason.parent-abort` typed kind + `forkController` 自动级联,Esc 杀整 turn |
| transcript | 同一份 + Turn schema 三字段:`agentRole: "main"\|"sub"` / `subAgentId` / `parentTurnId`;`commitTurn` per-conversationId withLock 串行写入,多并发子 turn 自动安全 |
| confirmation | 子独立 `ChildBroker` + `ConfirmationHub.attach(brokerId, broker, { parentBrokerId, sourceAgentId })` 聚合;默认策略 `inherit-or-deny`(继承父已 alwaysAllow 决策,新决策 auto-deny) |
| channel UX | hierarchical EventBus + lineage 自动注入 → channel adapter 各自渲染。v1 只做 CLI 状态条 + RPC 事件透传 |
| 模块归属 | 新增 `@zhixing/orchestrator` 包:createAgentRuntime / 子 agent lifecycle / Task 工具执行委托 |

### v1 外 ❌(明确推迟)

| 项 | 推迟到 | 推迟理由 |
|---|---|---|
| 角色化 RoleTask | v2+ | 底座之上的薄装配, 后期增量, 避免想象需求 |
| 串行 WorkflowTask | v2+ | "主 agent 多次 Task" 已覆盖 90% 场景, 不做专门 surface(详见下文) |
| 批量 BatchTask | v2+ | 个人助手 v1 场景未到 |
| 异步 BackgroundAgent | Step 22 | 单独交付 |
| 用户扩展角色 / workflow | v2+ 不开放 | 设计陷阱 #2 #3 已警示 |
| 飞书侧专门渲染 | 后续 channel 适配阶段 | v1 走默认事件流, 不依赖具体 channel |
| 灰色任务派 vs 不派的判断 | 不锁 | 主 agent prompt 自然演化, 不做硬规则 |

### 串行为什么不做专门 surface

**唯一独立价值**是"上下文隔离 + 结果压缩":中间过程不污染主 agent context。

**但已被 Task 同步并行委托覆盖**:主 agent 完全可以多次顺序调用 Task 实现串行——
```
Turn N:    主 agent 派 Task("调研市场")          ← 单次 Task 也是合法用法
Turn N+1:  主 agent 收到调研摘要, 决定写报告
Turn N+2:  主 agent 自己写报告(或再派 Task("写报告"))
```

串行 ≡ "多次调用 Task" 的退化形态,不需要独立 surface。

**WorkflowTask 真正比"多次 Task"更优,需同时满足三个条件**: (1) 步骤骨架完全确定 (2) ≥4 步 (3) 同模板高频复用 ——如学术报告、合同审查、代码审计 pipeline。这些是**重型/专业型**场景,不在 v1 个人助手用户群。

强行做 WorkflowTask 反而给 LLM 一个"我可以不思考"的偷懒入口,让 LLM 失去临场判断能力。

---

## v1 架构决定(12 项)

> 核心原则:**最优架构,不追求最小变更**。每项决定都基于"业界为什么这里做不干净"+ "本仓哪些底座已具备"两端推理。

### A. 范围 / 产品边界

#### 决策 1:同 turn 并发上限 = 3

- claudecode 用 10,但那是给 power user 的编程工具
- 个人助手主 agent 综合 5+ 个并行结果难度急剧上升(综合质量退化)
- 3 覆盖最常见的"对比 A/B/C"模式 + 大多数批量场景头部
- 易于用户心智模型("一次最多派 3 个分身")
- 配置项 `intent.subagent.maxConcurrent` 可向上调

#### 决策 2:v1 仅交付 Task surface

- 底座抽象就是"最小可组合单元",每个 surface 是底座之上的薄装配
- v1 把底座做对比堆叠 surface 重要 10 倍
- RoleTask = 底座 + 预设 systemPrompt + 工具子集,待真实场景验证后再做
- WorkflowTask 见上文论证,被"主 agent 多次 Task"自然吃掉

#### 决策 3:递归深度 = 1

- 不用 counter 计深度(每次 spawn 都需要校验,易漏)
- 实现交给决策 #10 的 capability-tag(`subAgentSafe`),不靠"装配时排除黑名单"
- 配置项 `intent.subagent.maxDepth` 留口子,v1 默认 1

### B. state / 持久化 / 中断

#### 决策 4:持久化 — 同一 transcript + Turn schema 三字段

- canonical 单一来源:`commitTurn` 已是 transcript 唯一写入点 + per-conversationId `withLock` FIFO,多并发子 turn 自动串行化(本仓 [packages/core/src/transcript/store.ts](packages/core/src/transcript/store.ts) 已具备)
- 不学 Claude Code sidechain 文件:多文件读写 + resume 协议要二次开发,daemon 重启恢复复杂
- 不学 OpenClaw 独立 sessionFile / 物理 fork:跨 session 检索关联子结果工程量大
- Turn schema 加三字段:`agentRole: "main" \| "sub"`(UI 默认过滤 sub)/ `subAgentId: string`(实例 UUID)/ `parentTurnId: TurnId`(spawn 来源)
- daemon 重启零额外恢复协议(Phase 5 commitTurn 单向数据流已保证)

#### 决策 5:Confirmation — ChildBroker 注册到 Hub + 继承策略

- 业界三家在 confirmation 全是绕路(Claude Code 派生 toolPermissionContext + 强制 avoid prompt;Hermes TLS / ContextVar;OpenClaw 全局 broker 不分父子)—— 因为底座没有"父子 broker"概念
- 我们 [packages/server/src/confirmation/hub.ts](packages/server/src/confirmation/hub.ts) `ConfirmationHub` 已有多 broker 聚合机制 —— 子只需独立 broker + Hub attach,审计 / RPC 路由自动复用
- 子 broker 选项扩展:`{ parentBrokerId, sourceAgentId }`,Hub 由此追溯血缘
- 默认策略 `inherit-or-deny`:继承父已 `alwaysAllow` 决策(`Read /tmp` 类),新工具 / 新参数 auto-deny(避免子 agent 偷调危险工具)
- 配置项 `intent.subagent.confirmationPolicy: "inherit-or-deny" \| "inherit-or-prompt" \| "auto-deny" \| "auto-approve"`

#### 决策 6:EventBus — hierarchical from day 1

- 不做"P0 加 sourceAgentId tag,P1 做 AggregateBus"两步走 —— 同概念两实现 = 技术债务
- 一次到位:`createEventBus({ parent?, lineage? })`
  - `parent`:可选父 bus,emit 自动冒泡
  - `lineage`:字符串路径(`"main"` / `"main/sub-1"` / `"main/sub-1/grandsub-2"`),自动注入所有 payload
- `AgentEventMap` 顶层加 `lineage?: string`(所有事件共有,非每事件单独定义)
- 默认全冒泡(业界都把这做错了:Claude Code 折叠展开靠 UI 后处理,数据本身不分层)
- 渲染端按 lineage 过滤:CLI 状态条只显示 `main`,展开看 `main/sub-*`

#### 决策 7:Token 归属 — Turn metadata canonical,EventBus 是其播报

- 不要"双通道双写":metadata + EventBus 各写一份 → 同步问题
- canonical truth = `Turn.usage.{ promptTokens, completionTokens, totalTokens }` + `Turn.duration_ms` + `Turn.tool_uses_count`
- EventBus `agent:run_end` payload 携带最终 usage(订阅者 = canonical 的播报订阅,**不是写入路径**)
- LLM 看到的 `<usage>` 文本由 Turn metadata 渲染生成,不另起协议
- CLI 状态条 + `/usage` + 飞书都读同一来源(Turn metadata),呈现各自处理

#### 决策 8:Identity — `AgentRoleProfile` 数据结构

- 不再硬编码 `buildIdentity("Zhixing")`([packages/cli/src/system-prompt.ts:77-82](packages/cli/src/system-prompt.ts#L77-L82))
- 抽象为数据:`AgentRoleProfile = { name, role, instructions, constraints, tone, capabilities }`
- system-prompt 拼装由 profile 渲染:主 agent 用 main profile,子 agent 用 sub profile,未来 RoleTask 各角色各一个 profile
- 子 agent profile 注入 4 句话约束:
  - "你是 `<role>` 分身,主 agent 派你来做 `<task>`"
  - "你的输出只给主 agent 看,**用户看不到** → self-contained,别用'刚才那个'"
  - "最多 N 次工具调用,该收尾就收尾"
  - "拿不到 Task 工具,不能再派分身"
- 同时也是 v2+ 角色化(researcher / critic / planner / writer / executor)的底座

### C. 执行 / 工具

#### 决策 9:Tool dispatch — M2 启用 `isParallelSafe` 并发

- v1 承诺"3 并发"。Dispatch 串行 = 产品撒谎
- 现状:[packages/core/src/loop/tool-executor.ts:71-244](packages/core/src/loop/tool-executor.ts#L71-L244) `for` 循环串行
- 8 个 builtin 工具已声明 `isParallelSafe`,改造焦点只在 dispatcher 层
- M2 与子 agent 业务交付同步上线 —— 让"3 并发"在产品层兑现
- 串行兜底:dispatcher 检查 `tool_use[].isParallelSafe`,全 safe → `Promise.all`,有 unsafe → 顺序

#### 决策 10:工具子集 — `subAgentSafe` capability tag

- 黑名单方式(三家)随工具数增长 drift,新工具加进来必须记得维护黑名单
- 改为:每个工具自己声明 `subAgentSafe: boolean`(默认 true)—— 元信息单一真相源,不会 drift
- v1 配置:
  - Task 工具自声明 `subAgentSafe: false` —— 自然实现决策 #3 递归限制
  - Memory 工具(写入主用户记忆)`subAgentSafe: false` —— 子 agent 不污染主记忆
  - Skill 工具 `subAgentSafe: true` —— 子 agent 也需要技能
- 子 agent 装配:`tools.filter(t => t.subAgentSafe !== false)`

#### 决策 11:初始 user message — 极短,task 文本只在 system prompt

- task 文本只放 system prompt(`profile.instructions`)
- 子 agent 初始 user message 固定模板,极短:`Begin. Your task is in the system prompt under "Your Role". Depth: 1/1.`
- OpenClaw 已论证(issue #72019):重复 task 让 input token 翻倍 + prompt cache miss
- 子 agent 看到 system prompt 已有 task 全文,不需要再读一遍

### D. 模块边界

#### 决策 12:新增 `@zhixing/orchestrator` 包

- core 是基础设施(transcript / event / confirmation / interrupt / agent-loop / context-engine)—— **稳定层**
- orchestrator 是基础设施的**组合应用层**:
  - `createAgentRuntime`(从 [packages/cli/src/run-agent.ts](packages/cli/src/run-agent.ts) 搬来)
  - 子 agent lifecycle(spawn / run / cleanup / abort cascade)
  - Task 工具的执行委托(`tools-builtin/task.ts` 调用 orchestrator)
  - 未来:BackgroundAgent / RoleTask / WorkflowTask / BatchTask 都归此层
- 拒绝把 orchestrator 塞进 core(职责正交不该混)
- 拒绝留在 cli(server 已通过 cli 工厂跨包反向依赖,M1 顺势归位)
- M1 `createAgentRuntime` 重构跨包搬家时一并落地

---

## v1 用户视角

### 用户感知到的是"AI 在调度一支团队"(雏形)

主 agent 是**编排者**——根据任务性质决定:
- 单任务 → 主 agent 自己干
- 调研型 / 对比型 / 多视角型 → 派 1-3 个 Task 并行

(角色化 / 长流程模板属于 v2+, v1 不在主 agent 工具箱中)

### 用户能干什么

- **看见**: CLI 状态条显示当前活跃 Task 数 + 各自进度("Task#1 调研中... 3/5 步")
- **杀**: `Esc` 杀整 turn(级联子 Task)
- **观察成本**: 每 turn 的 token 拆桶可见(`/usage` 等)
- **看进度**: 子 agent 主动 emit progress, 状态条实时刷新, 无需展开, 不显示轮次
- **看失败**: 失败 Task 在状态条用图标标注, 主 agent 答案中显式声明"Task#X 失败,以下基于其他来源"

### 三端 UX(channel-agnostic)

底层事件流统一(hierarchical EventBus 自动注入 `lineage` 字段,如 `"main/sub-1"`),channel adapter 各自渲染:

| 端 | v1 呈现 | v1 控制 |
|---|---|---|
| CLI | 状态条(进度 + 失败图标, 不显示轮次) | Esc 杀整 turn(级联) |
| 飞书 | v1 暂不专门渲染(走默认事件文本流) | 关键词("停"/"取消") |
| IDE/RPC | 全流式事件透传 | UI 自决 |

**架构原则**: 所有 channel 收到同一份 EventBus 事件, 呈现形式各自决定, 实现不能 channel-couple。CLI 最近且统一, v1 优先把 CLI 状态条做对。

---

## 比业界做得好的关键点

### 1. 把"组合"作为产品一等公民
业界三家都做了"主→子并行委托",但都没把"串行 / 角色化 / 批量"作为同等公民。我们在底座一开始就支持任意组合,但每种组合都有专门的 surface 设计——不是糊一个"通用编排器"扔给用户。

### 2. 角色是产品预设的"乐高",不是用户从零拼的零件
researcher / writer / critic / planner / executor 五个核心角色由产品预调 prompt + 工具子集 + 预算。用户开箱即用,可扩展但不是入口。比 hermes 的"自定义 system prompt"友好得多。底座为后期 RoleTask 留接口。

### 3. 长流程编排骨架不交给 LLM
LLM 在每一步内部自治,但步骤骨架由用户/产品定义。这是"框架 + 自由"的混合,避免 LLM 长流程走偏。

### 4. 并行作为一等公民教给 LLM
Task 工具的描述明确鼓励"分类型/对比型任务一次派多个 Task"。claudecode 靠 LLM 自己悟,我们写在 prompt 里。

### 5. token 透明到分桶 — canonical 单一来源
一个 turn 用了 60K token,明确拆出"主 LLM 5K + Task#1 35K + Task#2 12K + Task#3 8K"。**canonical = `Turn.usage`**(commitTurn 唯一写入),EventBus / CLI / 飞书 / `/usage` 都读同一来源,不双写。三家(Claude Code 拼 `<usage>` 文本 / Hermes close 前抓 cost / OpenClaw 双 sessionFile 各计)都是 ad-hoc。我们走 first-class metadata。

### 6. 失败必须显式 surface 给用户
子 agent 失败, 主 agent **不许"圆"过去**——答案上方加 "Task#X 失败,以下基于其他来源" 标注。在主 agent 的 system prompt 里硬要求。hermes 那种"子失败父继续若无其事"是 anti-pattern。

### 7. 分身知道自己是分身 — `AgentRoleProfile` 渲染
不硬编码 `buildIdentity()`,改为 `AgentRoleProfile` 数据结构 + 模板渲染。子 profile 注入 4 句话约束(详见决策 #8):
- "你是 `<role>` 分身,主 agent 派你来做:`<task>`"
- "你的输出只给主 agent 看,**用户看不到** → self-contained,别用'刚才那个'"
- "最多 N 次工具调用,该收尾就收尾"
- "拿不到 Task 工具,不能再派分身"

同一抽象 v2+ 给 RoleTask 复用(researcher / critic / writer 各自一个 profile)。智能体行为塑造层面的 prompt 工程精度,业界三家都没做到位。

### 8. 不会无限套娃 — `subAgentSafe` capability tag
不靠维护黑名单(三家通病:新工具加进来必须记得改黑名单,drift 风险),改为工具自身声明 `subAgentSafe: boolean` 元信息。Task 工具自声明 `subAgentSafe: false` —— 直接堵死递归,等价于深度 1,**单一真相源不会 drift**。配置 `intent.subagent.maxDepth` 留口子但 v1 默认 1。比 hermes 的 `max_spawn_depth + role` 更干净,比 claudecode 给"内部用户"开后门更纯粹。

### 9. transcript 一份存,统一持久化
不学 claudecode 写独立 sidechain 文件、不学 hermes 搞外键、不学 openclaw 物理 fork。**用同一份 transcript,Turn schema 加三字段:`agentRole: "main"\|"sub"` + `subAgentId` + `parentTurnId`**。UI 默认过滤 `agentRole === "sub"`,展开看可见。`commitTurn` per-conversationId withLock 已保证多并发子 turn 写入安全;daemon 重启恢复零额外协议(已被 Phase 5 单向数据流保证)。

### 10. abort 行为透明可控 — typed `AbortReason.parent-abort`
不靠 claudecode 的 `Ctrl+X Ctrl+K` 双击魔法、不靠 openclaw 的"主 agent 显式调 cascadeKill 工具"、不靠 hermes 的"父 interrupt 末尾遍历 _active_children"。本仓 [AbortReason](packages/core/src/interrupt/types.ts#L46-L50) 已有 `parent-abort` typed kind + `forkController(parentSignal)` 子 abort 不反向影响父 + `createInterruptController({ parent })` 父→子级联 —— **底座原语已具备,业界全没有**。同步 surface 默认级联,异步 surface(BackgroundAgent)默认解耦。LLM 看见、用户看见、行为可预测。

### 11. 可观测性 first-class — hierarchical EventBus
多 agent 编排最大风险是黑盒——10 分钟跑出错了不知道哪步。我们已有 transcript / EventBus / interrupt / outbox 设施全部可复用,这是**别人的瓶颈是我们的优势**。EventBus 一次到位 hierarchical(`createEventBus({ parent, lineage })`),lineage 自动注入所有事件 payload —— 不是 P0/P1 两步走,是单一概念单一实现。每个子 agent 的状态、流、token、错误 first-class 可见。

### 12. 失败边界分级
单 agent 失败 / 串行链断 / 并行某分支挂 / workflow 撤销 — 4 种失败语义不能混。每种都要有明确"主 agent 怎么应对"协议。这是我们要在 spec 里把业界的模糊地带砸实的地方。v1 只涉及"并行某分支挂",其他三种延后。

---

## 落地的 4 个陷阱(产品风险)

### 陷阱 1:让 LLM 自由编排是灾难
现在的 LLM 不擅长长流程编排——"先调研 → 再分析 → 再写报告" 它会走偏、漏步、自我循环。**所以"组合"必须有两条不同路径**:
- **隐式编排**:LLM 在一个 turn 里发多个 Task(LLM 决定),适合并行
- **显式编排**:产品/用户预设 workflow 骨架,LLM 填内容,适合串行

两条不能混。把长流程完全交给 LLM 自治 = 用户体验崩溃。

### 陷阱 2:角色化做成自由配置 = SaaS 陷阱
如果"角色 = 用户自己写 system prompt",学习曲线立刻劝退。**正确做法**:产品预设核心角色,作为内置乐高;用户能扩展但不需要从零写。

### 陷阱 3:工作流做成开放编辑器 = 跑偏成 Zapier
如果用户面对一个"workflow builder UI",那不是个人助手,那是平台。**正确做法**:主 agent 作为隐式编排者 + 少量预设模板内置。

### 陷阱 4:复杂度爆炸
最小单元 × N 种组合算子 × M 个角色 = 设计 / 实现 / 测试 / debug 复杂度乘积爆炸。**对策**:抽象上完整,实现上分层 — 底座一次性做对,surface 按场景成熟度逐步开放。

---

## 5 个设计原则

1. **底层抽象完整,入口暴露有节制** — 底座支持任意组合,surface 按需开放
2. **角色 / workflow 是产品预设而非用户配置** — 内置乐高
3. **编排骨架由产品/用户给,内容由 LLM 填** — 框架 + 自由的混合
4. **可观测性 first-class** — 每个子 agent 的流、token、错误全部可见
5. **失败边界明确** — 4 种失败语义在 spec 里砸实

---

## 仍待 spec 阶段(M0)详细论证的事项

12 项架构决定已锁定。以下是 spec 阶段需详细论证的**落地细节**(字段表 / 接口契约 / 数字 / 算法 / 测试拓扑),写在 `specifications/subagent-execution.md`。

### A. 数据结构精确定义

| 项 | 内容 |
|---|---|
| `AgentRoleProfile` 字段表 | `name / role / instructions / constraints / tone / capabilities` 各字段类型;主 profile 默认值;sub profile 默认值 + 4 句话原文 |
| `Turn` schema 三字段 | `agentRole: "main" \| "sub"`(默认 main 向后兼容)/ `subAgentId: string \| null` / `parentTurnId: TurnId \| null`;序列化与既有 transcript 文件向后兼容方案 |
| `AgentEventMap` 顶层 `lineage` 字段 | payload 中的精确位置 + 渲染端读取约定 + 现有事件订阅者回溯影响盘点 |
| `ChildBroker` 选项 + `ConfirmationHub.attach` 签名 | `{ parentBrokerId, sourceAgentId }` 字段类型 + Hub 端如何按 lineage 检索 |
| `subAgentSafe` 工具元信息位置 | 在 [packages/core/src/types/tools.ts](packages/core/src/types/tools.ts) 的 `Tool` interface 加字段还是 `ToolMetadata`?默认值规则 |

### B. 接口契约

| 项 | 内容 |
|---|---|
| Task 工具 `input_schema` | 字段 = `{ prompt, description?, subagent_type? }` 还是只 `{ prompt }`?v1 单 role 是否暴露 `subagent_type` |
| Task 工具 output 三态 | success / failure / aborted 各自的 `tool_result` 文本格式(参考 Claude Code partial-result 语义) |
| 子 agent 终态文本抓取 | 最后一条 assistant message / 多条 concat / agent 主动 emit `final_message` event 三选一 |
| 失败 `tool_result.is_error` 文本协议 | 错误类型 + 已有部分结果是否拼上(子已说了一半,父能不能看到) |

### C. 数字 / 默认值

| 项 | 内容 |
|---|---|
| `maxTokensPerSub` | 对标 Claude Code(无 cap)/ OpenClaw(`forkMaxTokens` 阈值)/ Hermes(无),给个保守默认 |
| 子 LLM idle timeout | 默认值 + 配置项 |
| Task 总 wall-clock timeout | 默认值 + 配置项 |
| 8 个 builtin 工具的 `subAgentSafe` 默认列表 | 逐个列(Read/Glob/Grep/Edit/Write/Bash/Task/Memory/Skill...) |

### D. 算法 / 策略

| 项 | 内容 |
|---|---|
| M2 dispatcher 并发实现 | `tool_use` 数组中 `isParallelSafe` 检查 → `Promise.all` vs `Promise.allSettled` 错误聚合策略 |
| 现有 8 个工具的 `isParallelSafe` 真伪验证 | 不能仅凭已声明的元信息,需 M0 实际盘点 |
| 子 agent commit Turn 时机 | LLM `end_of_turn` 立即 commit / 主 agent next turn 同步 commit / outbox slot 触发 commit |
| `inherit-or-deny` confirmation 策略实现 | 父 alwaysAllow 决策如何序列化 + 子 broker 查询匹配规则 |

### E. 测试拓扑

| 层 | 覆盖 |
|---|---|
| 单元 | 子 agent factory / `forkController` 父子隔离 / `commitTurn` 多并发 / `subAgentSafe` capability filter / `AgentRoleProfile` 渲染 |
| 集成 | Task 工具端到端 / abort 父→子级联(typed reason)/ confirmation 父子继承 / EventBus lineage 冒泡 |
| E2E | CLI 真实派 3 个 Task / 飞书远程 abort 子 / RPC stream-json 透传 lineage |
| 平台 | Windows 路径 / Unix 信号 / daemon 重启时未完成子 turn 恢复 |

### F. 模块边界落地

| 项 | 内容 |
|---|---|
| `@zhixing/orchestrator` 包结构 | package.json 依赖、入口 export、跨包依赖图(谁依赖 orchestrator) |
| `createAgentRuntime` 跨包搬家 | M1 重构具体步骤、CLI 入口 callsite 调整、server `session-adapter` 接入点改动 |
| Task 工具的 orchestrator 委托接口 | `tools-builtin/task.ts` 调用 `orchestrator.runChildAgent(...)` 的 API 形态 |
