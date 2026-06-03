# ADR-009: 命令系统统一（单一真相源 + 命令层归位 core）

> **状态**: 接受 | **日期**: 2026-06-03

## 背景

CLI 命令系统长期是"半程实现"的架构债：父 spec input-typeahead.md 已把目标架构写定（§4.1 命令层在 core、§5.8 声明与 handler 原子绑定、§9.2 统一执行入口），但实现只走到一半，留下三处分裂：

- **命令真相源被复制成三份且互不一致**：① core `buildBuiltinCommands()`（废弃、含 cli 从未实现的命令）；② cli `REPL_COMMAND_META` 数组 + `slashCommands` 字典（元数据与 handler 靠 `legacyKey` 字符串关联）；③ 直接注册 registry（task / skill / 动态 `/<name>`）。三份从不重合。
- **执行分裂成两轨**：typeahead 路径走 `CommandDispatcher`，legacy 输入路径（`rl.question`）走 `runLegacyCommand` 只查 `slashCommands` → 现代命令在 legacy 路径完全不可达。
- **命令层被劈成两半**：`ICommandRegistry` / `CommandDef` 在 `@zhixing/core`，但执行器 `CommandDispatcher` 错位在 `@zhixing/cli`，违背 §4.1 把命令层整体画在 core 的分层意图，也让 server / 渠道想复用就撞依赖方向。

表层症状（`/help` 看不到 skill/task、飞书里 `/skills` 不被当命令）都是这三处分裂的投影；补丁式改 `/help` 只擦掉最表层一个。

根因模式与项目反复出现的失配同构：**"声明面领先生效面"**——命令在 registry 的声明领先 `/help` 的消费（仍读旧静态表）、`CommandDef.handler` 字段声明了却从不被 dispatcher 消费。与 ADR-006 安全系统模块审计的同名根因、confirmation 的"三投影点"同构，是可迁移的诊断信号。

## 决策

命令层（`ICommandRegistry` + `CommandDispatcher` + `CommandDef` 类型族）整体物理归位 `@zhixing/core`，target 无关 + UI 无关；声明与 handler 在同一处原子注册；所有执行汇入一个 `CommandDispatcher`；所有"列命令"的消费方都从 `registry.list(ctx)` 派生。三声明源归一、两执行路径归一、命令层不再被劈成两半。

落地为 **7 条不变量**（评判任何实现"是否还在债里"的硬标尺）：

1. **真相源唯一**：`DefaultCommandRegistry` 是命令全集唯一来源；删除 `REPL_COMMAND_META` / `slashCommands` / `buildBuiltinCommands`。
2. **命令层在 core、target/UI 无关**：registry / dispatcher / CommandDef 全在 `@zhixing/core/typeahead`；`CommandDef` 是可序列化纯元数据（删除从不被消费的 `handler` 字段）。
3. **声明与 handler 原子绑定**：每条命令在一次 `registerXxxCommands(deps)` 里同时 `registry.register(def)` + `dispatcher.registerHandler(id, handler)`；handler 走 dispatcher 的 `Map<commandId, handler>`、不进 CommandDef（handler 是带 target 本地 deps 的副作用闭包，塞进会破坏纯元数据）。
4. **deps 注入契约**：随 `RuntimeSession.reload` swap 的 runtime 状态（如 `securityPipeline`）一律以 getter thunk 注入、调用时刻求值；禁止构造期 capture 实例快照。
5. **命令层无条件构建、执行路径唯一**：命令层在 startRepl 顶层无条件构建（与终端能力无关）；交互层（输入采集 + 渲染）才依 chrome 分叉；`dispatcher.dispatch(rawDraft, runtime)` 是唯一执行入口。
6. **消费派生唯一**：`/help`、补全 dropdown、未来任何前端命令面板都从 `registry.list(ctx)` 派生。
7. **环境约束用 visibility 表达、真相源恒全集**：需 chrome 的命令（config / mcp / skills…）仍无条件注册，由 `CommandDef.visibility.predicate` 读 `RuntimeContext.features.chrome` 过滤；handler 入口 `requireChrome` 兜底"硬打名字"。

**补充总则（target 无关的命令行为归属）**：命令 handler 是 target 无关 core 能力之上的**薄前端**——职责限于"调用 core 能力 + 为本 target 渲染"，业务逻辑与可达性不属于它。由此：① 真正的行为（list / revoke / 切换等）必须落在 core 的 target 无关能力上，各 target（cli / server / 渠道）各写一层薄前端复用同一能力；② 行为不得困在某个 target 的交互回调里（如 cli typeahead 的 `onCandidateDelete`），否则该功能只对一种接入方式可达，违背"功能 target 无关、cli 只是接入方式之一"。inline 副作用（删除 / 改名 / 撤销）尤其要经 core 能力 + 命令层可达，交互手势只是触发器之一。

> 首个落地：`/trust` 的 list / revoke 曾整个困在 cli typeahead（noop handler + arg provider + `onCandidateDelete`），非 typeahead 模式完全不可达。改造为 core 能力（`listUserTrustRules` + `IPermissionStore.revoke`）+ cli 薄前端（命令行 `/trust` 列表、`/trust revoke <id>`）+ typeahead 面板降级为增强，所有模式与未来渠道均可达。`/resume` `/work` 的 inline 删除 / 改名共享同模式，但有 handler 兜底（不急），列为后续。

## 依据

- 父 spec [input-typeahead.md](../../specifications/input-typeahead.md) §4.1 / §5.8 / §9.2 早已定下目标架构——本决策是"贯彻已定设计到终点"，非新设计。
- 模块化原子注册范式由 cli 既有的 `registerTaskCommands` / `registerSkillsCommand` 验证过，是 §5.8 精神（声明与 handler 同源）的正确落地；`REPL_COMMAND_META` + `legacyKey` 反而踩进 §5.8 批判的"绑定靠字符串、易漂移"。
- 根因模式呼应 [ADR-006 安全系统架构](006-security-system-architecture.md) 模块审计中的"声明面领先生效面"。

## 考虑过的替代方案

### A：只修 `/help` 读 registry

- 优势：一行改动，擦掉用户最初报的症状。
- 未采用：只擦最表层一个投影；legacy 不可达、命令层错位、消费分裂原封不动——治标不治本。

### B：dispatcher 留在 cli，仅统一真相源

- 优势：不动 core，改动面小。
- 未采用：命令层仍被劈两半，server / 渠道复用撞依赖方向（cli→server 单向，反向成环）；§4.1 分层意图无法落地。解耦边界放错物理位置本身就是债。

### C：把 handler 塞进 `CommandDef`

- 优势：声明与执行在一个对象里，看似最"原子"。
- 未采用：handler 是带 target 本地 deps 的副作用闭包，塞进会破坏 CommandDef"可序列化纯元数据"——而纯元数据正是多 target 派生的物理地基。正解是元数据共享、handler 各 target 本地注册（不变量 3）。

## 影响

### 受影响的设计文档

| 文档 | 变更 |
|------|------|
| [input-typeahead.md](../../specifications/input-typeahead.md) | §4.1 图补 `CommandDispatcher`、§5.8 改模块化原子注册、§9.2 伪代码改 dispatcher Map + `RuntimeContext`（已回校） |
| [命令系统统一迁移记录](../../migrations/command-system-unification.md) | 完整债务诊断 + 10 步迁移方案 + 执行 journal（本 ADR 的详细出处） |
| [mcp-host.md](../../specifications/mcp-host.md) §4.5 | `/mcp` 注册复用面更新为 registry + dispatcher（均在 core） |

### 积极影响

- 命令层成为 core 一等公民：cli / server / 未来渠道装配**同一套**，多 target 留缝在声明与执行两层都真。
- 结构上杜绝幽灵命令（声明无 handler）与盲视命令（有 handler 无声明）。
- `/help` 自动全、自动尊重 `hidden` 与 `visibility`。

### 代价 / 约束

- `CommandDef` 不得持有 handler 或任何 UI 闭包（纯元数据约束）。
- runtime-mutable deps 必须 getter 注入（不变量 4），否则 reload 后行为陈旧。
- 需 chrome 的命令必须挂 `visibility.predicate` + `requireChrome` 双重处理。

### 实施

9 个 commit 落地（`6881ca5` 下沉 → `07d7ab3` 删 builtin），分四阶段：归位（dispatcher 下沉 core）→ 统一（无条件构建 + 执行归一 + `/help` 派生 + 环境过滤）→ 形态迁移（桥接 → 模块化原子注册 + deps 契约）→ 删废（删 `buildBuiltinCommands`）。完整 journal 见迁移记录文档。**server 复用命令层支持渠道命令（迁移方案的阶段 D）无现实来源，YAGNI 不实现**——届时装配即用、无需任何包迁移。

## 相关决策

- 依赖：[ADR-005 CLI 架构](005-cli-architecture.md)
- 关联：[ADR-006 安全系统架构](006-security-system-architecture.md)（共享"声明面领先生效面"根因模式）
- 启用：未来 server / 渠道 `/` 命令

## 引用

- [命令系统统一迁移记录](../../migrations/command-system-unification.md)（完整诊断 + 方案 + commit journal）
- 父 spec [input-typeahead.md](../../specifications/input-typeahead.md) §4.1 / §5.8 / §9.2
