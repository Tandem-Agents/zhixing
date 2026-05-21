# REPL 内修改基础配置与配置热重载 — 问题对齐记录

> 触发于 2026-05-03 配置编辑器抽离完成后的功能延伸需求。本文件是"对齐过程的脱过程版"——保留问题描述、各阶段对齐结果、设计落地引用，去掉对话原文。最终架构以下列文档为权威：
>
> - [runtime-session-hot-reload.md](../specifications/runtime-session-hot-reload.md)

## 问题描述

**现象**：[`credentials-and-onboarding.md`](../specifications/credentials-and-onboarding.md) 落地后，`runConfigEditor` 模块（5 级面板，参数化注入 `stdin/stdout/writers/sections/title/header`）仅在 bootstrap 阶段、首次启动且必要字段缺失时被调用。bootstrap 走完后下次启动直接跳过编辑器——用户进入 REPL 后**没有入口主动修改基础配置**（API Key、模型、消息通道等）。

**直接原因**：当前架构有"基础配置编辑器"但**没有运行期修改入口**；同时如果加入运行期修改，立即面临"修改完后什么时候生效"的产品 + 架构双重决策——agent runtime 装配期 closure capture 的字段范围广（`proxy` / `roles.main provider+model` / `roles.secondary` / `systemPrompt` / `modelBudgetInfo` 等），任何选型都涉及 orchestrator 层架构边界。

**本质**：两个问题耦合：

1. **产品形态问题**：用户视角下"修改配置"应该几个入口、改完是否要重启
2. **架构层问题**：满足产品期望（立即生效）的运行期资源更新如何在不引入架构债的前提下落地

两个问题必须分阶段对齐——先产品方向锁定，再架构方向选型。

## 解决方向（一句话）

REPL 内 `/config` 单一主入口 + blue-green runtime swap 模式 hot reload + 用 `RuntimeSession` 抽象聚合协同生命周期资源。**具体形态分阶段对齐**。

---

## Phase 1（产品方向：用户视角需求）

### Q1：用户需要几个入口？

用户进入 agent 交互模式后想修改配置时，提供几个入口？

- **A**：多入口（基础配置 / 偏好配置 分开两个 slash）
- **B**：单一主入口（`/config` 进入完整编辑器）
- **C**：主入口 + 高频快捷直达（`/config` + `/model` + ...）

**助理倾向**：B + 未来视证据加 C 的有限快捷。理由：

- 用户**不区分**"基础配置 / 偏好配置"——这是产品内部实现概念，不应暴露给用户
- 行业一致：1 主入口 + 极少数高频快捷（Claude Code / Aider / Cursor / VSCode / gh CLI）；**没有**成熟产品按内部分类拆入口
- 命令空间是稀缺资源——REPL 已有十几个 slash，每多一个都是用户记忆负担 + "到底用哪个改"的认知摩擦
- panel stack 已支持 deep link（未来扩展 `runConfigEditor(ctx, { initialPath })` 即可），不构成"现在不加就难加"的压力

---

### Q2：改完后立即生效还是重启？

用户修改完配置（特别是模型）后期望什么？

- **A**：立即生效（hot reload）——下条消息使用新配置
- **B**：重启生效——提示用户回车快速重启 + auto-resume 对话
- **C**：分层——channel 立即生效，模型重启生效

**助理倾向**：A。理由：

- 行业强烈一致：改配置立即生效（IntelliJ / VSCode / Cursor / Claude Code / Aider / gh CLI / npm / git）；重启被普遍视为退步 UX
- 用户期望排序：零感知立即生效 > "下条消息生效"提示 > 重启
- B 的退步 UX 来自"要求用户操作"，不是"重建"本身——后续 Phase 中会发现"silent swap"等价于 A 的体验、内部用重建实现
- C 的部分性体验（"改 channel 立即、改 model 重启"）造成用户认知负担——不一致心智差于全 A 或全 B

---

### Phase 1 对齐结果

1. **入口数量：单一主入口 `/config`**

   - 任何配置都从 `/config` 进——包括未来加的偏好（主题、字号、回显等）
   - 内部 5 级面板已能覆盖所有字段访问路径
   - **未来视真实高频证据**再加 `/model` 等快捷直达，不预先做
   - 命令空间稀缺，命令膨胀是反优化

2. **改完立即生效（hot reload），永不要求用户主动重启**

   - **主路**：高频字段（provider / model / channel）改完**下条消息生效**
   - **Escape hatch**：低频字段（workspace / tools / 子 agent 配置）改完显示"已保存，下次启动时生效"——**用户当下无需做任何事**，自然启动时新值生效。这是延迟生效，不是用户重启
   - **绝不**引入"用户主动重启"作为常规路径

3. **明确不做**

   - ❌ 基础配置 / 偏好配置分两个 slash（泄漏内部概念）
   - ❌ 为每个字段都给快捷（`/apikey` / `/provider` / `/channel` ...）（命令膨胀）
   - ❌ CLI 子命令 `zhixing config`（不可发现、需退出 REPL）
   - ❌ 局部区域切换渲染（terminal 无窗口概念，raw mode 必须独占 stdin，仅 alt screen 可行）
   - ❌ `/restart` 独立命令（重启是退步 UX）

4. **关键定性**：用户视角下"重启 vs 立即生效"无真实取舍——决策难点已转移到"承担 hot reload 的架构代价"，进入 Phase 2

---

## Phase 2（架构方向：实施形态选型）

### Q3：hot reload 的实施形态？

agent runtime 装配期 closure capture 字段广（proxy 跨包、roles 多处、systemPrompt 装配期 build、modelBudgetInfo 装配期 + estimator 校准）。如何在不破坏 immutable runtime 契约的前提下让配置改动反映到运行中的 runtime？

- **A**：内部 mutable refs + getters——把装配期 capture 改成 getter，run() 时读最新值
- **B**：in-process 快速重启 + auto-resume——`/config` 完成后弹"回车重启"提示
- **C**：blue-green swap——reload = `create new runtime` + `replace ref` + `dispose old`，runtime 仍为不可变值

**助理倾向**：C。理由：

- A 代价：跨包 API 改动（`tools-builtin/web-fetch` proxy 改 getter）+ `systemPrompt` lazy build with cache 失效逻辑 + `modelBudgetInfo` 手动 reset estimator + immutable→mutable 多组件 sync 一致性 = 4 条真实债
- B 代价：要求用户敲回车 = 退步 UX（行业强烈一致认为是 regression）
- C 本质：`create new` + `replace ref` + `dispose old`，无 in-place mutation；runtime 仍不可变；同行业做法（VSCode "reload window"、IntelliJ 设置 invalidate）
- B 的退步 UX 来自"要求用户操作"，**不是"重建"本身**。C = silent swap = 用户无感知 + 装配单次 < 100ms = 体验等价于 A

**关键发现**：现有 `repl.ts:646-771` 已有 mutable closure getter 模式（解开 `scheduleTool` / `runAgentTurn` / `SchedulerProvider` 循环依赖的副产品）。swap 时替换变量，所有现有 closure 自动响应——C 不引入新概念，"mutable runtime 契约"是伪代价。

---

### Q4：协同生命周期资源如何聚合？

`agentRuntime` / `scheduler` / `deliveryStack` / `channels` / `permissionStore` 是协同生命周期的资源——一组要一起 create、一起 dispose、一起 reload。当前散落在 `repl.ts`（1554 行 god module）顶层 const/let。reload 设计如何避免加重 god module 债？

- **A**：在 `repl.ts` 加一个 `reloadRuntime()` 函数——最小变更，资源生命周期仍散落
- **B**：抽 `RuntimeSession` 类——聚合所有协同资源到独立 owner，`repl.ts` 减负

**助理倾向**：B。理由：

- A 是补丁修复——god module 加重 + 资源散落延续 = **加重已有架构债**
- B 是消除已有债的抽象——同行业模式（VSCode `ExtensionHost`、IntelliJ `ProjectService`）
- B 的边界清晰：session 只管资源生命周期；REPL 管业务流程（用户输入、turn 状态、对话历史）
- B 测试性更好：mock RuntimeSession 即可测 REPL；session 内部独立单测
- 用户原则"不追求最小变更、不修修补补、不妥协"——B 是正确选择

---

### Q5：PermissionStore 跨 swap 怎么处理？

`PermissionStore`（`create-agent-runtime.ts:347-349`）当前由 `createAgentRuntime` 内部 `new`。三作用域（session 内存 / workspace 磁盘 / global 磁盘）。swap 重建会丢什么？

**调研验证**（`packages/core/src/security/permission-store.ts:188`）：
- session scope 是**纯内存**——swap 重建会丢
- workspace / global scope 写磁盘——新 store 懒加载自动恢复
- 用户的"本次会话允许"语义对应 session scope——丢失意味着用户每次改配置都要重新点"始终允许"，UX 灾难

**对齐**：

- `PermissionStore` 是**会话级状态**——归属应该是 session 而非 runtime
- `RuntimeSession.create` 时 `new PermissionStore` 一次
- `createAgentRuntime` 通过 `CreateAgentRuntimeOptions.permissionStore?` 接收注入——**optional 字段，向后兼容**
- 不传 → 内部 new（现状）；传 → 用注入实例（hot reload 路径）
- 这不是"妥协 API"，是**修正归属**——本来就该是 session 级单例，runtime 内部 new 是错的归属

---

### Q6：dispose 与 in-flight turn 等待的边界？

reload 触发时如果有 turn 在跑（agent 正在响应），怎么处理？dispose 旧 scheduler / deliveryStack / channels 顺序如何保证不出 use-after-dispose？

**助理草拟**：

- **In-flight 等待边界**：是 `session.reload()` 内部 await `state.activeTurnPromise`？还是调用方（REPL）先 await 再调 reload？
- **Dispose 顺序**：scheduler 持有 delivery ref，反序会 use-after-dispose——必须有顺序硬约束
- **`Scheduler.stop` 阻塞**：`stop()` 是 graceful 阻塞 + `shutdownTimeoutMs` 超时（验证自 `scheduler.ts:119`）——可能阻塞用户几秒到 timeout

**对齐**：

1. **In-flight 等待是调用方语义，不是 session 内嵌**：

   - REPL 状态机暴露 `state.activeTurnPromise: Promise<RunResult> | null`
   - REPL 在调 `session.reload()` **之前**先 `await state.activeTurnPromise`（如非 null）
   - session 边界清晰——只管资源生命周期，不读 REPL state、不感知 turn 状态
   - 因为 `/config` 编辑器模态接管 stdin，编辑期间用户无法触发新 turn——竞态窗口仅限"编辑前已 in-flight 的 turn"

2. **Dispose 顺序硬约束**：

   - 旧 `Scheduler.stop()` → 旧 `deliveryStack.stop()`（仅当重建了）→ 旧 `channels.dispose()`（仅当重建了）
   - 旧 `agentRuntime` 无 dispose 接口——内部全 in-memory（securityPipeline / boundaryRegistry / turnContextInjector / memoryStore / estimator），replace ref 后自然 GC
   - 反序会 use-after-dispose（scheduler 持有 delivery ref）

3. **swap 后后台 dispose**：

   - 步骤 6 替换 instance fields 完成后，新资源已全活跃（所有 closure getter 已指向新实例）
   - reload Promise 在此点 resolve，透明性反馈立即显示
   - 旧资源 dispose 走背景，单步失败 warn log 不阻塞用户
   - `Scheduler.stop` 内置 `shutdownTimeoutMs` 超时兜底，不会永久卡

---

### Phase 2 对齐结果

1. **选型 blue-green swap**（不是内部 mutable refs）

   - reload = `create new` + `replace ref` + `dispose old`
   - runtime 仍不可变
   - 复用 `repl.ts:646-771` 已有的 mutable closure getter 模式——swap 时替换变量，closure 自动响应
   - 不引入"mutable runtime 契约"新概念
   - 跨包 API 零侵入（除 `permissionStore?` optional）

2. **抽 `RuntimeSession` 类聚合协同资源**（不是 god module 加函数）

   - 位置 `packages/cli/src/runtime/session.ts`（新增）
   - 封装 `agentRuntime` / `scheduler` / `deliveryStack` / `channels` / `permissionStore`
   - 接口：`create` / `reload` / `dispose` / `runtime` getter / `attachConfirmationRenderer`
   - 不封装 renderer / convRepo / state.messages（REPL 顶层资源，跨 reload 保留）
   - 消除 `repl.ts` god module 债，同行业模式

3. **`PermissionStore` 归属修正**

   - 从 `createAgentRuntime` 内部 new 抽到 `RuntimeSession` 持有
   - `CreateAgentRuntimeOptions` 加 optional `permissionStore?`——向后兼容
   - session scope 跨 reload 完整保留——避免 UX 灾难

4. **dispose 顺序硬约束 + 后台 dispose**

   - scheduler stop → deliveryStack stop（如重建）→ channels dispose（如重建）→ agentRuntime 自然 GC
   - 步骤 6 完成后新资源活跃，reload Promise resolve，透明性反馈立即显示
   - 旧资源 dispose 走背景，不阻塞用户

5. **In-flight turn 等待是调用方语义**

   - REPL 状态机暴露 `activeTurnPromise`
   - REPL 在调 `session.reload()` 之前先 await
   - session 不读 REPL state，边界清晰

6. **`AgentRuntime` 无 dispose 接口**——内部全 in-memory，不增加冗余接口

7. **Diff 决策避免无谓重建**

   - channel 配置不变 → 复用旧 channels（避免 telegram 等长连接闪断 1-2 秒）
   - agent 字段不变 → 不重建 agentRuntime
   - 重建 agentRuntime 必须重建 scheduler（保持新旧"同代"，简化 dispose 顺序）

8. **同时修复发现的前置 sub-bugs**（不论 hot reload 路径如何都要修）

   - `/resume` `/new` 漏 `convRepo.touch()`——切换/新建后 `lastActiveAt` 未更新，重启 `findLatest` 选错对话
   - `/exit` 半吊子 cleanup——只 `scheduler.stop()` + `process.exit(0)`，漏 `deliveryStack.stop()` / `channels.dispose()`；改走 `rl.close()` 让 close 监听器统一清理

9. **零原功能回归风险**——设计是严格的 superset

   - 所有"无 reload"路径行为完全等于现状
   - sub-bugs 修复是行为变更但更正确
   - 新增 reload 能力对原功能向上兼容

---

## 设计落地

最终架构与执行规格：

- [runtime-session-hot-reload.md](../specifications/runtime-session-hot-reload.md) —— RuntimeSession 接口、reload 流程、diff 算法、事务性回滚、PermissionStore 归属、sub-bug 修复、分阶段迁移路径
