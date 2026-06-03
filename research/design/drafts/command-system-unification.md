# 命令系统统一 — 债务诊断与迁移架构

> **性质**：架构债务诊断（第一部分）+ 目标架构（第二部分）+ 可执行迁移方案（第三部分）。
> **父 spec**：[input-typeahead.md](../specifications/input-typeahead.md) —— 命令系统"单一真相源 + 多 target 视图派生"的设计意图在此已定稿。
> **本文档不引入新设计**：它把父 spec 已经定下、但实现只走到一半的架构，贯彻到终点。所有目标态都能在 input-typeahead.md §4.1 / §5.8 / §9.2 找到出处。

---

## 第一部分 · 债务诊断（基于一手源码）

### 1. 触发症状

由表及里的症状，指向同一个根：

1. **`/help` 看不到 skill/task/动态命令**。`/help` handler（`packages/cli/src/repl.ts:328`）只遍历静态数组 `REPL_COMMAND_META`，而 `/skills`、`/skill-new`、`/skill-add`、task_list 命令、以及动态 `/<name>` 技能都不在这个数组里。
2. **legacy 终端路径下 skill/task 命令完全不可达**。无 chrome / 管道 / `ZHIXING_INPUT_TYPEAHEAD=legacy` 时，REPL 走 `runLegacyCommand`（`repl.ts:1946`），它只查 `slashCommands` 字典；现代命令不在该字典，直接报"未知命令"。
3. **命令的"执行器"物理错位在 cli**。命令的执行分派器 `CommandDispatcher` 定义在 `packages/cli/src/command-dispatcher.ts`，而命令的"声明真相源" `ICommandRegistry` / `CommandDef` 在 `@zhixing/core`。命令层被劈成"声明在 core、执行在 cli"两半 —— 这违背父 spec §4.1 把整个命令层画在 core 的分层意图（见下文 §3）。
4. **（未来）server / 渠道无命令层**。`packages/server` 的 `InboundRouter` 把 `/` 开头的消息当普通文本透传给 agent（IntentClassifier 仅识别 `cancel`）。飞书里打 `/skills` 不会被当命令——命令目前是 CLI 独家概念。症状 3 正是这一项的结构性障碍：执行器锁在 cli，server 想复用就撞依赖方向（见第二部分 §6）。

`/help` 看不到 skills 只是最表层的一个投影。补丁式地改 `/help` 只擦掉症状 1，症状 2/3/4 原封不动。

### 2. 根因：命令真相源被复制成三份 + 执行分裂成两轨 + 命令层被劈成两半

**三个并存、且内容互不一致的命令声明源：**

| 声明源 | 位置 | 内容 | 状态 |
|---|---|---|---|
| A. core 内建清单 | `core/src/typeahead/builtin-commands.ts` `buildBuiltinCommands()` | 11 条（new/clear/history/exit/model/elevated/fast/verbose/status/help/debug） | 已废弃，cli 运行时不用（`repl.ts:1488` 注释明示不再调用）；含 fast/verbose/elevated/history 等 cli 从未实现的命令 |
| B. cli legacy 表 | `repl.ts:240` `REPL_COMMAND_META` + `buildSlashCommands()` 返回的 `slashCommands` 字典 | 20 条实际核心命令 | 元数据（数组）与 handler（字典）靠 `legacyKey` 字符串关联 |
| C. 现代直接注册 | `registerTaskCommands` / `registerSkillsCommand` / `registerSkillNewCommand` / `registerSkillAddCommand` / `SkillCommandSource` 动态源 | task_list + skill 三件套 + 动态 `/<name>` | 直接注册到运行时 `tRegistry` |

三份清单从不重合：A 独有 `fast/verbose/elevated/history/debug`（其中 debug 为 hidden）；B 独有 `me/resume/work/journal/people/trust/security/config/mcp/tasks/name/compact/usage/context`；C 独有 task/skill/动态命令。（A 计 11 条、B 计 20 条，见 builtin-commands.ts 与 repl.ts:240-265。）

**两种 handler 形态：**

- legacy：`(state: ReplState, args: string) => Promise<void> | void`，藏在 `slashCommands` 字典里，靠闭包捕获 `session` / `renderer` / `cliWriter` / `mcpHub` / `renderScreen` / `applyModeSwitch` 等。
- 现代：`CommandHandler`（`(ctx: CommandHandlerContext) => CommandHandlerResult`）+ `execution` 三档，注册到 `CommandDispatcher`，依赖经 deps 显式注入。

**两条执行路径：**

- typeahead 路径（`repl.ts:2026`）：`typeaheadDispatcher.dispatch()` 命中即执行。注意：桥接循环（`repl.ts:1648-1670`）已把全部 20 条 `REPL_COMMAND_META` 连同 handler 成对注册进 `tRegistry` + dispatcher，故此路径下任一真实命令都解析为 `local-handled`，`unknown`/`missing-handler` 才 fallthrough 到 `runLegacyCommand`——**fallthrough 实际只接到错名/未知命令，对合法命令是死路**（`repl.ts:2032` 注释"未桥接的 /trust /people 等"已失真：trust@263、people@257 都在表内、都被桥接，待统一时一并清理）。
- legacy 输入路径（`repl.ts:2063`）：`rl.question` 读行 → 直接 `runLegacyCommand` 查 `slashCommands` 字典，**完全不经过 registry / dispatcher** → 现代命令不可达。这才是"现代命令不可达"的真实破口。

**命令层被劈成两半（执行器错位）：** `ICommandRegistry` / `CommandDef` 在 `@zhixing/core`，但执行它们的 `CommandDispatcher` 却在 `@zhixing/cli`。父 spec §4.1 的三层分离图把"命令的单一真相源 + 分派核心"整体画在 core；dispatcher 落在 cli 是 Phase 1 REPL 接入时的实现权宜——它本身已 100% UI 无关（`command-dispatcher.ts` 顶部 import 全是 `@zhixing/core` 的类型，设计原则 1 明写"dispatcher 不认识 readline / chalk"），却被放错了包。

**消费侧也分裂：** typeahead 补全 dropdown 读 `tRegistry.list(ctx)`（能看到 skill），`/help` 读 `REPL_COMMAND_META` 数组（看不到）。"列命令的数据源 ≠ 命令真相源"。

### 3. 这违背了父 spec 已定的设计（关键认知）

这不是"还没设计好"，而是"设计已定、实现走了一半"。input-typeahead.md 早已把目标架构写定：

- **§4.1 三层分离**：core 层框里明确列着 `CommandRegistry`（命令的单一真相源）+ `TypeaheadBroker`（trigger 检测 + 分派 + 取消），核心解耦原则写死"Core 不认识 TTY / Ink / chalk / readline"。**命令层（声明 + 分派）整体属于 core**，cli 只是其下挂的一个渲染/交互 target。`CommandDispatcher` 当前落在 cli，正是这张图"实现走了一半"的体现。
- **§5.8（2026-04-16 refinement）**：批判过初版 core builtin 清单的三宗罪——① 幽灵命令（声明了没 handler）、② 设计集与实际集二元分裂、③ **handler 归属靠"id 字符串精确匹配"维护、容易漂移**。结论是把声明权交给 CLI、声明与 handler 同源。
- **§9.2**：`dispatchAccepted` 是统一的命令执行入口，按 `execution` 三档（local/agent/hybrid）分派。（注：§9.2 伪代码写的是 `cmd.handler(...)`、ctx 带 `repl/session`；实际实现演进成了更优的"handler 在 dispatcher Map + ctx 仅 target 无关的 `RuntimeContext`"形态——见第二部分 §2 不变量 3，迁移收尾须回校 §9.2。）

讽刺的是，§5.8 提出的修复——`REPL_COMMANDS` 静态表循环注册 + `legacyKey` 桥接 handler——**自身就踩进了它批判的第 ③ 条**：元数据（`REPL_COMMAND_META` 数组）和 handler（`slashCommands` 字典）分两处、靠 `legacyKey` 字符串关联，正是"绑定靠字符串匹配、容易漂移"。而后来的 task/skill 走的"模块化注册"（`registerXxxCommands` 同时 `registry.register` + `dispatcher.registerHandler`）反而才是 §5.8 精神的正确落地——声明与 handler 在同一处原子绑定，结构上杜绝幽灵与漂移。

**所以现状 = spec 的半程实现：** `REPL_COMMAND_META` 是过渡形态的遗留，task/skill 的模块化注册才是终点形态；命令层执行器错位 cli 是分层未走完。三种范式并存，叠加 legacy 执行路径未统一，共同构成本债务。

### 4. 诊断模式（呼应项目反复出现的失配）

本债务与项目里反复出现的两类失配同构，值得登记为可迁移的诊断信号：

- **"声明面 > 生效面"**：命令在 `tRegistry` 的"声明"领先于 `/help` 的"消费"（仍读旧的 `REPL_COMMAND_META`）；`CommandDef.handler` 字段（`core/src/typeahead/types.ts:329`）声明了却从不被 dispatcher 消费（dispatcher 走独立 Map）。同 confirmation 的"三投影点"、permission 的"声明面领先生效面"。
- **"双轨制下消费方读了过时的那一轨"**：补全读新轨（registry），`/help` 与 legacy 执行读旧轨（静态表 / 字典）。
- **"解耦边界放错了物理位置"**：dispatcher 已是 UI 无关的解耦件，却因实现顺序被留在 cli，使本该 target 无关的执行层被一个具体 target 包"挟持"。

---

## 第二部分 · 目标架构

### 1. 一句话主张

**命令层（`ICommandRegistry` + `CommandDispatcher` + `CommandDef` 类型）整体物理在 `@zhixing/core`，target 无关 + UI 无关；声明与 handler 在同一处原子注册；所有执行汇入一个 `CommandDispatcher`；所有"列命令"的消费方都从 registry 派生视图。** 三个声明源归一、两条执行路径归一、消费侧不再各读各的、命令层不再被劈成 core/cli 两半。

### 2. 不变量（评判任何实现是否"还在债里"的硬标尺）

1. **真相源唯一**。`tRegistry`（`DefaultCommandRegistry`）是命令全集的唯一来源。没有任何"列命令"的代码遍历 `tRegistry` 之外的数组/字典。`REPL_COMMAND_META`、`slashCommands` 字典被删除。

2. **命令层在 core、target/UI 无关**。`ICommandRegistry`、`CommandDispatcher`、`CommandDef` 及其类型族全部物理在 `@zhixing/core/typeahead`。
   - **CommandDef 是纯元数据**：可序列化、不持有任何 UI 闭包，这是"多 target 派生"的物理地基——core 把命令元数据推给任意渲染端（cli / web / gateway），各端按自己能力裁剪视图。`CommandDef.handler` 字段（types.ts:329，Phase 1 遗留、从不被 dispatcher 消费）随之**删除**，消除"纯元数据"原则上的破口。
   - **dispatcher UI 无关**：它已满足（设计原则 1，import 全是 core 类型）。下沉到 core 后，执行层与声明层同处一包，cli / server / 任何 target 都装配**同一套**命令层，依赖方向不再成为障碍（详见 §6）。

3. **声明与 handler 原子绑定**。每条命令在一次 `registerXxxCommands(deps)` 调用里同时 `registry.register(def)` + `dispatcher.registerHandler(id, handler)`——两个调用**时序相邻、同源原子**，不存在"元数据在 A、handler 在 B、靠字符串 key 关联且分散维护"的漂移窗口。
   - **为何 handler 走 dispatcher Map 而非塞进 CommandDef**：handler 是带副作用、捕获各 target 本地 deps（cli 的 `cliWriter`/`session` 等）的闭包，塞进 CommandDef 会破坏不变量 2 的"纯元数据可序列化"。正解是：CommandDef 跨 target 共享（声明），handler 由各 target 在本地 dispatcher 注册（执行）。这比父 spec §9.2 伪代码的 `cmd.handler` 形态更优——收尾回校 §9.2。
   - 结构上杜绝幽灵命令（声明了没 handler，dispatcher 返回 `missing-handler`）与盲视命令（有 handler 没声明，根本进不了 registry）。

4. **deps 注入契约：runtime-mutable 状态一律惰性 getter**。`registerXxxCommands(deps)` 的 deps 接口，对"会随 `RuntimeSession.reload` 改变的 runtime 状态"（`securityPipeline` 及一切 `agentRuntime` 派生物），**一律暴露为 getter thunk**（如 `() => session.runtime.securityPipeline`），在 handler / `ArgChoiceProvider` 调用时刻求值；**禁止在构造期 capture 实例快照**。
   - 依据：`session.ts` reload 仅 swap `agentRuntime` 等字段，closure getter 自动指向新实例。构造期 capture 快照 = reload 后行为陈旧。
   - **现存反例（迁移须修，非保留）**：`trustRuleArgProvider`（`repl.ts:1634` `createTrustRuleArgProvider(session.runtime.securityPipeline)`）在构造期 capture 了 `securityPipeline` 实例快照；reload swap 出新 `SecurityPipeline`（`create-agent-runtime.ts:584`）后旧 provider 仍持旧实例。其 `getPermissionStore()` 因 store 跨 swap 复用、仍正确；但旧实例构造期一次冻结的 `contextId`（`deriveContextId(trustContext)`）可能与新实例不一致。**这是一处条件性的 latent staleness bug**：主模式 `/config` reload 重建时 `trustContext` 恒为硬编码 `{kind:"main"}`、工作区由跨 reload 不变的 `cliWorkspace` 解析，故常规 reload（改模型/凭证/MCP）下新旧 `contextId` 等值、`/trust` 候选**无可观测差异**；只有当解析后工作区路径真正变化（workscene 切换 `enterWorkMode`，或未带 `--workspace` 启动时改 `config.workspace` 触发 agent 域 reload）才会让旧 `contextId` 陈旧、`/trust` 列出错误上下文的规则集。对照 `/security` handler（`repl.ts:815`）在调用时刻读 `session.runtime.securityPipeline`、永远正确。**本契约的价值在于结构上消除这类 capture-快照脆弱性、杜绝同类 bug 再生，而非修复一个常发现象**——这正是把 deps 注入做成契约、而非逐命令打补丁的理由。

5. **命令层无条件构建，执行路径唯一**。命令层 = `tRegistry` + `CommandDispatcher` + 所有 `registerXxxCommands`，在 startRepl 顶层**无条件构建**（与终端能力无关、任何模式恒在）。当前它们被关在 `if (useTypeahead)` 块内（`tRegistry` 是块内 const，`repl.ts:1510`；dispatcher 构造在 `repl.ts:1529`），legacy 模式下根本不存在——统一的第一步就是把命令层提升出该块。其上的**交互层**（输入采集 + 渲染）才依 `capability.ok` 分叉：有 chrome 走 typeahead broker + panel，无 chrome / 显式 legacy 走 `rl.question`。`CommandDispatcher.dispatch(rawDraft, runtime)` 是唯一执行入口，两条采集路径读到 `/` 开头都汇入它；`runLegacyCommand` + `slashCommands` fallthrough 被删除。
   - **删 fallthrough 须补 unknown 提示落点**：现状"未知命令: X 输入 /help 查看帮助"提示的**唯一物理落点**在 `runLegacyCommand`（`repl.ts:1953`）；dispatcher 按设计（`command-dispatcher.ts:24`）对未知命令只返回 `{ kind: "unknown", commandName }`、不负责文案。删 `runLegacyCommand` 后，共用的 `DispatchResult` 处理段（`repl.ts:2026-2046`）须把原 `unknown`/`missing-handler` 分支改为**就地打印**该提示（与已自带打印的 `error` 分支并列），否则未知命令被静默吞掉。
   - **跨 reload 持久**：命令集由代码定义、不随 config reload 改变，registry/dispatcher 无需重建（命令层跨 reload 持久）；handler 与 args provider 对 reload-mutable 状态的访问遵守不变量 4 的 getter 契约。
   - **兼容 §12.2#3 锁定**：spec 锁定的是"保留一条非 typeahead 的输入兜底"（应急回退 `rl.question`），不是"保留 `slashCommands` + `runLegacyCommand` 这套执行实现"。兜底路径保留输入采集，执行统一到 dispatcher——顺带修复症状 2。

6. **消费派生唯一**。`/help`、typeahead 补全、未来任何前端的命令面板，都从 `registry.list(ctx)` 派生。`/help` 改读 registry 后自动全、自动尊重 `hidden` 与 `visibility`（`DefaultCommandRegistry.list` 已内建过滤）。

7. **环境约束用 visibility 表达、真相源恒全集**。个别命令需 chrome 终端（alt-screen / 接管 raw stdin：`/config` `/mcp` `/skills` `/skill-new` `/skill-add`）。它们**仍无条件注册进 registry**（真相源不因环境残缺），但 `CommandDef.visibility.predicate` 声明"需 chrome"——读 `RuntimeContext.features.chrome`（cli 填 `capability.ok`，而非 `useTypeahead`：显式 legacy 但有 chrome 时这些命令仍可用）。`registry.list(ctx)` 据此在无 chrome 时自动过滤；handler 入口经统一 `requireChrome(screen, cliWriter)` helper 兜底"硬打名字"的情况，友好提示而非崩溃（`dispatcher` 语义不变，仍符合 §9.2）。
   - **现状两类机制须分述、勿混**：(a) skills 三件套 + task + 动态源只在 `if(useTypeahead)` 块内注册、不进 `slashCommands`，无 chrome 的 legacy 路径 `runLegacyCommand` 查不到 → 报"未知命令"（靠不注册回避）；(b) `config`/`mcp` 在 `REPL_COMMAND_META` + `slashCommands` 双注册，无 chrome 时经 `runLegacyCommand` 仍可达，且其 handler 当前已有 `isTTY=false` 优雅分支（`runConfigEditor` 返回 `non-tty`、`screen?.` 可选链）、**不崩**，只是缺统一门禁声明。改 visibility + requireChrome 后：(a) 类获得"可达但友好拒绝"语义，(b) 类把分散的 non-tty 防御收敛为统一门禁——属行为收敛、非"修复崩溃"。
   - **死代码处置**：给 `config`/`mcp` 加 requireChrome 短路后，`runConfigEditor` 的 `non-tty` 分支（`config-editor/runner.ts:80-82`）与 `config-command.ts` 的 `case "non-tty"`（`config-command.ts:126-131`）经命令 caller 不再可达。注：该分支当前已无已证活触发来源——两个 caller 中 `/config`·`/mcp` 侧"REPL 必为 TTY、理论不可能"到达，`startup` 因调用前已 pre-filter 非 TTY 也不进入（`startup.ts` 自身的 `non-tty` 是独立 missing-field fail-fast、不经 `runConfigEditor`，与此同名异源）。落地时一并核实调用链后再决定清理范围，勿按未证链路误删 startup 仍需的分支。

### 3. 命令模块化组织

取代 `buildSlashCommands` 巨型函数 + `REPL_COMMAND_META` 集中表，按域拆成若干注册模块，每个模块就近声明 + 绑定 handler + 经 deps 注入依赖。范式直接沿用已验证的 `registerTaskCommands` / `registerSkillsCommand`：

```
packages/cli/src/commands/
├── session-commands.ts    register: new clear resume name exit work
├── info-commands.ts       register: help status me model usage context journal people tasks
├── config-commands.ts     register: config mcp trust security
├── tools-commands.ts      （skill 三件套已在 skills/，task 已在 commands/task-commands.ts）
└── ...
```

**域切分定稿**（按依赖聚类 + 语义内聚）：session = 对话生命周期 + 模式切换；info = 只读展示（`/help` 在此注入 `registry` 用于列命令）；config = 配置/权限/安全（config·mcp 是 alt-screen）。skill 三件套保留在 `skills/`、task 保留在 `commands/task-commands.ts`。代码模块（文件如何组织 `registerXxxCommands`）与 `CommandDef.category`（`/help` 展示分组字段）是**正交两维**——每条命令的 `category` 沿用其在 `REPL_COMMAND_META` 的现值、保持 `/help` 分组不变，不随代码模块名变化。

每个 `registerXxxCommands(deps)` 接收一个窄 deps 接口（接口隔离，便于测试注入 stub），内部对每条命令做原子注册。**依赖矩阵（聚合视图，非逐条完整清单）：** 下表按"共享 dep → 用到的命令"聚类，用于把握注入面；阶段 B 逐条迁移时，重命令须各自核对其 handler 体的全部依赖（矩阵未列全个别命令的细粒度依赖，见表下注）。

| 依赖 | 用到的命令 |
|---|---|
| `state.conv.*`（messages/conversationId/store/convRepo/turnCounter） | clear resume compact new status usage context name |
| `session.runtime.*`（model/providerId/checkBudget/forceCompact/...；按不变量 4 以 getter 注入） | model status usage context clear compact security mcp |
| `cliWriter` | 几乎全部（输出） |
| `applyModeSwitch` | work exit |
| `clearScreenToInitial` | clear |
| `renderScreen`（chrome 控制器） | config mcp（alt-screen）+ 退屏重申光标 |
| `rl`（readline 接口） | exit（close）、config/mcp（pause/resume） |
| `mcpHub` | mcp |
| `onConversationChanged` | new resume |
| `state.scheduler` | tasks |
| 无状态（纯 I/O / 展示） | help me journal people trust(noop handler) |

> **矩阵补注**：本表是聚合视图，个别命令的细粒度依赖未铺开 —— 如 `/work` 还读 `session.activeMode` / `session.workSceneRegistry.list` / `state.activeTurnPromise`，`/exit` 读 `session.activeMode` / `state.activeTurnPromise`，`/journal`·`/people` 各自 `new JournalStore()`/`new PeopleStore()`（构造 import 来的类、不捕获闭包状态，归"无需注入 deps"是恰当的）。阶段 B 对重命令以 handler 体为准逐条核对，勿把本表当可直接照搬的完整清单。

deps 注入模式 task/skill 已验证（`getMessages` / `getConversationId` / `callText` 等闭包访问器），迁移是把"闭包捕获"换成"deps 字段"，handler 业务逻辑零改；dep 获取机制按不变量 4 调整（可能修正现存快照捕获，如 `/trust`）。

### 4. execution 档位（按 dispatcher 精确定义校正）

`execution` 的判定标准是**是否经 dispatcher 向 agent 注入消息**，不是"副作用大小"：

- **local（全部 20 条核心命令）**：handler 跑完即结束、不经 dispatcher 给 agent 发 message。包括 `/work` `/exit`——它们的模式切换走 `applyModeSwitch`（turn 边界消费 `pendingModeSwitch`，源码 `repl.ts:671/856/2222`）这条**独立通道**，不是 hybrid 的 `systemMessage` 通道，故仍是 local。这与 §12.2#4 锁定的"所有内建命令都是 local"以及现行桥接（`repl.ts:1659` 统一 `execution:"local"`）一致。（注：父 spec §9.2 列举的"内建命令"集合与 cli 的 20 条 `REPL_COMMAND_META` 不完全重合——属术语/计数对账，"全部内建 local"的性质结论不受影响，收尾回校 §9.2/§12.2。）
- **hybrid（暂无占用者，保留）**：仅当"agent 必须知道新 runtime 状态（cwd/workspace 等）才能正确推理、且无法从对话历史推断"时才用。本次迁移不新增 hybrid 命令。
- **agent（动态 `/<name>` 技能）**：`SkillCommandSource` 已注册为 `execution:"agent"`（`skill-command-source.ts:62`），dispatcher 对 agent 档直接返回 agent-message、不调 handler。这正是"registry 已是真相源"的现成例证，迁移不动它。

### 5. core/`buildBuiltinCommands`：删除

§5.8 / Step 2 把它定位为"命令目录范例 / 测试 fixture，不作运行时注册源"。但它现在的内容（含 fast/verbose/elevated/history 等 cli 从未实现的命令）与真相严重不符——一份会过时、会误导的平行清单，无论叫不叫 fixture，都违背"真相源唯一"不变量。

**决策：删除** `buildBuiltinCommands` / `registerBuiltinCommands`（`core/src/typeahead/builtin-commands.ts`）。其引用面比"只是测试"更广（见第三部分阶段 C 收尾清单），实施时先 grep、按引用类型分别处置。父 spec §5.8 / Step 2 对它"保留为范例"的定位随之回校（见迁移收尾）。

### 6. 多 target 留缝：声明层 + 执行层都真留缝

命令层下沉 core（阶段 0、不变量 2）后，"多 target 留缝"在声明与执行两层都成立。依赖方向是这里的关键：`CommandDispatcher` 若留在 `@zhixing/cli`，server 想复用就撞依赖方向——cli 依赖 `@zhixing/server`、server 仅依赖 core+ws（且 server 代码注释明写"不依赖 @zhixing/cli"），server 反向复用 cli 的 dispatcher 会成循环依赖。归位 core 从根上消除这道障碍：

- **声明层留缝（早已就绪）**：`ICommandRegistry` / `CommandDef` / `CommandVisibility.targets`（已支持 `cli | gateway | web | wechat | dingtalk`）都在 core、target 无关。
- **执行层留缝（随不变量 2 就绪）**：`CommandDispatcher` 下沉到 core 后（阶段 0），server/gateway 与 cli 装配**同一套**命令层（各自构造 registry + dispatcher、共用同一份 core 实现），各自注册适用于自己 target 的命令与 handler。依赖方向不再是障碍——大家都只依赖 core。

**本次仍不实现 server 命令层**（无现实来源，YAGNI），只把"边界放对位置"：dispatcher 归位 core 是一个 target 无关的解耦边界，即使当下只有 cli 一个使用者也应建好（解耦边界 ≠ 推迟边界内功能）。server 真正需要 `/` 命令时（阶段 D），装配即用、无需任何包迁移。这正是 §4.1 的设计意图落到实处。

---

## 第三部分 · 可执行迁移方案

### 0. 分期原则

- **先"归位"、再"统一"、最后"形态迁移"。** 归位（阶段 0）= 把命令层执行器 `CommandDispatcher` 物理移到 core，纯机械、行为零变化；统一（阶段 A）= 让 registry 成唯一真相源、dispatcher 成唯一执行入口、`/help` 从 registry 派生；形态迁移（阶段 B）= 把命令从桥接形态换成模块化原子注册 + deps 注入契约。三者正交，任何中间态都不出现"`/help` 残缺"或"列了却打不了"。
- 每阶段独立可上线、可验证、可回滚；`tRegistry` 始终是命令全集（不出现"迁移中途某命令两边都没有"的空窗）。
- 每阶段一个清晰的 commit 边界；遵循本仓 develop 工作流（不直接 commit main、统一控 commit）。
- 不破坏现有测试；新范式优先补测试再删旧路径。
- 改 CLI 后 `pnpm cli:build` 再验；动到 `@zhixing/core`（阶段 0）用 `pnpm build` 全量重建。

### 阶段 0 — 归位：命令层执行器下沉 `@zhixing/core`

**目标**：落地不变量 2——把 `CommandDispatcher` 从 cli 移到 core，命令层（registry + dispatcher + 类型）成为 core 完整的一等公民。**行为零变化**，为后续统一与未来多 target 奠定正确的物理基线。

**改动**：
- 把 `packages/cli/src/command-dispatcher.ts` 的 `CommandDispatcher` 类、`DispatchResult` / `CommandDispatcherOptions` 类型移入 `packages/core/src/typeahead/command-dispatcher.ts`，并由 `core/typeahead/index.ts` barrel 导出。
- **解决 `parseCommandDraft` 撞名**：cli dispatcher 内**导出的（`export`）** `parseCommandDraft(rawDraft)`（执行分派用、`command-dispatcher.ts:172`）与 core 已有的 `parseCommandDraft(draft, cursor)`（cursor-aware 参数区解析、补全用、`parse-command-draft.ts:51`）**同名不同义、不可合并**。下沉时把前者重命名（如 `parseCommandInvocation`）或内联进 `dispatch`，避免 barrel 重复导出冲突。注意它是 `export` 符号、已被 `command-dispatcher.test.ts:19` 跨文件 import 消费，重命名属对导出符号的 breaking change，须同步所有外部 import（当前仅 test:19 一处）。
- **删除 `CommandDef.handler` 字段**（`types.ts:329`，Phase 1 遗留、dispatcher 从不消费），并清 `core/typeahead/index.ts` 对它的相关注释。落实不变量 2 的"纯元数据"。**同步删除 `skill-command-source.test.ts:74` 的 `expect(c.handler).toBeUndefined()` 断言、并调整其 it 标题（去掉"无 handler"措辞）**——删字段后 `CommandDef` 已无该属性，strict TS 下访问 `c.handler` 会 TS2339 编译断裂、违反本阶段"`pnpm build` 全绿"验收；skill"不带本地执行入口"的语义已由同测试 `expect(c.execution).toBe("agent")` 覆盖，无需新增替代断言。
- **改 import 面**（执行前以 `grep -n "import.*CommandDispatcher" packages` 复核、勿凭印象计数）：全 packages 命中 12 文件 = **6 个非测试源** + 4 测试 + barrel + 定义自身 `command-dispatcher.ts`（`input-buffer.ts:10` 仅 JSDoc 提及、无需改）。6 个非测试源 = `repl.ts:67`、`typeahead-input.ts:67-69`、`commands/task-commands.ts:25`、`skills/manager-command.ts:16`、`skills/admission-command.ts:28`、`skills/authoring-command.ts:39`（后三者把 `CommandDispatcher` 作 deps 字段类型，虽是 `import type` 同样须改源路径）从 `./command-dispatcher.js` 改为 `@zhixing/core`；4 测试 `command-dispatcher.test.ts`、`task-commands.test.ts:16`、`skill-command-source.test.ts:13`、`typeahead-input.test.ts:34` 同步；`command-dispatcher.test.ts` 整体移入 core 的 `__tests__/`（dispatcher 单测随实现入 core）。

**验收**：`pnpm build` 全绿；现有所有 dispatcher 相关测试零回归；cli 行为与归位前逐项一致（命令执行、补全、legacy 路径均不变）。

**commit 边界**：1 个 commit（纯归位，不掺统一改动）。

### 阶段 A — 统一：命令层无条件化 + 执行归一 + /help 派生 + 环境约束

**目标**：达成真相源唯一、执行唯一、消费派生、visibility 不变量（除"原子绑定"留待阶段 B）。命令仍是现有桥接形态（`REPL_COMMAND_META` + `slashCommands` 暂留作注册来源），只动"在哪构建、谁执行、谁消费"。

**按回归轴拆为三个独立 commit（解耦回归面）：**

- **A1 · 命令层无条件化**：把 `tRegistry`（`DefaultCommandRegistry`）+ `CommandDispatcher`（已在 core，此处只是构造点）构造、`REPL_COMMAND_META` 桥接循环、task/skill/动态源注册、`refresh()`，连同命令 args 元数据（`argsByName` 及 `conversationArgProvider` / `workSceneArgProvider` / `trustRuleArgProvider`——它们是 `CommandDef.args`、属命令层，**不是**补全 UI）从 `if (useTypeahead)` 块提升到顶层无条件执行。typeahead broker + 补全 providers + panel + InputController 留块内（交互层依 chrome）。**此 commit 后无 chrome 下 alt-screen 命令仍按现状"注册即可见"，与现状等价、零新过滤风险。**

- **A2 · 执行归一 + /help 派生 + 环境过滤**：
  - legacy 输入路径（`repl.ts:2063` `rl.question` 分支）`/` 开头改调 `dispatcher.dispatch(rawDraft, getRuntime())`，与 typeahead 路径共用同一段 `DispatchResult` 处理。删除 `runLegacyCommand` + `slashCommands` fallthrough（`slashCommands` 字典本身暂留作桥接 handler 来源，随阶段 B 删）。**同时把共用处理段的 `unknown`/`missing-handler` 分支改为就地打印"未知命令"提示**（原落点在被删的 `runLegacyCommand`，见不变量 5）。此后所有命令在 legacy 终端可达——**症状 2 修复**；顺带把失真注释 `repl.ts:2032` 清理。
  - **环境过滤必须与 /help 派生同 commit、不可后置**：`getRuntime()`（`repl.ts:1755` 单点、块外顶层、补全与 dispatcher 执行共用）的 `features` 由 `{}` 改为 `chrome: capability.ok`（改 `repl.ts:1760`），并给全部 alt-screen 命令（skills 三件套 / config / mcp）挂 `visibility.predicate` 读 `features.chrome`。理由：A1 已把 skills 三件套无条件注册进 registry，若 `/help` 改读 `registry.list(ctx)` 时 visibility 尚未挂，no-chrome（非 TTY）下 `/help` 会列出 `/skills` 等、但其 handler 因 `isTTY=false`（`manager-screen.ts` `if(!isTTY) return`）静默 no-op，正是 §0 禁止的"列了打不了"。两者同 commit 落地，则 `list(ctx)` 当场按 `features.chrome` 过滤，中间态不破。
  - `/help` handler 改遍历 `registry.list(ctx)`，按 `CommandDef.category` 分组（categoryOrder = session/info/tools/config/plugin；category→展示标签映射收敛为单一来源、取代 `REPL_COMMAND_CATEGORY_LABELS`），命令名 `/${cmd.name}`；`list` 自动剔 hidden + visibility。动态 `/<name>` 技能（plugin 类）聚合一行汇总置末尾——`/help` 是命令地图、不是技能浏览器。

- **A3 · requireChrome 兜底 + 死代码清理**：A2 已让 `list(ctx)` 在 no-chrome 下不显示 alt-screen 命令；A3 只处理"硬打名字"的兜底——建 `requireChrome(screen, cliWriter)` helper，给 alt-screen 命令 handler 入口加它，无 chrome 时友好提示而非崩溃（`dispatcher` 语义不变，仍符合 §9.2）；并清理 config/mcp 的 non-tty 死代码（见不变量 7）。此 commit 的回归面 = 硬打有提示不崩 / 退屏 `reassertCursorHidden` 不回归 / non-tty 死代码处置，与 A2 回归面隔离验收。

**验收**：A1 后两模式 registry 都全集；A2 后 `ZHIXING_INPUT_TYPEAHEAD=legacy`（有 chrome）下 `/skills` `/help` `/model` 全可执行、硬打不存在的命令两模式都打印"未知命令"不静默吞、`/help` 从 registry 列全，**且 no-chrome（非 TTY）下 `/help` 已不含 alt-screen 命令**（环境过滤与 /help 同 commit，无"列了打不了"中间态）；A3 后无 chrome 硬打 alt-screen 命令有 `requireChrome` 提示不崩、non-tty 死代码已清；全程现有测试零回归。

### 阶段 B — 形态迁移：桥接 → 模块化原子注册 + deps 注入契约

**目标**：落地不变量 3（原子绑定）与不变量 4（deps 注入契约）——把 20 条核心命令从 `REPL_COMMAND_META` + `slashCommands` + `legacyKey` 关联，迁成 §3 的按域 `registerXxxCommands(deps)`。对 registry/dispatcher 的内容透明，阶段 A 已统一的 `/help` 与执行**不受影响**。

**逐条迁移动作**：handler 业务逻辑零改、闭包依赖改 deps 字段（依赖矩阵见 §3，重命令以 handler 体为准逐条核对）；dep 获取机制按不变量 4 调整；`execution:"local"`；全部元数据（description/category/aliases/args，config/mcp 的 visibility 从桥接注入转成 `CommandDef` 字段）落进 `CommandDef`；从 `REPL_COMMAND_META` 移除该条（桥接循环不再注册它，避免与模块化注册 **id 冲突**——同 id 重复 register 抛错）。按批推进：info → session → mode(work exit) → config（依赖由轻到重）。

- **带 args 的命令（resume/work/trust）**：其 `ArgChoiceProvider` 在所属模块内构造，状态依赖随该模块 deps 注入（与 handler 同源），args schema 落进 `CommandDef.args`；阶段 A 提到顶层的 `argsByName` 随这三条迁完而消解。
- **`/trust` 是 deps 注入契约的标杆案例（须刻意偏离"零改"去修）**：现行 `trustRuleArgProvider` 在构造期 capture 了 `session.runtime.securityPipeline` 快照（`repl.ts:1634`），是不变量 4 描述的条件性 latent staleness bug。本条迁移**须**把 `securityPipeline` 改为 deps 内的 getter（`() => session.runtime.securityPipeline`）、在 `list()` 调用时读取（与 `/security` handler 同款）——这是结构性修复（消除 capture-快照脆弱性），刻意偏离本阶段"handler 业务逻辑零改"基调，**不是机械原样搬迁**。`resume/work` 的 `convRepo`/`workSceneRegistry` 是否同样需 getter，各依其字段在 reload 时是否被 swap 判定（跨 reload 单例则无需，见 `session.ts` getter）。

**收尾**：全部迁完后删除 `REPL_COMMAND_META`、`REPL_COMMAND_CATEGORY_LABELS`、`slashCommands`、`buildSlashCommands`、桥接循环；清理 `repl.ts:212` / `1488` / `323` 等失真注释。

**验收**：每批迁完该批命令行为不变；`/trust` 的 getter 改造在常规 reload（改模型/凭证）下候选**无可观测差异**（属预期、不可据此判修复无效），仅当工作区路径随 reload 变化（workscene 切换 / 改 `config.workspace`）时新旧候选才不同；registry 全集、`/help` 列表不变；收尾后静态表/字典/桥接全删。

**commit 边界**：每批 1 个 commit + 收尾删除 1 个。

### 阶段 C — 删除 core/`buildBuiltinCommands`

**目标**：消除第三个（废弃）声明源。

**改动**：grep 确认引用（当前消费方：测试 + `core/typeahead/index.ts` barrel re-export + 手动 harness，repl.ts 运行时已不用），按类型分别处置：
1. **删 barrel re-export**：`core/typeahead/index.ts:60-64` 的 `// ── Builtin 命令 ──` 导出块（`buildBuiltinCommands` / `registerBuiltinCommands`）——否则删源文件会断 `@zhixing/core` 公开 API、barrel 编译失败。
2. **改手动 harness**：`packages/cli/src/tui/__manual__/typeahead-manual.mjs`（`:25` import、`:44` 调用）改为就近构造样例命令或改用真实 `registerXxxCommands`；同步其头注释。
3. **测试逐文件处置**（非"一个样例"——多个测试硬断言具体命令的 name/category/hidden/alias/execution）：(a) 仅借 builtin 作多形态 fixture 的测试（command-provider / ghost-text / command-dispatcher / typeahead-input）就近构造覆盖所用形态的本地 fixture（至少含 local/hybrid/hidden/alias/必填arg/可选arg，及供 ghost 前缀的 history-like）使原断言成立；(b) `registry.test.ts:390-435` 是"对被删符号本身的测试"，**直接删除该 describe 块**（不存在"就近构造"的等价物）。
4. 删除 `builtin-commands.ts`。

**验收**：barrel 编译通过、`@zhixing/core` 公开 API 不含 builtin 导出；harness 可跑；各 fixture 断言绿、`registry.test.ts` 该 describe 已删；全仓零引用 `buildBuiltinCommands`/`registerBuiltinCommands`。

**commit 边界**：1 个 commit。

### （未来，不在本次）阶段 D — server 复用 registry + dispatcher 支持渠道命令

阶段 0 已把命令层归位 core、依赖方向障碍消除；有现实来源（渠道需要 `/` 命令）时，server 装配同一套 registry + dispatcher、注册 gateway target 命令即可，无需任何包迁移。届时另起 spec 实施。

---

## 第四部分 · 风险与待决项

### 风险

1. **dispatcher 下沉（阶段 0）的引用面**：改 import 面是 **6 非测试源 + 4 测试 + barrel**（执行前 `grep -n "import.*CommandDispatcher" packages` 复核、勿凭印象计数——skills 三件套 `manager`/`admission`/`authoring-command.ts` 易漏），叠加 `parseCommandDraft` 撞名重命名（含同步 `command-dispatcher.test.ts:19`）+ 删 `CommandDef.handler`（含同步 `skill-command-source.test.ts:74` 断言）。机械可控，但须 `pnpm build` 全量验、确认行为零变化后再进阶段 A。
2. **handler 闭包依赖迁移（阶段 B 主要工作量）**：20 条 handler 现靠闭包捕获，迁移改为 deps 注入。业务逻辑零改、只搬依赖获取方式；重命令（resume 90 行、clear/compact/work/config/mcp）逐条核对 handler 体（依赖矩阵是聚合视图、非完整清单）。`/trust` 是唯一须刻意偏离"零改"去修的（不变量 4）。
3. **alt-screen 命令的 chrome 依赖（阶段 A3）**：visibility 让无 chrome 时不显示，requireChrome 让硬打给友好提示。验收须覆盖"无 chrome 时 config/mcp/skills 不出现、硬打有提示不崩、退屏 `reassertCursorHidden` 不回归、config·mcp non-tty 死代码已处置"。注意 config/mcp 现状本就不崩（有 non-tty 优雅分支），此为门禁收敛非崩溃修复。
4. **legacy 兜底路径汇入 dispatcher 的 runtime 构造（阶段 A2）**：dispatch 需 `RuntimeContext`；legacy 路径参照 typeahead 路径的 `getRuntime()`（单点、共用），正确构造。
5. **测试迁移**：legacy handler 现有测试改挂到新模块注册点；builtin 相关测试按阶段 C 逐文件处置；删 core 类型字段（如 `CommandDef.handler`）须同步全仓对该字段的硬断言（`skill-command-source.test.ts:74` 即不在 builtin 测试集内、易被 `grep buildBuiltinCommands` 漏掉，归阶段 0 处置）；保证每阶段绿。

### 迁移收尾（非待决，迁移完成后执行）

- **回校父 spec input-typeahead.md**：
  - §4.1 三层分离图补上 `CommandDispatcher`（命令层执行器，与 `CommandRegistry` 同处 core 层）。
  - §5.8 关于 `REPL_COMMANDS` 表的描述更新为"模块化原子注册"；Step 2 对 `buildBuiltinCommands` 的"保留为范例"定位删除。
  - §9.2 的 `dispatchAccepted` 伪代码回校为实际形态：handler 走 dispatcher 持有的 `Map<commandId, CommandHandler>`、ctx 为 target 无关的 `{ args, rawInput, runtime: RuntimeContext }`（而非伪代码的 `cmd.handler({ args, repl, session })`）；execution 归属表的"内建命令"集合与 cli 实际 20 条对齐。
- 本文件末尾追加各阶段 commit 的 checklist 勾选，作为活文档追踪。

> 本文档内已无需评审者决断的架构选项——上述全部依据"单一真相源 / 命令层 target 无关 / 避免架构债务（而非最小变更）"原则定稿。唯一会改变方向的是"渠道是否需要 `/` 命令"这一**需求**（决定阶段 D 何时启动）；在该需求出现前，本方案不实现 server 命令层、只把命令层的解耦边界放到正确的物理位置（core）。
