# 统一核心与多接入面 (Unified Core & Access Surfaces)

> **定位**：梳理"一个智能体核心单例 + 多个可插拔接入面"的需求与方向——cli / 飞书 / RPC 等作为可开关、可共存的接入面，支撑用户在不同入口完成**同一份工作**（多端协同、跨端连续）。
>
> **状态**：主线架构已进入实现与实测收口;当前补充运行控制交互设计（`/status` / `/stop` / 普通退出 / 非交互停止安全）已定，待按补充单元实现。
>
> **与调度器模块的关系**：本模块与 [scheduler-architecture.md](./scheduler-architecture.md) 共享同一地基——「核心宿主（agent core host）」。核心宿主由调度器那一轮先立起（最小形态：仅调度）；本模块在该宿主之上长"会话共享 / 多端协同"这一层，**不重起核心宿主**。两者是同一架构哲学（核心单例 + 多接入面）的不同层：功能上独立、地基上共享。
>
> **范围约束**：需求与架构到可执行决策为止;代码级契约随实现各阶段在对应 spec 细化。

---

## 一、需求与原则锚定

### 核心论断

"以 cli 为核心"长远站不住。cli 是一个终端，用户随手就关；核心若绑在 cli 进程里，关了终端核心就没、远程也跟着断——这恰恰和"离开电脑还能远程续"矛盾。

所以最优不是"cli 为核心"，而是：**核心是单例，cli / 飞书 / RPC 都是它的接入面**。核心宿主**恒为独立于任一终端的进程**——cli 在场时它在场（接入面在场 → 核心在场），cli 离场只是少一个接入面。不采用"宿主寄生 cli 进程、离场时切换为常驻"的形态：寄生 = 双模式代码路径 + 在场 ↔ 离场的状态迁移正确性，恒独立进程让"切换"问题整个不存在（见 §二「宿主生命周期」）。

产品直觉（核心唯一、接入面可开关可共存）是对的；核心**独立于任一终端**，不寄生在任何一个接入面上。

### 需求

1. **一个智能体、多接入面**：知行是"一个"个人智能体——核心单例；cli 本地交互、飞书远程、RPC、未来 web 等都是这个核心的接入面（access surface），可开关、可共存，而非互斥的不同入口、更不是各起一套。
2. **多端协同同一份工作**：用户既能通过 cli 在本地干活，又能（在开启远程接入时）远程接续完成同一份工作——同一对话 / 任务 / 上下文 / 记忆跨端连续。
3. **核心独立于终端**：用户关掉 cli 后，若已开启远程接入，远程仍能续——核心宿主能脱离任一终端（必要时常驻）。

### 原则

1. 核心唯一（单例），接入面只是它的 I/O 面，绝不把核心状态复制到各入口。
2. 接入面可开关、可共存：不是"不同命令各起一套独立实例"，而是同一核心点亮不同接入面。
3. 避免架构债务，要最优架构与方案设计（同调度器模块原则）。

---

## 二、需求碎片梳理

> 只罗列、不拼接 / 取舍（同 skill-module 碎片区纪律）。来源：三个核心问题（会话共享 / 并发串行 / 宿主生命周期）+ 代码现状事实 + 各模块为本方向预埋的伏笔。

### 已定地基（调度器模块已定，沿用不重做）

- **核心宿主已立**：per-home 单例（端口 listen 原子仲裁）、接入面 profile 数据驱动装配、「接入面在场 → 核心在场」生命周期（cli 保活 / idle 退出）——接口形态当时即按通用核心宿主定死，本模块在其上长会话层，不重起宿主
- **cli 在调度域已是 RPC client**（RpcSchedulerFacade / ensureHost）——会话域照此同构，不发明第二种接入方式

### 会话权威与单写者（问题 1「会话状态共享」的碎片）

- **现状核心矛盾 = 两套会话执行面并行**：cli/repl 自持会话于进程内存（runtime + 注意力窗口 + transcript owner + 接受协议直驱，关终端即失）；serve/ConversationManager 已是"可远程接入"的会话抽象（ManagedSession：窗口、observer 多连接共享、grace/idle 生命周期、ephemeral 缓冲 + promote）。合一后全系统**单一会话执行面**
- **cli 会话执行面收编**：cli 从"自持会话的进程"变为会话域的 RPC 接入面（与其调度域身份同构）；会话权威（窗口 + transcript 单写者 + turnCounter）归核心宿主；ConversationManager 是现成雏形，不另起会话抽象
- **单写者收口各模块伏笔**：transcript owner、skillStore 结构版本、技能库写入归一到宿主进程——transcript 保留清理以「零索引写」绕跨进程锁的设计考量、skill 结构版本的跨进程漂移、serve 进程内共享 store 的实例一致性约束，全部指向此终局并随之消解
- **渠道会话与 cli 对话的隐式分离退场**：现状靠「渠道会话不写 meta.json、cli 列表按 meta 过滤」分离两个域——这正是"飞书聊的 cli 看不见"的多端不连续；统一后对话是同一域的一等公民，任一接入面可见可续

### 并发输入串行化（问题 2 的碎片）

- **per-conversation 串行点唯一化**：serve 已有 busy + pendingQueues（maxPending 5）——升格为跨接入面的唯一串行点，cli 输入与手机输入落同一队列；同会话同一时刻只跑一个 turn
- 排队上限、超限拒绝的用户反馈、排队中输入的可见性——接入面各自投影、语义同源

### 宿主生命周期与位置切换（问题 3 的碎片）

- **宿主恒为独立进程，cli 恒为接入面（已裁决）**。寄生形态（宿主驻 cli 进程、离场时切换为常驻）= 双模式代码路径 + 在场 ↔ 离场的状态迁移正确性，是把"切换"当问题去解；恒独立进程让切换问题**整个不存在**（消灭问题优于解决它），且调度域已做同样选择（cli 不自起 Scheduler）。代价 = 本地多一跳 loopback RPC，由「体验约束」组守住
- **会话状态本就在宿主 → "切换"消解**：cli 离场 = 断一个 observer（grace 期托底），运行态不丢；cli 在场常态 = 宿主在场（ensureHost 已有）。不存在"状态迁移"，只有"接入面增减"
- **轻量性不破**：未开远程接入、无 activeWork 且无 keepAliveWork 时不强制常驻——生命周期沿「接入面在场 → 核心在场」既有模型;已启用的用户定时任务属于 keepAliveWork,它不是正在运行的工作,但会保留宿主在场以兑现"我不在它也跑"的调度承诺
- **资源代价诚实记录**：恒独立进程意味着聊天时恒两个 node 进程（两份 V8,各数十 MB 起）——行业常态（LSP / Docker 同模型）且有 idle 回收兜底,但「要轻」原则要求把它写在明面:宿主内存基线纳入验收观测,不藏在"架构更优"叙事后面

### 接入面体验约束

- **cli 体验不降级是硬约束**：流式渲染、确认面板、chrome、段切换提示等经 RPC 接入后不损（确认已有 Hub/Bridge 先例；事件流经 RPC 订阅）——cli 是最重的接入面，它的投影质量是这次改造的验收底线
- **冷启动同为底线**：恒 client 模型下 `zz` 须先确保宿主在场——「打开到可输入」的时间不得显著变长（宿主拉起 / 连接与 cli 自身启动并行化），"个人工具先等 daemon 才能说话"是必须消灭的体感
- **同会话多 observer 的渲染广播**：一个 turn 的事件流要能同时投影到多个在场接入面

### 开放问题（记下防丢，未裁决）

- 逐 token 流式事件跨进程（RPC 订阅）的形态与时延；cli 渲染管线的对接方式
- runtime 重资产（MCP 连接、技能索引、记忆）归宿主后，cli 侧 /config 热重载的生效协议
- **工作场景归宿主——cli 收编的第二大改造面**（不止"生效协议"）：场景独立对话域与记忆域、power 装配、退出纪要全部归宿主;cli 现状的 overlay/undo 栈状态机是单 runtime 槽争用的产物,收编后不迁移而是**消失**(per-conversation 实例下问题不存在);接入面只投影场景状态
- 打断（abort）的跨接入面语义：cli Esc 打断的是宿主上的 run;排队中的其它接入面输入如何处置
- 版本偏斜（恒 client 模型经典坑,调度域现状已存在）：cli 升级后旧版本宿主进程仍在跑,RPC 协议与行为不匹配——需版本握手 + 宿主换代机制（LSP / Docker 先例）
- 宿主可观测性：黑盒 daemon 出问题时用户怎么看日志 / 状态（现有 log 文件之上的产品级透明度）
- 宿主不可用 / 拉起失败时 cli 的失败形态：fail-fast、自动重试、只读浏览（读路径不依赖宿主）还是引导修复——**"本地起一套 agent runtime 兜底"已裁决排除**：那是第二套会话执行面回魂,直接违背单一会话权威
- 确认请求的跨接入面归属：弹给发起者（turnOrigin 路由已有）之外，旁观接入面是否可见确认状态 / 结果
- 会话命令（/clear、/resume、/compact 等）的执行归属：注册与分发在 cli、执行体在宿主，跨进程往返的形态——cli 收编的最大改造面之一
- 迁移路径：两套执行面如何渐进合一而非大爆炸切换——两条硬约束:**①渐进期不得引入第三套中间形态**（为兼容旧 repl 造临时适配层 = 把要消灭的债务先复制一份）,每步必须是终态的子集;**②任一 conversation 任一时刻只能有一个 owner**——迁移期允许按入口 / 能力分阶段切换,但绝不允许同一对话被 cli 本地 runtime 与宿主 ConversationManager 双写、双窗口推进

---

## 三、架构设计（可执行）

> 逐条裁决 §二开放问题,落到组件与对接点。原则:**边界放在事件流上,不发明新事件协议**——cli 渲染面的两条腿(`AgentYield` 产出流 + per-run bus 带外事件)各自已有协议实体,投影逐腿对应(见 3.2),渲染管线零改。

### 3.1 终态拓扑

```
核心宿主(独立进程,per-home 单例,生命周期=「接入面在场→核心在场」)
├─ RuntimeHost(RuntimeSession headless 化重组):共享装配资产 + per-conversation 实例
│    资产层(provider/MCP/技能库/段切换依赖,reload 单位)全 runtime 共享;
│    实例层按对话发放(profile 由对话场景属性定),持窗口级状态
├─ ConversationManager(升格为全域会话权威):窗口+transcript owner+turnCounter、
│    busy+pendingQueues(唯一串行点)、observer 多连接、grace/idle 生命周期
├─ Stores 单写者:ShardedTranscriptStore / SkillStore / SnapshotStore / PermissionStore
│    / 记忆域仓(MemoryStore / JournalStore / PeopleStore)
├─ Scheduler(已在)+ ConfirmationHub(已在)
└─ 接入面:RPC server(WS+JSON-RPC) / 飞书渠道 / …(profile 数据驱动装配,已在)

cli = 纯接入面(RPC client):
├─ TTY 资产全留本地:chrome、typeahead、命令注册与分发、确认面板、markdown 渲染、历史尾巴
├─ CoreHostConnection 单连接(既有封装升格共享):调度 / 会话 / 确认域共用这一条已认证连接
├─ RpcConversationFacade(对标 RpcSchedulerFacade):会话域方法调用——facade 是方法域封装,不持连接
└─ RpcEventBus 适配器:RPC 事件订阅 → 实现渲染层所需的 bus 形接口
```

**连接即接入面身份单位**:observer 登记、确认 Bridge 的 `triggeredBy=connectionId` 定向推送、版本握手、宿主"活跃接入面"计数全部挂 connection——一个 cli 进程必须恒为**一条**连接。双连接会把一个 cli 数成两个接入面:裁决 7 的换代判定("无其它活跃接入面才优雅退出")中自己的两条连接互相挡路,结构性死锁。

**收编的实体**:`RuntimeSession`(cli/runtime/session.ts)与 repl 持有的会话状态(window / store / turnCounter / 接受协议)迁宿主;**repl 顶层的自动维护动作一并收编**——journal 生命周期维护(`runJournalLifecycle`:首轮对话后 expireOld + LLM 凝练写,现在 repl 进程跑、不在 RuntimeSession 内,漏点名即漏迁;宿主侧 JournalStore 先例已在,收编后随宿主 turn 后维护自跑、无需 RPC 方法)。cli 剩 UI。删除的:repl 的 `state.conv` 直驱路径、cli 侧 store/window 实例。

**迁移前置一:RuntimeSession headless 化(依赖反转)**。现 RuntimeSession 构造必填 `renderer: OutputRenderer` / `writer: CliWriter`,内部硬连 `createRenderSubscribers`,并暴露 `attachConfirmationRenderer(TerminalConfirmationRenderer)` 具型 API——核心状态与 cli 渲染层焊在一起,原样迁移会让核心宿主依赖 TTY 类型(塞 dummy 实现也只是把错误依赖方向藏起来)。裁决:先拆出无 UI 类型依赖的核心(资产装配 / 实例发放 / blue-green reload),对外只收两个装配钩子——per-run 装饰钩子(`DecorateRunBusFn` 形,注入点本就存在)与确认 broker 接线钩子;TTY 三件套、`createRenderSubscribers` 调用、`TerminalConfirmationRenderer` 全部留在 cli 侧作钩子实现。宿主只持核心:宿主侧钩子实现 = RPC 转发装饰器 + ConfirmationHub/Bridge 接线。

**迁移前置二:runtime 持有模型收敛为「共享装配资产 + per-conversation 实例」(RuntimeHost)**。两侧现状:cli 的 RuntimeSession 是单会话设计(main 单槽 + workScene 单 overlay 槽、`activeMode` 全局一份)——单槽模型迁宿主撑不住多对话并发(A 对话在 main、B 对话在场景 X,单 activeMode 结构上表达不了);serve 已是正确分层的雏形——重资产(segmentDeps / skillStore / MCP)全 runtime(per-session + ephemeral)共享单实例,runtime 实例 per-conversation 建。**实例必须按对话隔离是代码事实**:AgentRuntime 闭包持有窗口级可变态(`authoritativePrompt` / `windowEpochCounter` / `windowCounter` / `lastRunEntryWindowIndex` / 技能贡献 `builtVersion`),一个实例的设计假定就是服务单一对话的窗口序列,跨对话共享即互相践踏——可变状态的隔离单位必须对齐并发单位。裁决:

- **RuntimeHost 两层结构**:资产层(provider / pipeline / MCP 连接 / 技能库 / 段切换依赖)全 runtime 共享,是 reload 的换代单位;实例层按对话发放轻实例(闭包持窗口级状态),profile 由对话场景属性决定(main / 对应场景的 power)。调度任务的 ephemeral 实例同属此资产层——会话 / 场景 / 任务三类消费者一个模型。reload = 资产重建 + 活跃实例同事务换代(现 RuntimeSession 的 main+power 同事务构建 / 回滚正是其单对话特例)。
- **workscene 态从全局模式降为对话的静态属性**:场景对话生在场景里、归属创建即定(meta 记 sceneId),不存在"给对话改场景"的动态绑定——cli 现状即如此(enter 切 `state.conv` 到场景对话,exit 切回 main 对话,对话本身不换属性)。send 执行时 ConversationManager 按对话场景属性向 RuntimeHost 取实例,宿主侧**无任何"当前模式"状态需要维护**;退出纪要是场景记忆域的产物(随实例末窗),不是宿主状态。ManagedSession 持窗口 / turnCounter / 串行点,**不持 runtime 实例**(窗口从 serve 现状的 SessionRuntime wrapper 内挪出)。记忆域单向阀(journal 只在 main 域)判定点随之从全局 activeMode 改锚对话场景属性,单向阀语义不变。
- **per-conversation 装配差异经执行期上下文取**:RunContext 已携带 `conversationId`,任务投递 origin 本就由会话 id 派生(`parseOriginFromSessionId`)——`scheduleOrigin` 从装配期闭包捕获改为执行期从 RunContext 派生。serve 的 per-conversation factory **升格为 RuntimeHost 实例层**,不退役;收编的只是闭包式对话差异与 wrapper 内的窗口归属。

### 3.2 投影边界:双通道(渲染零改的关键)

cli 渲染面本就是两条腿,投影逐腿对应、各自零改:

- **主通道(turn 产出流)**:cli 主渲染消费的是 `runtime.run` 的 `AgentYield` 流(repl 经 `onYield` 回调喂 `renderer.handleEvent`),不经 bus。既有 `session.delta` 推的正是 `AgentYield` 原样——它就是主通道的现成投影,**保留并升格为会话事件主流**;cli 侧 `RpcConversationFacade` 把 delta 通知还原为 `onYield` 回调,主渲染管线一行不改。渠道端(飞书)继续各自聚合适配,语义同源。
- **带外通道(per-run bus)**:`createRenderSubscribers`、status-bar 订阅的是 `IEventBus<AgentEventMap>` 形接口(retry / segment / interrupt / context 等)。宿主经 `decorateRunBus` 装饰器转发为 RPC 通知(serve 的 renderDecorator 与 event-bridge 广播已是先例),cli 侧 `RpcEventBus` 以 `agent:run_start` / `agent:run_end` 为边界建立 / 拆除 per-run 投影 bus,`createRenderSubscribers` 一行不改。

**带外通道的 wire 纪律**(不是"全事件谱原样序列化"):AgentEventMap 中 `llm:request_start` 携带完整 systemPrompt / messages / tools(引用传递、订阅者按需序列化的设计),`segment:new_started` 带 windowCompact——全谱上 wire 等于每次 LLM 请求把整个上下文窗口推一遍,带宽与敏感面双输。裁决:

- 统一信封:`{ conversationId, runId, seq, event, payload, meta }`;`meta.lineage` 必须保留(渲染层区分子 agent 帧依赖它)。
- 默认投影 = UI 订阅集:渲染与 status-bar 实际消费的小 payload 事件(run 边界 / retry / segment 提示 / interrupt / security / lifecycle / tokens_snapshot,及 `llm:request_start` 的摘要字段 model / messageCount / hasTools)。
- 诊断级大 payload(完整 messages / tools / systemPrompt、windowCompact 全文)不进默认投影——诊断 dump(如 `--log`)随 runtime 在宿主本地落盘,按路径查阅。

**推送名册**:两通道的推送从"发起连接单播"(现状 runManagedTurn 只 notify 发起连接)改为**同会话 observer 组播**——observer 名册现状仅用于 grace 管理,升格为事件分发名册;多 observer 同看一个流式 turn 由此成立。确认按 3.4 裁决 5 定向推送,不随组播。**中途加入不回放**:turn 进行中加入的 observer 从当前帧起收增量(入场提示"turn 进行中"),turn 完成后经落盘事实流补全视图(中断 run 占位渲染先例已在)——不为补帧建逐帧缓冲(EphemeralRunBuffer 是持久化对账镜像,不得挪作此用)。

**会话级变更通知(非 run 期,第三类推送)**:现状全部具名通知只有 delta / complete,两通道又都以 run 为边界——而 /clear、改名、对话删除发生在 run 外,旁观端零信号则多端视图腐烂(盯着已清窗口继续输入、列表残留已删对话)。裁决:`session.changed`(cleared / renamed / deleted / meta 变更)经同一组播名册推送,接入面据此刷新或退出视图;通知不是方法、不进方法表。**旁观端的 user 消息投影**:发起消息经带外 `agent:run_start` 的 `prompt` 字段获得(机制现成),wire envelope 的 `meta` 携带 `turnOrigin` 以标注发起接入面。

**跨接入面的投递边界:事实统一,屏幕不镜像**。飞书不是远程终端镜像,而是社交通道里的对话入口;cli 是本机工作台、控制台、深度操作面。二者共享同一智能体与同一会话事实,但不是对等屏幕。裁决:

- 飞书消息必须进入统一 conversation;飞书发起的 turn 默认回复飞书,cli 打开同一会话时可看历史、可接续、可按 observer 语义旁观。
- cli 接续飞书会话时,消息写入同一 conversation,默认只在 cli 呈现,**不自动回显到飞书**。
- 只有用户明确选择"回复到飞书 / 发给对方 / 继续在飞书答复"时,才经 channel adapter 投递到飞书。
- 不做"飞书 ↔ cli 实时双向回显":那会把飞书变成终端日志窗口,让本机路径、权限、工具过程、工作流状态刷进移动端 / 办公 IM,带来噪音与隐私风险。
- 因此统一的是会话事实与执行权威,不是所有接入面的屏幕输出;各接入面按自身语境投影同一事实流。

两通道不并轨:把 yield 产出流硬并进观测 bus 是 core 事件模型变更,波及渠道与子 agent,违背零改原则。逐 token 一条 WS 通知,loopback 微秒级;预留 batch 参数(默认不开,实测超标才开)。

### 3.3 会话域 RPC 协议(方法表)

在 `server/src/rpc/methods/session.ts` 既有骨架(send/list/history/abort)上扩展,全部薄壳直达 ConversationManager / RuntimeHost:

| 方法 | 语义 | 备注 |
|---|---|---|
| `session.send` | 入队一个 turn(经唯一串行点) | 已有(enqueue + 上限 BUSY);扩展返回排队位 |
| `session.subscribe` / `unsubscribe` | 订阅带外事件谱(AgentEventMap 投影,见 3.2) | 新建;订阅即 observer 登记(组播名册),与主通道 delta 并行、不替代 |
| `session.abort` | 打断当前 run / 撤回自己排队项 | 队列项带来源,只能撤自己的 |
| `session.list` / `history` | 对话列表 / 倒读分页 | 已有骨架但均为活跃会话视图:list 现状是 `manager.list()`(仅活跃),改造为 convRepo 全量列表(/resume 候选源);history 现状为活跃会话内存历史(非活跃 notFound),改造为 readRunsReverse 倒读分页、不要求会话活跃 |
| `session.clear` / `resume` / `compact` / `new` | 会话命令执行体 | cli 命令 handler 变薄:分发在 cli、执行经此 |
| `session.rename` / `delete` | 对话改名(/name)/ 删除(/resume inline 删除) | delete 既有方法语义是"删除运行时",对齐为含落盘数据删除 |
| `workscene.enter` / `exit` | 取 / 建场景当前对话(原子查询创建)/ touch(语义见裁决 3) | 无状态机、无 status 方法——接入面当前场景是连接级 UI 态,宿主零知识;实例随 send 按场景 profile 发放 |
| `workscene.list` / `create` / `rename` / `delete` | 场景候选列表 + 登记管理(/work 选择器及 inline CRUD) | 场景注册表读写路径随之收宿主(正常态零直读,见裁决 4) |
| `confirmation.list` / `resolve`(+Bridge 推送 `pending` / `resolved`) | 确认的可见与应答回程 | 已有骨架;**语义须按裁决 5 升级**(应答权改 origin surface、decision 按信任级分级),现状白名单不可直接复用 |
| `trust.list` / `revoke` | 信任规则管理(/trust 查看与撤销) | 操作盘上持久规则;规则沉淀经确认链路自然在宿主;/mcp、/security 的状态查询同理改问宿主(并入 server.info 族或随实现归位) |
| `skill.list` / `setState` / `archive` | 技能管理(/skills 列表、启停 / 置顶 / 模式、归档)+ slash 补全候选源 | 现状管理器本地写 `store.setState`(pinned / disabled)与 `store.archive`(目录移至 archived/ + 结构版本递增——语义独立于 setState,不合并),随 skillStore 单写者收宿主;补全候选在收到 3.5 变更通知后经 list 拉取 |
| `memory.journalStats` / `peopleList` | 记忆域查看(/journal 统计、/people 关系列表) | 现状命令本地直读 JournalStore / PeopleStore;memory 收宿主后按裁决 4 正常态读也经 RPC;journal 生命周期维护(写)收宿主自跑、不设方法 |
| `runtime.reload` | 配置热重载(blue-green 平移宿主) | config 编辑仍在 cli TTY,落盘后触发 |
| `server.info` / `server.shutdown` | 状态权威视图 + 协议握手 + 显式停止的 RPC 原语(占用红线的手动保底,见裁决 8) | RPC 仍取既有 server 域(`server.shutdown` 已有 serve stop 优雅停机链消费),但用户入口不暴露 host / daemon 概念:info 投影到交互内 `/status` 只读展示,shutdown 投影到交互内 `/stop` 控制动作;info 是 `/status` 与运行控制判定的单一权威数据源,含 protocol(兼容判定,见 3.4 裁决 7)、运行时长、接入面摘要(当前终端 / 飞书 / 其它终端)、活跃与忙碌会话、activeWork / deferredWork / keepAliveWork 权威快照、生命周期阶段、最近错误、reload / reconnect 状态、内存基线、日志路径、resolvedWorkspace(cli 的 @ 补全 root 与路径展示改取宿主解析值,本地 `?? process.cwd()` 兜底随收编消失);activeWork 是用户可见"正在处理"的汇总,必须细分为 cancellableWork 与 drainOnlyWork:cancellableWork 只包含会话 busy turn / pending queue 与 scheduler in-flight run,可被取消;drainOnlyWork 只包含用户可见 delivery/outbox 正在发送或可立即 drain 的未完成项,不可取消、只能主动 drain 或等待;activeWork 明确排除 conversation task_list 待办、未来计划但未运行的 schedule、已持久化等待重试的投递;deferredWork 表达已持久化但当前不可立即发送的用户可见投递,停止时保留、下次启动继续尝试,不阻塞 drain;keepAliveWork 只表达"会让宿主继续在场的未来用户工作"(如 enabled 非内部 schedule),不算可取消的当前工作;不得让 `/stop`、`zz serve stop` 各自拼状态;shutdown 支持策略化停止:`immediate` 空闲即时停、`drain` 拒新后主动 drain drainOnlyWork 并等 activeWork 清空再停、`cancel` 取消 cancellableWork 后继续 drain drainOnlyWork 再停 |

**方法表完备性约束**:凡 cli 命令现存的本地写路径——`convRepo` 的 rename / clearViewLayerState / touch / 删除、场景注册表 CRUD、trust 规则撤销(`store.revoke`)、技能管理(`skillStore.setState` / `skillStore.archive`)——必须全部有对应 RPC 方法承接;任何一条漏掉,阶段 B 后 cli 就残留本地写实例,3.5 的结构性验收即不成立。

命令系统(registry / dispatcher,ADR-009 形态)不动——会话命令的 handler 实现从直驱改为 facade 调用,分发架构零改。

**用户可见的运行控制语义**:用户不需要理解 host / daemon / server。产品语义只有三件事:看状态、停止知行、退出当前终端。

- `/status` 只读,回答"知行现在是什么状态",不混入停止 / 重启等操作。展示项按用户语言组织:当前终端、飞书 / 其它接入面、运行中任务、排队消息、未送达消息、已启用定时任务、最近错误、日志位置;末尾只给提示:"如需完全停止知行,输入 `/stop`。"
- `zz serve status` 保留为非交互诊断 / 脚本只读入口,只回答进程四态与日志位置,不替代交互内 `/status`,也不承载停止 / 重启操作。它的文案必须保持"按需打开 `zz` 会自动恢复 / 启动"的用户语言,不得把用户带回 host / daemon 心智。
- `/stop` 是独立控制指令,语义是"停止知行的后台运行能力",不是退出当前终端。它必须先说明影响再确认,复杂度随风险分级:
  - 确认交互统一调用 [选择模块架构](./selection-module-architecture.md) 的 `SelectionService`:选项最多 5 个、一次看完、无滚动;选择模块只返回结构化结果,业务动作仍由 `/stop` handler 执行。
  - 无其它接入面、无 activeWork、无 deferredWork、无 keepAliveWork:`停止知行并退出当前终端? 下次打开 zz 会自动启动。` 选项:停止 / 取消。
  - 有飞书或其它终端在线,或有 keepAliveWork:`停止知行后,飞书将暂时无法回复,其它终端会断开,已启用的定时任务在知行再次启动前不会执行。下次打开 zz 会自动启动。` 选项:停止 / 取消。文案按实际存在项裁剪,不展示不存在的影响。
  - 有 cancellableWork 或 drainOnlyWork:`知行正在处理工作。` 选项按实际工作类型生成:始终提供"等已接收工作完成后停止"与"返回";只有存在 cancellableWork 时才提供"取消当前可取消工作并停止",且必须二次确认;若只有 drainOnlyWork,不得展示取消选项。普通 task_list 待办与已持久化等待重试的投递不触发此档位。
  - 只有 deferredWork 而无 activeWork 时,停止前只提示:`还有未送达消息,会保留并在下次启动后继续尝试。` 不要求用户等待,也不静默丢弃。
- 普通退出只退出当前接入面,不等价于停止知行。退出后在 shell 前给一行低打扰提示:
  - 无其它接入面、无 activeWork、无 deferredWork、无 keepAliveWork:`已退出当前终端。知行会在空闲后自动停止。`
  - 飞书在线:`已退出当前终端。知行仍在飞书中运行。`
  - 其它终端在线:`已退出当前终端。知行仍在其它终端中运行。`
  - 有 activeWork:`已退出当前终端。知行仍在处理任务,完成后会按空闲策略停止。`
  - 有 deferredWork:`已退出当前终端。仍有未送达消息,会在后台继续尝试;若知行空闲停止,下次启动后继续尝试。`
  - 有 keepAliveWork:`已退出当前终端。知行仍在后台等待已启用的定时任务。`
  - 多个条件同时存在时合并为一句,优先说明用户最关心的影响,例如:`已退出当前终端。知行仍在飞书中运行,并有任务正在处理。`

### 3.4 逐条裁决(开放问题 → 决策)

1. **流式形态**:见 3.2。
2. **/config 热重载**:编辑器留 cli(TTY 交互),写盘后 `runtime.reload` 触发宿主 blue-green;MCP 连接、技能索引、记忆随 RuntimeHost 在宿主,reload 语义不变、位置变。
3. **workscene**:场景态迁宿主并降为**对话的静态属性**(见 3.1 迁移前置二)。`workscene.enter` = 宿主取 / 建场景当前对话并返回(原子查询 / 创建,唯一写副作用是建对话目录——失败即无事发生,接入面不切指针即可,**无 undo 栈、无事务回滚机器**;那些是 cli 单槽 overlay 争用的产物,per-conversation 实例下问题本身不存在);`exit` = 接入面切回 main 对话的指针行为,宿主至多 touch 场景(未来退出纪要的挂点——纪要本身是场景记忆域的产物,随实例末窗,不是宿主方法状态)。场景对话的 runtime 实例随 send 按 power profile 发放,生命周期即 ManagedSession 的 grace/idle。多场景多对话并发互不干扰;接入面的模式横幅 = 当前对话 id 的纯函数派生(解析出 sceneId),场景显示名取自 enter 响应或 list;任何接入面都可 enter/exit(远期飞书进场景免费获得)。
   **宿主侧执行细化**:①场景对话的全域键编码归属——`ws:<sceneId>:<convId>`(渠道对话 `dm:feishu:x` 的同构先例),解析单点在 core;send 路由(id→power 装配)、持久化路由(id→per-scope store)、目录路由全部纯函数派生,静态属性由结构保证。②管理面(list/create/rename/delete)薄壳直达场景注册表。③**不设 workscene.status**——"接入面当前在哪个场景"是连接级 UI 态,宿主对此零知识;设 status 就是给宿主级 activeMode 留形态复活点。④session.list 保持 user scope——场景是独立工作台,main 列表不混场景对话。
   **LLM 触发的进出场景**(turn 内工具产生意图、`RunResult.pendingModeSwitch` 于 turn 边界 last-wins 带出——现状 repl 消费、serve 忽略):收编后意图经**定向通知**(`session.modeSwitchIntent`,先于 complete 发送)只达发起连接——可执行控制意图不随 complete 组播,**跟随权归发起接入面由结构保证**(旁观端物理不可达,不靠客户端自律;旁观提示如需要,只给只读状态)。发起端收到后走 `workscene.enter` / `exit` 同一 RPC 执行体——与 /work 命令的双源汇聚结构保留、汇聚点平移到接入面;接入面只切指针(纯 UI、无副作用),宿主侧无事务可回滚。
4. **失败形态**:ensureHost 自动拉起 + 有限重试 → 失败进**只读浏览 + 引导修复**(对话列表 / 历史直读磁盘——读容错纪律已建,不破单写者;输入区提示宿主不可用与修复指引)。正常态一切读写经 RPC(单接口);直读磁盘仅此降级态,且**只经独立只读通道**(`readRunsReverse` 等 reader 函数——现状已是文件级独立 API,cli 的历史尾巴即此形态),不得为降级态构造 Store 实例,否则 3.7"无 Store 写实例"的结构性验收失效。
5. **确认归属与协议升级**:弹给发起接入面(turnOrigin 路由已有,ConfirmationHub/Bridge 复用);旁观接入面收"确认进行中"状态事件,**可见不可代答**。现有 `confirmation.resolve` 的语义**不能直接复用**,须升级为终态协议——它的 decision 白名单(仅 allow-once / deny)与应答权(observer 即可答)都建立在"本地 = 进程内 broker、远程 = RPC"的传输形态边界上,cli 收编后该前提瓦解(cli 也走 RPC):
   - **应答权**:resolve 校验"发起接入面"资格(默认仅 origin surface 可答),不再是 observer 即可。
   - **decision 能力按接入面信任级分级**:可信接入面(本机 cli——loopback + home 凭证)可提交完整 ConfirmationDecision(含 allow-session / context / global,持久授权统一落宿主 permissionStore,单写者保持);非可信接入面维持 allow-once / deny 白名单(原"远程不得沉淀永久规则"的安全意图在身份模型下完整保留;远程接入面的可信身份模型留待真实需求)。
   - cli 确认面板能力**零降级**是此升级的验收锚;不为持久授权另起本地 broker / localConfirmation 旁路。
6. **会话命令归属**:见 3.3 表——分发在 cli、执行体在宿主,handler 变薄不变形。
7. **版本偏斜**:握手交换 **protocolVersion(兼容区间)**,与 build 版本分开判。协议兼容 → 正常运行;build 不同仅作换代信号:宿主无其它活跃接入面 → cli 请求宿主优雅退出并拉起新版本,有其它活跃端 → 状态行提示"宿主版本待更新"、择机换代。**协议不兼容 → 禁止写操作**,进只读浏览 + 引导修复(复用裁决 4 的降级形态)——不允许 schema 不匹配的带病运行。
8. **可观测性与占用防线**:用户可见模型是"知行是否仍在运行",不是"host / daemon / server 是否还活着"。交互语义以 3.3「用户可见的运行控制语义」为单一权威:`/status` 只读、`/stop` 独立控制、普通退出只退出当前接入面。宿主重启 / 换代在 cli 状态行提示,但文案仍以"知行正在应用配置 / 正在恢复连接 / 后台服务已重启"表达,不要求用户理解进程模型。**异常占用不释放是红线**,三层防线:
   - **正常层**:无接入面、无 activeWork 且无 keepAliveWork → idle 自动退出(既有);per-home 单例端口仲裁保证宿主永不堆积(既有)。enabled 非内部 schedule 属于 keepAliveWork,会阻止 idle 退出;内部维护任务不算 keepAliveWork;已持久化等待重试的投递属于 deferredWork,不阻止 idle 退出,下次宿主启动后继续尝试。
   - **手动保底**:主入口是交互内 `/stop`——停止是带上下文的决策,不是"退出当前终端"。确认面由 `SelectionService` 承载,展示其它接入面、activeWork(按 cancellableWork / drainOnlyWork 分组)、deferredWork 与 keepAliveWork 摘要,并说明影响:当前终端会退出,飞书 / 其它远程接入会暂时不可用,已启用的定时任务在知行再次启动前不会执行,未送达消息会保留到下次启动继续尝试,下次 `zz` 会自动重新启动。若有进行中工作,用户选择等待完成 / 取消当前可取消工作并停止 / 返回;等待完成必须先进入 quiescing,通过宿主级写闸门拒绝所有新工作入口(通道入站、RPC `session.send`、新的 scheduler timer fire、手动 `schedule.run` 以及会产生新工作或启用未来 fire 的 schedule 写操作),但保留 `/status`、取消、停止确认等控制读写,随后主动触发 delivery ready queue drain,并等待 outbox idle 与会话 / scheduler activeWork 清空后 shutdown;不得只依赖 delivery 定时器或已有 activeFlush。取消只覆盖 cancellableWork(会话 turn、会话排队消息与 scheduler in-flight run),不可取消的 drainOnlyWork 仍要主动 drain 或等待,已持久化等待重试的投递保留;宿主 flush 全部会话落盘后优雅退出。`zz serve stop` 仅为非交互应急保底(脚本 / 交互不可用时):默认安全——经 RPC 查同一份运行控制快照,存在其它接入面、activeWork 或 keepAliveWork 则拒绝并提示进交互处理,不复刻交互选择,绝不静默杀掉进行中的工作或暂停用户定时任务;deferredWork 不阻止非交互停止,因为它已持久化且可下次启动继续;RPC 不通且 PID 存活则落入下方僵死处置分支。**不设 --force 参数**——交互决策不塞进命令行参数。
   - **僵死处置**:ensureHost 连接超时但 PID 存活 → 判定僵死 → 终止旧进程(SIGTERM,限时不退则 SIGKILL)→ 重拉新宿主(客户端发现现状不做 stale 检查,此判定在连接层补上)。已接受数据零丢失由接受协议保证(同崩溃恢复路径)。
   - **普通退出提示**:退出 cli 只表示离开当前接入面,不自动停止知行。若飞书 / 其它终端 / activeWork / deferredWork / keepAliveWork 仍在,退出终端前后给低打扰提示:"已退出当前终端,知行仍在飞书中运行 / 仍在处理任务 / 有未送达消息 / 已启用定时任务会继续生效;如需完全停止,重新打开 `zz` 后输入 `/stop`。"若无其它接入面、无 activeWork、无 deferredWork 且无 keepAliveWork,提示"知行会在空闲后自动停止"。
   不做内存水位自杀一类的主动防线——正常占用可用,异常由上述三层兜住,不引入误杀正常负载的机制。
9. **abort**:见 3.3 表。
10. **渠道对话升格**:对话在**持久化时刻**写 meta.json(name = 渠道身份显示名)——persistent 会话建立即写,ephemeral 会话随 promote 落盘补写(ephemeral 纯内存、建立时无处可写,EphemeralRunBuffer 机制与 meta 升格正交、保留不动)。落盘对话全量进列表、cli 可 /resume;隐式分离退场的对象是「落盘却不写 meta 以藏出列表」的约定。
11. **迁移**:见 3.6。

### 3.5 单写者收口

transcript / skill / memory / snapshot / permission(trust 规则)的全部写入随 RuntimeHost + ConversationManager 收进宿主进程。随之消解:transcript 跨进程并发考量(GC 零索引写的约束保留——它同时防的是进程内竞态,但跨进程场景消失)、skillStore 结构版本跨进程漂移(cli 的 slash 补全改为订阅宿主技能集变更通知——通知携带结构版本号、版本驱动 refresh,与现 skillVersionSeen 机制同构)、conversationsDir 双进程写。**cli 进程不再持有任何 Store 写实例**。达成点在阶段 B(cli 收编)——阶段 A 不声明此项,见 3.6。

### 3.6 迁移路径(三阶段,守两硬约束)

- **阶段 A·宿主能力完备化**(cli 接入路径与行为零变化;headless 化重构发生在 cli 包内但 repl 直驱路径不动):两项迁移前置落地(headless 化 + RuntimeHost 两层结构,见 3.1);session.* / workscene.* 方法表按 3.3 补全(含 rename / delete / 场景 CRUD,history 改 readRunsReverse 倒读分页);双通道补全(delta 保留为主通道、推送改 observer 组播,带外事件经转发装饰器按 3.2 wire 纪律进连接);RuntimeHost 进宿主装配(serve 既有「共享资产 + per-conversation 实例」结构升格为实例层;闭包式对话差异改执行期 RunContext 派生,窗口从 SessionRuntime wrapper 挪入 ManagedSession)。此阶段 cli 对话 owner 仍在 cli、渠道对话 owner 在宿主——两域不相交(隐式分离仍在),conversation 单 owner 成立。**本阶段不声明全局 store 单写者达成**:skill / memory / snapshot 的 cli 直驱写面与现状 serve + cli 并存完全相同、不新增;全局单写者随阶段 B 一并成立(不为此建 cli 经宿主代写的临时通道——那是第三套中间形态)。
- **阶段 B·cli 收编**(原子切换,不留双路径):repl 会话路径整体切 RPC(RpcConversationFacade + RpcEventBus);删除 cli 侧 RuntimeSession 直驱、state.conv 的 window/store 实例。cli 自此**没有 owner 能力**——单 owner 由结构保证而非纪律。chrome / typeahead / 确认面板 / 历史尾巴(读经 RPC history)全部保留。
- **阶段 C·对话域统一**:渠道对话升格 meta、cli 列表呈现身份、隐式分离退场;清理两域时代的残留约定。

每阶段是终态子集(A 建的全是终态组件;B 删旧不建临时层;C 纯数据语义清理)——无第三套中间形态。

### 3.7 验收纲

- **体验底线**:首 token 延迟增量与流式帧率无感(loopback);`zz` 打开到可输入不显著变长(宿主拉起 / 连接与 cli 启动并行);宿主内存基线纳入观测。
- **单 owner**:结构性验收——cli 进程无 Store 写实例、无窗口实例(grep 级 + 架构评审);**所有管理命令零本地写**(/name、/resume inline 删除、/work 场景 CRUD、/clear 视图态清理、/trust 撤销、/skills 启停 / 置顶 / 模式 / 归档全部经 RPC);grep 验收对象 = cli 侧 convRepo / 场景注册表 / permissionStore / skillStore / 记忆域仓(JournalStore / PeopleStore / MemoryStore)/ transcript / snapshot 的全部写调用与实例构造。
- **功能全谱经 RPC**:对话 / 流式 / 工具事件 / 确认(**含持久授权全选项**,见裁决 5)/ 段切换提示 / /clear / /resume / /compact / workscene / reload / 技能(索引随宿主 runtime、slash 补全随事件刷新)在 cli 全部如常。
- **多端连续**:飞书对话进统一会话事实,cli 可见可续;cli 接续飞书会话默认不回显到飞书,只有显式"回复到飞书 / 发给对方"才投递到 channel;多 observer 同看一个流式 turn。
- **生命周期**:cli 离场 grace 接管、宿主 idle 退出、版本换代握手生效;**宿主非优雅崩溃可恢复**——已接受的 run 零丢失(接受协议先持久化后入窗),进行中 turn 丢弃,cli 收到连接断后自动 ensureHost 重连并提示(恒独立进程模型的新增故障面,须有显式验收)。**占用红线**(裁决 8):关闭全部接入面且无 activeWork / keepAliveWork → idle 窗口后宿主进程必退(进程级验证);enabled 非内部 schedule 会作为 keepAliveWork 阻止 idle 退出;已持久化等待重试的投递不阻止 idle,但必须在下次启动后继续尝试;`/status` 只读展示知行运行状态与接入面占用;普通退出在飞书 / 其它终端 / activeWork / deferredWork / keepAliveWork 仍在时给明确提示;`/stop` 经影响确认后进程必退且数据落盘,其中"等已接收工作完成后停止"必须先关闭所有新工作入口,主动 drain delivery/outbox ready 工作,再等 activeWork 清空;取消路径只取消 cancellableWork,drainOnlyWork 不被误标为可取消;`zz serve stop` 在存在其它接入面、activeWork 或 keepAliveWork 时默认拒绝、绝不静默杀;僵死宿主可被 ensureHost 判定并替换。

---

## 四、执行计划

> 主线 11 步每步构成一个值得提交的完整单元:绿色构建 + 全量测试 + 独立 commit。依赖:1→2→3 严格串行(地基);4 / 5 / 6 在 3 之后可并行;7 只依赖 6 的 host 方法;8 可与阶段 A 后期并行;9 须等 A 全部完成;10 在 9 后;11 收尾。3.7 验收纲在第 9、10、11 步后各做一次端到端实测(多端连续组需配飞书实测)。

> `/stop` 的交互前置已完成:独立选择模块已作为 CLI TUI 基础设施落地。后续实现只接入 `SelectionService`,不得新造停止专用选择面板。

### 阶段 A·宿主能力完备化(步 1–7,期间 cli 行为零变化)

1. **RuntimeSession headless 化**——依赖反转:拆出无 UI 类型依赖的核心,TTY 三件套与确认渲染器改为两个装配钩子(per-run 装饰钩子 + broker 接线钩子),repl 传既有实现。纯 cli 包内重构,测试锚定零行为变化。
2. **RuntimeHost 两层结构**——资产层(provider / MCP / 技能库 / 段切换依赖)+ 实例层(per-conversation 发放、profile 按对话场景属性);serve 的 factory 升格为实例层;`scheduleOrigin` 改执行期 RunContext 派生;reload 改"资产重建 + 活跃实例同事务换代"。
3. **窗口归 ManagedSession**——从 SessionRuntime wrapper 挪出,ConversationManager 成为窗口 / turnCounter / 接受协议的唯一权威;runTurnWithCommit 补 pendingModeSwitch 透传。
4. **双通道与通知面**——带外事件转发装饰器(wire envelope / UI 订阅集裁剪 / lineage)、推送改 observer 组播、`session.changed` 会话级通知、`session.subscribe` 登记。
5. **session / workscene 方法域补全**——rename / delete 语义对齐、history 改 readRunsReverse、list 改全量;workscene 全组(对话静态属性模型:`ws:` 全域键路由、enter 原子查询创建、exit 仅 touch、管理面薄壳——宿主无状态机、无 status 方法,见裁决 3 执行细化)。
6. **confirmation 升级 + 管理面方法域**——应答权改 origin surface、decision 信任分级;trust / skill / memory 方法组;server.info 扩展为知行运行状态权威视图(`/status` 只读投影),server.shutdown 作为 `/stop` 与非交互应急停止的底层原语(占用红线三层防线、协议版本与 auth 握手同源)。
7. **宿主 profile 升格**——cli 拉起的常驻宿主按配置装配渠道与 MCP(飞书随配置常驻生效)。

### 阶段 B·cli 收编(步 8–10,核心是一次原子切换)

8. **cli 接入设施**——CoreHostConnection 升格三域共享单连接、RpcConversationFacade、RpcEventBus(per-run 投影 bus);先建成、测试齐,不接主路径。
9. **原子切换**——repl 会话路径整体切 RPC:send / 渲染喂入 / 命令 handler 变薄 / 确认面板接 confirmation.* / 补全改 RPC 源 / journal 维护收宿主;同一单元内删除 `state.conv` 直驱、cli 侧全部 Store 写实例与窗口实例。切完跑 3.7"单 owner"grep 验收与功能全谱验收。
10. **故障面落地**——只读浏览降级态(独立只读通道)、崩溃重连提示、版本握手与换代、僵死处置。

### 阶段 C·对话域统一(步 11)

11. **meta 升格与清理**——持久化时刻写 meta(ephemeral 随 promote 补)、渠道对话进列表可 /resume、隐式分离退场、两域残留约定清理(含 serve 的 InMemoryTaskListStore 统一)。

### 补充单元·运行控制交互收口

12. **运行控制交互收口**——把 3.3 与裁决 8 的用户语义落成一个完整提交单元:先引入宿主 activity snapshot provider,由 server 统一聚合会话 busy/pending、runRegistry size、delivery/outbox active/deferred stats、enabled 非内部 schedule、接入面状态与生命周期阶段;`server.info` 暴露 activeWork、cancellableWork、drainOnlyWork、deferredWork、keepAliveWork、最近错误、reload / reconnect 状态与 quiescing/stopping 阶段。activeWork 是 cancellableWork + drainOnlyWork 的用户可见汇总:cancellableWork 只包含会话 busy/pending 与 scheduler in-flight,可被取消;drainOnlyWork 只包含 delivery/outbox 正在发送或可立即 drain 的用户可见投递,不可取消但停止前必须主动 drain 或等待;activeWork 排除 task_list 待办、未来计划但未运行的 schedule、已持久化等待重试的投递;deferredWork 只表达已持久化但当前不可立即发送的用户可见投递,停止时保留、下次启动继续尝试,不阻塞 drain;keepAliveWork 只由 enabled 非内部 schedule 等未来用户工作组成,阻止 idle 退出但不算当前可取消工作。`/status` 改为该快照的只读用户投影,展示当前终端、飞书 / 其它接入面、运行中工作、排队消息、未送达消息、已启用定时任务、最近错误与日志位置,仅提示用 `/stop` 完全停止;`zz serve status` 保留为非交互诊断 / 脚本只读入口,只显示四态、pid / port / uptime / log 等运维信息,不替代 `/status`;`/stop` 调用 `SelectionService` 承载影响确认,由 handler 基于同一份 `server.info` 分级生成选项,再按选择调用停止策略:空闲即时停、拒新并等待 activeWork 清空后停、取消 cancellableWork 后继续 drainOnlyWork 再停、返回。拒新必须通过宿主级写闸门覆盖所有新工作入口:InboundRouter 新入站、RPC `session.send`、新的 scheduler timer fire、手动 `schedule.run`、以及会产生新工作或启用未来 fire 的 schedule 写操作;读状态、取消与停止控制入口继续可用,防止等待期间继续接收新工作且不锁死控制面。等待完成路径必须主动调用 delivery.flush 处理 ready queue,再等待 outbox idle 与会话 / scheduler activeWork 清空;不得只等待既有 activeFlush 或 delivery 定时器。取消只覆盖 cancellableWork;若仍有 drainOnlyWork,继续执行同一 drain 流程;已持久化等待重试的投递保留到下次启动。最终通过 `server.shutdown` 的策略化入口优雅退出。普通退出只断开当前接入面,若飞书 / 其它终端 / activeWork / deferredWork / keepAliveWork 仍在则给低打扰提示;`zz serve stop` 保持非交互保底,先经 RPC 读取同一份运行控制快照,存在其它接入面、activeWork 或 keepAliveWork 则拒绝并引导回交互内 `/stop`,deferredWork 不阻止停止但必须保留;RPC 不通且 PID 存活才进入僵死处置链路。验收以用户语义为准:不暴露 host / daemon 概念,不新增 `--force`,不静默杀掉进行中的工作、不暂停用户定时任务、不丢未送达消息。
