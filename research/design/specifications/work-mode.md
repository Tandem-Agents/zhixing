# Work Mode 设计

> 基于 [agent-vision.md](../agent-vision.md) Phase 1-4 对齐结果落地。本文档只写目标设计与实施计划。
>
> **范围**:本 spec 仅覆盖 REPL(cli)路径。server 模式的工作模式单独 spec —— 对齐 [runtime-session-hot-reload.md](runtime-session-hot-reload.md) 的边界处理(RuntimeSession 是 cli 专属抽象;server 触发与反馈不同)。

## 总览

工作模式 = 用户进入具体工作场景时,同一对话内运行配置的切换。不是 sub-agent,不是在 main 上原地换模型,而是一个独立的 power AgentRuntime 实例,与 main runtime 在同一 REPL session 内共存、按 active 切换。

vision 焊死的不变量(详见 vision 第 1-5 块):

- **单向阀 by construction**:main 可读各 workscene 记忆;workscene 物理上无法写 main 记忆;workscene 间互不串。靠装配期注入受限 store 实例保证,不靠工具内检查。
- **机制与策略分离**:工作场景的粒度、组织、生命周期由用户决定,系统只提供 接入 / 移除 / 列表 / 切换 机制原语。
- **两入口同源**:agent 工具与用户系统指令共享同一组底层原语。
- **关系层动作必须用户拍板**:接入 / 移除 / 进入,LLM 可提议但不可单方面执行。
- **main 对工作场景记忆是按需只读检索**:不预加载、不推送、不常驻 main 上下文。

**核心架构决策一:agent 访问唯一路径 = `session.runtime`。**

REPL 现状有一处既存 bug:`ReplState.agent` 是创建时刻对 `session.runtime` 的一次性值捕获,而 `.run()` 走 `session.runtime` getter——两条路径。reload 后 getter 换新但 `state.agent` 仍旧引用(`/status` 显示旧模型即此 bug)。workmode 会把它放大为灾难(进入后 16+ 处 `state.agent.xxx` 全指向 main,而 `.run()` 已在 power)。**根治:删除 `ReplState.agent`,REPL 全部 agent 访问(model/providerId/securityPipeline/checkBudget/forceCompact/calibrationFactor/resetConversationState/callText 等)统一走 `session.runtime` getter**,swap / workmode 自动响应。`ConversationRuntimeState`(下文)**不**聚合 agent —— agent 是 runtime 资源归 RuntimeSession,不是 conversation 运行态。配套:个人记忆维护(journal condense 等)仅 main 模式触发(workmode 下 active=power、其记忆域是 workscene,绝不能跑个人 journal —— 单向阀的必然延伸)。

**核心架构决策二:切换 = turn 边界的单一原子事务。**

切换只能发生在 turn 边界、由 REPL 主回路执行的单一原子事务,涵盖全部强耦合状态(runtime overlay + ConversationRuntimeState)。理由由真实代码确定:`session.runtime` 在 turn 内被 `run()` 闭包绑定;ConversationRuntimeState 在 REPL 主回路 turn 边界更新(commitTurn 段)。**绝不能在 turn 内执行切换**(撕裂正在跑的 turn),必须 turn 边界原子完成。这与项目既有 reload(同类整体切换,hot-reload spec 明确"turn 边界、先 await in-flight turn")是同一纪律。

触发源两类,都**只产生切换意图、不执行切换**:LLM 工具(`workmode_enter`/`workmode_exit`,turn 内,`needsPermission: true` 用户拍板后仅 emit 事件)、用户命令(`/enter`/`/exit`,turn 边界)。意图回传走项目权威模式(EventBus 事件 + accumulator + RunResult 字段),REPL 主回路 turn 边界唯一 `applyModeSwitch` 事务消费。

## 核心抽象

### WorkScene(`@zhixing/core/workscene`)

```typescript
interface WorkScene {
  id: string;          // 用户可读稳定 id,创建后不可改;slug
  name: string;        // 可重命名
  workdir?: string;    // optional —— 仅"工作内容涉及本地文件"的场景指定(开发/写作);浏览器/对话/规划类无此属性。创建时绑定,要换换重建
  createdAt: string;
  lastActiveAt: string;
  archived?: boolean;  // 仅 list 默认过滤,不影响 main 能否 query 其记忆
}
```

每个 WorkScene 拥有独立记忆域目录、会话目录、元信息(见持久化布局)。vision "每次进入工作模式是新会话":进入时在该 workscene 的 conversations/ 下新建 conversation,退出后沉积、不带入下次进入。

### WorkSceneRegistry(`@zhixing/core/workscene`)

工作场景登记 CRUD 原语,**唯一**写入入口。

```typescript
interface IWorkSceneRegistry {
  list(opts?: { includeArchived?: boolean }): Promise<WorkScene[]>;
  get(id: string): Promise<WorkScene | null>;
  add(opts: { name: string; workdir?: string }): Promise<WorkScene>;
  remove(id: string, opts?: { purgeData?: boolean }): Promise<void>;
  rename(id: string, name: string): Promise<WorkScene>;
  setArchived(id: string, archived: boolean): Promise<WorkScene>;
  touch(id: string): Promise<void>;
}
```

持久化 `~/.zhixing/workscenes/index.json`(主表)+ 各 workscene meta.json(权威)。并发安全沿用 `ConversationRepository` 的 atomic write + per-id lock(`repository.ts` 的 `metaLocks` 成熟实现,同构复用)。`remove(id, {purgeData:true})` 连带删全部数据;不传仅摘身份、数据留。**归属**:RuntimeSession 持有 Registry 单例,生命周期同 session。

### RuntimeSession 工作模式扩展

```typescript
class RuntimeSession {
  private mainRuntime!: AgentRuntime;          // 常驻,reload blue-green swap(现有不变)
  private workScene?: { sceneId: string; runtime: AgentRuntime };
  private readonly workSceneRegistry: IWorkSceneRegistry;

  get runtime(): AgentRuntime {                // REPL 唯一 agent 访问点
    return this.workScene?.runtime ?? this.mainRuntime;
  }
  get activeMode(): { kind: "main" } | { kind: "workscene"; sceneId: string };

  enterWorkMode(sceneId: string): Promise<void>;
  exitWorkMode(): Promise<void>;

  /** broker 切换抽为内部方法 —— reload 与 enter/exit 共用,消除 reload 路径的内联实现 */
  private swapConfirmationBroker(target: AgentRuntime): void;
}
```

`swapConfirmationBroker(target)`:`this.currentBrokerDetach?.()` → `this.attachedRenderer?.attach(target.confirmationBroker)` → 记录新 detach。**reload(现状在 `session.ts` reload 路径内联实现 broker detach→re-attach)与 enter/exit 统一调此方法**,不再有"内联 vs 方法"两套;`attachConfirmationRenderer` 的"已 attach throw"守卫只管首次 attach,broker 切换走本方法不经它。

`enterWorkMode(sceneId)`:`registry.get` → `createAgent({kind:"workscene",scene}, this.mainRuntime.permissionStore)`(复用 createAgent helper + reload 同款 permissionStore 跨实例复用)→ `swapConfirmationBroker(powerRuntime)` → `registry.touch` → set `workScene`。
`exitWorkMode()`:`swapConfirmationBroker(mainRuntime)` → 清 `workScene`(power runtime 无 dispose 接口、内部全 in-memory、失 ref 后 GC,与 reload 丢弃旧 runtime 同款)。

这两方法只管 runtime overlay + broker;与 ConversationRuntimeState 切换是同一原子事务的两组必须同步状态(非两个独立对称面),统一由 `applyModeSwitch` 在 turn 边界协调。模式切换是**换 runtime 实例**(各自带独立 budget/estimator/Resettable),**不调** `resetConversationState`(那是 `/clear` 重置同一 runtime 的语义,与切换正交)。

**dispose**:`RuntimeSession.dispose()` 若在 workmode,先丢弃 workScene overlay(GC)再走现有 main 资源 dispose 链(scheduler→delivery→channels 顺序不变)。**reload × workmode**:in workmode 时 reload 的 `agentChanged` 分支连带重建 power(workdir/memoryScope 从 WorkScene 重读、roles 从新 config 重解析、primaryRole 仍 power)。

**lifecycle 互斥语义**:reload / applyModeSwitch 共享**单一 lifecycle guard**,语义与现有 `reloading` guard 一致 —— **忙时后到者拒绝并提示**(非排队 mutex,非裸 boolean 模拟;沿用 `session.ts` 现有 `if(busy) return failed` 模式,只是从单一 reload 扩为覆盖 reload+enter+exit 三者的同一 guard)。三者都是 turn 边界操作、都先 await in-flight turn,纪律一致。

### MemoryScope(`@zhixing/core/memory`)

**作用对象是整个个人记忆域根(`me/` 目录),不是单个 store 类**。grep 实证 `me/` 域访问者两类:**(a) 四个 store class**(`MemoryStore`/`JournalStore`/`PeopleStore`/`SkillsStore`,均 `baseDir ?? getMemoryDir()` —— 有注入点);**(b) `profile-loader.ts` 函数**(`path.join(getMemoryDir(),"profile.md")` —— 无注入点、直调)。整域 scope 隔离须穷尽两类,任一漏掉破隔离。

修正现状两处既存债:
1. **双 `MemoryStore` 实例归一**:`create-agent-runtime.ts`(装配期给 `createMemoryFlushStrategy` 的 `new MemoryStore()`)与 `tools-builtin/src/memory.ts`(memory 工具内的 `new MemoryStore()`)是两个独立实例。装配期构造**单一** MemoryStore(按 memoryScope 定 root),同时注入 builtinCtx(工具)与 flush strategy —— 否则 power 模式下 flush 仍写 `~/.zhixing/me/`,by-construction 隔离失效。
2. **`getMemoryDir()` 根治**:`memory/types.ts` 的 `getMemoryDir()` 现用 `HOME/USERPROFILE` 拼接、**不尊重 ZHIXING_HOME**(既存 bug)。改为走 `getZhixingHome()`,不隐式绕过。

**两层分工(不可混淆)**:`getMemoryDir()` 根治只解决"默认 personal 路径尊重 ZHIXING_HOME";**scope 隔离**靠装配期 root 注入覆盖全部 `me/` 域访问者 —— 四个 store class 经 `baseDir` 注入,`profile-loader` 须从函数直调改造为接收 root 参数(与四 store 一致),由装配期按 memoryScope 统一注入。两者分别解决"默认路径正确"与"scope 物理隔离",缺一不可。

`MemoryStore` 现有 `baseDir?` 升必填 `root`;memory 工具经 `BuiltinToolContext` 扩展接收 store(`factories.ts` 注释已显式预留 `memoryStore` 扩展点,工厂签名不变)。装配期 root:
- main runtime:`root = <zhixingHome>/me/`(经 getZhixingHome,根治后)
- power runtime:`root = getWorkSceneMemoryDir(sceneId)`(`<zhixingHome>/workscenes/<id>/me/`)

**单向阀 by construction**:power runtime 拿到的(整域)store 物理指向 workscene 目录,无路径参数可 escape,装配后不暴露 setter;power 装配不注入 main-only workscene 工具,物理无途径触达 `~/.zhixing/me/` 或其他 workscene。

## 持久化布局

```
~/.zhixing/                            (= getZhixingHome(),尊重 ZHIXING_HOME)
├── me/                                (个人记忆域;只 main runtime 读写)
│   ├── profile.md  people/  skills/  journal/
├── conversations/<id>/                (user scope;现有)
├── projects/<projectId>/conversations/<id>/   (project scope;现有)
└── workscenes/                        (新增)
    ├── index.json                     (WorkSceneRegistry 主表)
    └── <sceneId>/
        ├── meta.json
        ├── me/                        (工作场景记忆域;结构同 ~/.zhixing/me/,内容隔离)
        │   ├── profile.md  people/  skills/  journal/
        └── conversations/<conversationId>/
            ├── meta.json
            └── transcript.jsonl
```

`~/.zhixing/workscenes/<id>/` **严格单一职责**:仅 meta.json + me/ + conversations/,**不接纳任何工作产物 / 临时文件**(产物落 `workdir`;无 `workdir` 时落系统 /tmp;绝不落此系统数据目录)。

`paths.ts` 加 `getWorkScenesRoot()` / `getWorkSceneDir(id)` / `getWorkSceneMemoryDir(id)` / `getWorkSceneConversationsRoot(id)`,均从 `getZhixingHome()` 派生,id 经 `toSafePathSegment`。

`ConversationScope` 扩展第三变体,`conversationsDir` 加一分支(复用现有 `ConversationRepository`):

```typescript
type ConversationScope =
  | { kind: "user" }
  | { kind: "project"; projectId: string; projectPath: string }
  | { kind: "workscene"; sceneId: string };   // → ~/.zhixing/workscenes/<id>/conversations/
```

## 运行时编排

### createAgentRuntime 选项扩展(仅两个新选项)

```typescript
interface CreateAgentRuntimeOptions {
  // ... 现有字段(provider?/model? cli override、profile?) ...

  /**
   * 主对话槽位 —— 缺省 "main"。create-agent-runtime 内 roles 引用穷尽分三类:
   * ① 主对话语义六处统一取 roles[primaryRole](capability 解析 / Task
   *   provider+model / budget resolveModelInfo / 返回 providerId+model /
   *   resilientCallLLM / runAgentLoop);
   * ② 压缩语义两处走 roles.light,不跟随 primaryRole:compaction
   *   (createCompactionFlush,现状已是)+ 段切换摘要(createSegmentSummarizeFn
   *   callLLM model,现状误用 roles.main,本次归正到 light)。
   * ③ 思考解析维度(随 thinking-control 落地新增,与 ①② 严格同分区):
   *   主对话 loop 与 Task 子 agent loop 的 thinking 跟 primaryRole ——
   *   resolveRoleThinking(roles[primaryRole], config.llm?.[primaryRole]?.thinking),
   *   不得硬编码 roles.main / config.llm.main(否则 primaryRole=power 时
   *   power 模型套用 main 思考配置、且按 main 模型 thinkingControl 误校验);
   *   压缩 thinking 跟 light(createCompactionFlush 现状已收 lightThinking);
   *   段切换 thinking 随 ② 的 model 归正同事务一并改 lightThinking。
   *   roleThinking 三角色聚合对象(下传 ToolExecutionContext 供工具按所用
   *   角色扇出)本身不变 —— 它是全角色映射、非 primaryRole 单值。
   */
  primaryRole?: "main" | "power";

  /** 个人记忆域根作用域 —— 装配期决定整域 root,后续不可变。缺省 personal。 */
  memoryScope?:
    | { kind: "personal" }                      // root = <zhixingHome>/me/
    | { kind: "workscene"; sceneId: string };   // root = <zhixingHome>/workscenes/<id>/me/
}
```

**不新增 `workSceneContext` 选项**:workscene 工作目录走现有 `workspace` 选项(power 传 `scene.workdir`),由现有 Environment 段(`CACHE_BOUNDARY` 之后,`system-prompt.ts` 实证已渲染工作目录)呈现,不重复进 prompt;workscene 语义定位走现有 `profile` 选项 —— `powerProfile(scene)`(下文)。`primaryRole` 单一槽位选择 → 主对话六处统一同源、压缩两处独立 light、思考解析随同分区(主对话/子 agent loop 跟 primaryRole,压缩/段切换跟 light);无 override 污染(power runtime 不透传 cli override,roles 由 `createProviderRoles` 正常解析,`resolve.ts` 实证 light 未配 fallback `roles.main`=config.llm.main 中档、非 power → 压缩成本正确)。systemPrompt 仍 byte-equal 冻结。

### powerProfile(scene)

复用 `subAgentProfile(opts)` 把动态文本编进 instructions 的现成手法(`default-profiles.ts` 实证 AgentRoleProfile 支持自定义 instructions + 任意 enabledTools)。明确基线:

- `enabledTools` **按 `scene.workdir` 有无二分(by-construction)**:**有 workdir** = `MAIN_ENABLED_TOOLS` 全集(read/write/edit/glob/grep/bash/memory/web_fetch/Task,文件工具在 workdir 操作);**无 workdir** = 剔除本地文件类工具(bash/read/write/edit/glob/grep),只留非文件工具(memory/web_fetch/Task 等)—— 无 workdir = 此场景不涉及本地文件,装配期即无文件工具,根本不存在"文件工具无根"问题(`default-profiles.ts` 实证 enabledTools 可任意子集,subAgentProfile 已是剔除先例)。workscene extraTools(`workmode_exit`)由 createAgent 按 spec.kind 追加
- `instructions` = 工作专注身份段(场景名 + "你在专注 `<scene.name>` 工作场景"定位 + 退出自判指引);同一 workscene 输出固定 → 静态前缀 byte-equal,多次进入缓存可复用
- `capabilities` = `{ canSpawnSubAgents: true, userFacing: true }`(同 mainProfile)

### RuntimeSession.createAgent 参数化

现有 `createAgent(existingPermissionStore?)` 硬编码 cli override / workspace。重构按 spec 装配:

```typescript
private createAgent(
  spec: { kind: "main" } | { kind: "workscene"; scene: WorkScene },
  existingPermissionStore?: IPermissionStore,
): Promise<AgentRuntime>
```

| 装配项 | main | workscene |
|---|---|---|
| cli provider/model override | 透传 `opts.cliProvider/cliModel` | **不透传**(工作模式与 cli 会话级覆盖正交) |
| primaryRole | `"main"`(缺省) | `"power"` |
| workspace | `opts.cliWorkspace` | 有 `scene.workdir` → 用之;无 → 显式无根(source:"none"),跳过 resolveWorkspace(见下不变量) |
| memoryScope | `{ kind: "personal" }` | `{ kind: "workscene", sceneId }` |
| profile | `mainProfile()` | `powerProfile(scene)` |

**无 workdir power 文件作用域隔离(by-construction 不变量,须焊死)**:create-agent-runtime 现状在 runAgentLoop 装配处 `workingDirectory: workspace.path ?? process.cwd()` —— workspace 空时兜底进程 cwd(很可能 = 用户启动 cli 处 / main 工作区)。无 workdir 的 power 若走此兜底则文件工具串到 main 工作区,破单向阀。须**两处一起切断**(只改装配层无效:传 `{path:undefined,source:"none"}` 后该兜底 `undefined ?? cwd` 仍生效):① 装配层对无 workdir power 标 `source:"none"`、跳 `resolveWorkspace`;② 该 `workingDirectory` 兜底改条件式 —— `source:"none"` 时 `workingDirectory: undefined`,不 `?? process.cwd()`。**主防线是无 workdir power 不装文件工具(见 powerProfile 二分),根本无文件操作面**;此兜底切断是纵深防御 —— 即使 Task 子 agent 等其他路径触发 workspace 解析,也**物理上不可能落进程 cwd / main 工作区 / workscene 系统数据目录**。装配期切断,不靠运行时检查。

### workscene agent 工具(走 assembly 统一路径 + IWorkModeController 接口)

workscene 工具**走 `builtinExtraTools.assembleTools` 统一装配路径**,不另开"createAgent 内平行追加"第二条注入路径(避免未来 review/debug 等模式继续膨胀)。`ExtraToolsRuntimeContext` 加 `spec: { kind:"main" } | { kind:"workscene" }`;assembly 按 spec.kind 决定追加哪组 workscene 工具,与 scheduler/task_list 通用工具同一处装配。

工具捕获 **`IWorkModeController` 接口**(RuntimeSession 实现),不直接捕获 RuntimeSession 实例 —— 解循环引用 + 工具可独立测试。**装配时序**:assembly(`createBuiltinExtraToolsAssembly`)早于 `RuntimeSession.create` 构造,故 `ExtraToolsRuntimeContext` 加 `workModeController: () => IWorkModeController` **getter**(与现有 `scheduler: () => this.schedulerInstance` getter 完全同构),延迟取解鸡生蛋。`IWorkModeController` 暴露:`registry`(CRUD)、emit 切换意图(下节)。

- **main(spec.kind=main)**:
  - `workscene_change_approve`(`needsPermission:true`)— 用户拍板后调 `registry` add/remove/rename/archive
  - `workmode_enter`(`needsPermission:true`)— 用户拍板后 emit `workmode:switch_requested {kind:"enter",sceneId}`,**不执行切换**
  - `workscene_memory_query` — 只读检索任一 workscene 记忆域(各 workscene readonly store 集合),返回片段/摘要非 raw
- **power(spec.kind=workscene)**:
  - `workmode_exit` — LLM 自判完结,emit `workmode:switch_requested {kind:"exit"}`,**不执行切换**(退出即回 main,无需 confirmation)

注入哪组由 spec.kind 决定 —— by construction 隔离:power runtime 物理不持有 main-only 工具。

### 切换意图回传管道

工具 call 体(用户已拍板后,`secure-executor.ts` 实证:`pipeline.evaluate`→`broker.requestConfirmation`→deny 不进 call 体 / allow 才进)emit `workmode:switch_requested`(`AgentEventMap` 加一事件键,与 `context:compact_end`/`segment:new_started` 并存,自然扩展)。run() 侧 `subscribeWorkModeAccumulator(eventBus)` 复用 `subscribeCompactAccumulator` **结构形态**(订阅→getter→run 结束带出),但**语义为 last-wins 单一意图**(非 compact 累加):同 turn 多次 `workmode_enter` 取最后一次(对应用户最后拍板 sceneId);`enter`/`exit` by construction 不会同 turn 共存(main-only vs power-only extraTool,一 turn 一 runtime)。run() 塞进 `RunResult.pendingModeSwitch`:

```typescript
RunResult.pendingModeSwitch?:
  | { kind: "enter"; sceneId: string }
  | { kind: "exit" }
```

与 `compactBefore`/`injectedSkillIds` 等"turn 内产生、RunResult 带出"字段同构。**不经 RunContext**(`run-context.ts` 实证 RunContext 刻意精简、下游只读传递,写回是污染)。命令触发路径不产生此事件(命令直接调 applyModeSwitch)。

### ConversationRuntimeState + applyModeSwitch 单一事务

REPL 把 per-conversation 运行态聚合为 `ConversationRuntimeState`(各字段与 active runtime 强绑,必须与 runtime 切换同事务;**不含 agent —— agent 走 session.runtime getter**):

| 字段 | workscene 处理 |
|---|---|
| `messages`(canonical) | `commitTurn` 返回整体替换 |
| `conversationId` | 当前对话身份 |
| `turnCounter` | commitTurn 后 ++;进入 workscene 归零 |
| 会话级 flag | `lastToolEndCount`/`hasProposedSkill`/`journalCondenseDone`;进入 workscene 全归零 |
| `convRepo` | 绑 `ConversationScope`;workscene 独立第二实例 |
| `transcriptStore` | `TranscriptStore(convDir, workdir)`;workscene 独立第二实例(workscene convDir + `scene.workdir`) |
| scope 路由核 | **单一路由核**:REPL 维护 `active → ConversationRepository` 决策(main 常驻、workscene 由切换事务注册/注销)。**两个 facade 适配器包同一路由核**:`TaskListStore` 形(供 task_list,`(convId)` 接口委派)+ `IConversationRepository` 形(供 `createSegmentPersistence`/segmentDeps,绑 repo 实例接口)—— 接口形态不同、路由决策同源,非两套机制。**路由核限 REPL 内部实现**(简单 `active→convRepo` 映射 + enter 注册/exit 注销,不独立成模块、不做跨 scope convId 冲突检测等扩展,防过度抽象)。TaskListService 不动(per-convId cache 三层契约保持) |

`applyModeSwitch(intent)` —— REPL 主回路 turn 边界唯一切换执行点,**原子事务**:有副作用步骤按序执行,任一步失败则**逆序撤销已执行的副作用**,不改 active、不留半切状态、错误抛 REPL 提示。

- **enter** 副作用步骤序(失败逆序撤销已执行项):① 路由核 register `worksceneConvId→workscene convRepo`(撤销:unregister)→ ② workscene scope 新建 conversation(撤销:删除该 conversation 记录)→ ③ `taskListService.prime(worksceneConvId)`(撤销:`taskListService.clear(worksceneConvId)`)→ ④ `session.enterWorkMode(sceneId)`(装 power runtime + broker swap;其自身原子由 RuntimeSession 保证——装配中途抛错不 set workScene;此步成功后若 ⑤ 失败,applyModeSwitch 调 `session.exitWorkMode()` 回退 broker + 弃 overlay)→ ⑤ 构造并切 active 为 workscene `ConversationRuntimeState`(turnCounter/flag 归零)。**起始 messages 按触发源**:LLM `workmode_enter` 工具触发 → 当前 turn 的原始用户输入(引发 LLM 决定进入的那句,REPL 主回路本就持有 `state.messages` 末尾 userMsg)作 power 起始 `messages[0]`(vision:不读 main 历史,但触发那句须带入,否则 power 不知干啥);`/enter` 命令触发 → `messages=[]`(命令非对话输入,用户随后在 workscene 输入)。**渲染**:REPL 在事务点直接 cliWriter 输出分隔线 + dim 提示(不经 EventBus 订阅);切为 active。
- **exit** 副作用步骤序:① 当前 power runtime `runtime.callText(prompt)` 生成一句纪要(`callText` 现有,`compaction-llm.ts` 实证绑 light;power 的 light=用户中档,成本正确)——**best-effort,失败不阻断 exit**(退出是用户明确意图,不可因纪要 LLM 失败卡在 workscene;失败则跳过纪要 + 记降级提示,main 后续仍可 query workscene 记忆兜底)→ ② `session.exitWorkMode()`(broker swap 回 main + 弃 power overlay)→ ③ 切 active 回 main `ConversationRuntimeState` + 丢弃 workscene 运行态(`taskListService.clear` + 路由核注销 workscene 绑定)→ ④ 仅 ① 成功时,纪要 append main 运行态 `messages` 末尾,**以现有 `<system-meta kind="workscene-digest">` 元标签包裹**(复用 `system-prompt.ts` meta-protocol 段已教 LLM 的"机制插入内容、非用户/自己原话"识别机制 → 解决"main 误以为自己说过"的归因混乱;尾部追加不毁 main systemPrompt 前缀缓存);渲染直接触发。纪要不写个人记忆(值得长存的由 main 后续自判调 memory 工具)。

**enter / exit 失败原子性不对称(须焊死)**:enter 失败 = **fail-back 到 main**(逆序撤销已执行副作用,安全态是 main);exit 失败 = **fail-forward 到 main**(power overlay 一旦弃不可复原,② 起任一步失败都必须继续推进到 main 干净态,绝不退回 workscene);① callText 失败是 best-effort 跳过、不计入失败。

`/switch`/`/new` 在工作模式下**禁用**(确定,非开放:单一 workscene 专注会话切换别的对话语义混乱);`/compact`/`/clear` 作用当前 active 运行态。**journal-gate**:turn 边界 journal condense 触发处仅 `activeMode.kind==="main"` 才跑(workmode 下 active=power、记忆域是 workscene,个人 journal 只 main 碰)。

### cli 系统命令(同源)

| 命令 | 底层 |
|---|---|
| `/workscene add <name> [--workdir <path>]` | `registry.add`(workdir 可选) |
| `/workscene list [--archived]` | `registry.list` |
| `/workscene remove <id> [--purge]` | `registry.remove` |
| `/workscene rename <id> <name>` | `registry.rename` |
| `/enter <id\|name>` | handler:先 await `state.activeTurnPromise`(turn 在跑则等完,与 `/config` reload 同款纪律)→ lifecycle guard → `applyModeSwitch({kind:"enter",sceneId})`(命令源:messages=[]) |
| `/exit`(工作模式中) | 同款:await activeTurnPromise → guard → `applyModeSwitch({kind:"exit"})` |

agent 工具与命令最终汇聚到同一 `applyModeSwitch` / `registry` 原语,仅入口暴露不同。**两条触发路径 turn 时序不同**:LLM 工具触发经 emit→accumulator→RunResult,由 REPL 主回路在 turn 结束后消费,**天然 turn 边界**;命令触发可能在 turn 运行中输入,handler **须先 await `state.activeTurnPromise`** 才真正到达 turn 边界(对齐 hot-reload spec §七 reload 先 await in-flight turn 的既有纪律)。

## 实施计划

每个 PR 独立可验证,顺序基于依赖。

**PR 1 — WorkScene + Registry 基础设施**(`packages/core/src/workscene/`)
类型 + `FsWorkSceneRegistry`(atomic write + per-id lock,同构复用 conversation/repository.ts metaLocks);paths.ts 加 4 getter;`ConversationScope` 加 workscene 变体 + `conversationsDir` 分支。单测 CRUD + 并发 + workscene-scope 路径解析。
**验收**:跨包测试零回归;dev script 端到端 CRUD + 跨 process 持久化。

**PR 2 — MemoryScope(整域 + 既存债根治)**
`MemoryStore` 构造 `root` 必填;`getMemoryDir()` 根治走 `getZhixingHome()`(尊重 ZHIXING_HOME)或废弃;`BuiltinToolContext` 加 `memoryStore`;`createAgentRuntime` 加 `memoryScope`,装配期构造**单一** MemoryStore 同时注入 builtinCtx(工具)与 flush strategy(消除 create-agent-runtime 装配期实例与 tools-builtin/memory.ts 工具内实例的双实例);审计 `me/` 域全部访问者:4 store class 经 baseDir 注入、`profile-loader` 改造加 root 参数,统一从同一 root 派生(getMemoryDir 根治负责默认路径、root 注入负责 scope 隔离,两层分工)。缺省 personal 对外不变。
**验收**:跨包测试零回归;ZHIXING_HOME 设置后记忆写入正确目录;flush 与工具读写同一 store;me/ 域全访问者(4 store class + profile-loader)scope 注入穷尽、workscene 模式下无任何访问者写入 personal 目录。

**PR 3 — createAgentRuntime primaryRole 槽位**
加 `primaryRole?`(缺省 main);① 主对话六处统一 `roles[primaryRole]`;② 压缩两处 `roles.light`:compaction 现状已是,段切换摘要(`createSegmentSummarizeFn` callLLM model 现状 `roles.main`)归正 `roles.light`;③ 思考解析维度(thinking-control 已落地,与 ①② 同分区,**必须同 PR 一并改否则 primaryRole=power 静默错位**):主对话 loop 与 Task 子 agent loop 的 thinking 由现状硬编码 `resolveRoleThinking(roles.main, config.llm?.main?.thinking)` 改为 `resolveRoleThinking(roles[primaryRole], config.llm?.[primaryRole]?.thinking)`,runAgentLoop / 子 agent loop 收该值;段切换 thinking 随 ② 的 model 归正在同一改动里一并切到 lightThinking;compaction 现状已收 lightThinking 不动;roleThinking 三角色聚合对象(下传 ToolExecutionContext)不变。
**验收**:缺省 main 主对话六处 + 思考解析字节级零变化;段切换改 light 后 model 与 thinking 一致(未配 light fallback main 行为等价、配了 light 既存不一致被修正);单测 primaryRole=power 验证六处指向 power、loop thinking 解析自 config.llm.power(非 main)、压缩/段切换两处指向 light(未配=config.llm.main 中档非 power)。

**PR 4 — WorkSceneRegistry 接入 + cli 命令**
RuntimeSession 持有 Registry;cli `/workscene add/list/remove/rename/archive` 直接调 Registry。
**验收**:cli 命令端到端 CRUD,持久化跨重启。

**PR 5 — REPL agent 访问统一(P1 根治,前置)**
删除 `ReplState.agent`;16+ 处 `state.agent.xxx` 全改 `session.runtime.xxx`;journal-gate(仅 main 模式触发 condense)。**先于 workmode 扩展**——这是修复既存 reload bug 的独立单元,无 workmode 也应做。
**验收**:`/config` 改模型后 `/status`/`/model` 显示新模型(既存 bug 修复);所有 slash 命令(/usage /compact /trust /security /new 等)行为零回归;journal 维护仅 main 触发。

**PR 6 — 切换意图回传管道**
`AgentEventMap` 加 `workmode:switch_requested`;`subscribeWorkModeAccumulator`(复用 compact-accumulator 结构形态,语义 last-wins 单一意图非累加);`RunResult` 加 `pendingModeSwitch?`;run() 装配 accumulator 带出。纯管道无切换执行。
**验收**:桩工具 emit 一次,RunResult 正确带出;同 turn 多次(不同 sceneId)取最后(last-wins);无事件 undefined;现有路径零回归。

**PR 7 — RuntimeSession 工作模式扩展 + applyModeSwitch 单一事务**
`swapConfirmationBroker` 抽方法(reload 改调此方法,消除内联);`createAgent` 参数化(spec.kind/powerProfile/memoryScope/primaryRole=power/workspace=workdir/不透传 cli override);`workScene` overlay + `get runtime()` 路由 + `activeMode`;`enterWorkMode`/`exitWorkMode`(broker swap / permissionStore 复用 / GC);scope 路由 facade(task_list + segmentDeps 共用);`ConversationRuntimeState` 聚合 + 双份持有;`applyModeSwitch` turn 边界原子事务(消费 pendingModeSwitch + 命令直接调;enter 起始 messages 按触发源;失败整体回滚;渲染事务点直接);lifecycle guard 覆盖 reload/enter/exit;dispose 处理 workScene 分支;临时 `/enter`(exit 暂不带纪要)。
**验收**:`/enter` 进入 —— power runtime 装配打印 effective 主对话=power 解析值、light=中档、memory 域 root=workscene;ConversationRuntimeState 全字段切换正确;turn 内 emit 后当前 turn 用旧 runtime 跑完、turn 边界才切;`/switch`/`/new` 在 main 模式零回归;lifecycle guard 阻止 reload 与切换并发;装配中途抛错整体回滚无半切;dispose 在 workmode 先弃 overlay。

**PR 8 — reload × workmode**
`reload()` `agentChanged` 分支:in workmode 连带重建 power(workdir/memoryScope 从 WorkScene 重读、roles 重解析、primaryRole 仍 power);事务回滚覆盖 power。
**验收**:workmode 中 `/config` 改 model,main 与 power 下条消息均用新配置,两份运行态不丢。

**PR 9 — 退出纪要**
`applyModeSwitch` exit:`runtime.callText` 生成纪要 → `exitWorkMode` → 纪要以 `<system-meta kind="workscene-digest">` 元标签包裹 append main 运行态 messages。
**验收**:手动 enter/做事/exit 后 main 下一 turn 见纪要且 LLM 识别为机制插入(不当自己原话);mainRuntime.systemPrompt byte-equal 不变。

**PR 10 — agent 工具接入(走 assembly)**
`ExtraToolsRuntimeContext` 加 `spec`;`assembleTools` 按 spec.kind 追加 workscene 工具组;工具捕获 `IWorkModeController` 接口(RuntimeSession 实现)。`workmode_enter`/`workscene_change_approve` `needsPermission:true`;`workmode_enter`/`workmode_exit` call 体仅 emit 不执行切换;`workscene_memory_query` 只读检索。
**验收**:LLM 在 main 调 workmode_enter 触发 confirmation,拍板后 emit、当前 turn 用 main 跑完、turn 边界进 power;power 模式仅见 workmode_exit;两入口共享状态;工具脱离 RuntimeSession 实例可单测(IWorkModeController mock)。

**PR 11 — LLM 自动切换 + system prompt 指引**
main systemPrompt 加 Working Mode 段(stable prefix,条件渲染参考现有 sub-agent-delegation 条件段模式);明确信号直接调 `workmode_enter`,模糊场景先 `workscene_memory_query` 探再决定问/切(vision 第 4 块"先探后问")。`powerProfile` 身份段含场景定位 + 退出自判。
**验收**:端到端 —— 用户 main 说"帮我看 zhixing 的 cli 模块" → LLM 调 workmode_enter → confirm → 本轮 main 跑完 → turn 边界进 power(workscene 目录+power 模型+workscene 记忆域,触发那句作起始 messages) → 续 → "差不多了" → workmode_exit → turn 边界回 main 见纪要。

## 开放问题(PR 内实施细节,不影响架构)

1. **workscene_memory_query 检索策略**:v1 category+slug 列表 + 单条 raw 读;v2 全文搜+LLM 蒸馏。snippet 上限初步 500 字符/条。
2. **power runtime SecurityPipeline**:permissionStore 跨实例复用已定;SecurityPipeline 随 createAgentRuntime 新建(power 有自己 workspace 边界)。`swapConfirmationBroker` 在 power 新 broker 上行为正确性需 PR 7 验证(power runtime 的 `confirmationBroker` 是全新实例,`renderer.attach` 幂等性靠 detach 旧→attach 新,不经"已 attach throw"守卫)。
3. **WorkScene.workdir 不存在 / 失效**:enterWorkMode 装配前校验 workdir 可访问,不可访问则 applyModeSwitch 整体失败回滚 + REPL 提示,active 留 main。
