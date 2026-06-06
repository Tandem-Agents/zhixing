# 调度器架构 (Scheduler Architecture)

> **定位**:梳理知行调度器(周期性任务调度 + 系统级维护机制)的职责、能力边界与演进需求,作为该子系统的单一参照。
>
> **范围约束**:本文聚焦调度器的**需求与架构梳理**(它该承载什么、边界在哪、现状与局限、往哪演进),不展开与之无关的实现细节。

---

## 一、需求与原则锚定

### 需求

1. 需要能支持周期性持久化维护（过期持久化文档删除）。
2. 需要能支持周期性 skills 维护（skill 淘汰），可能和持久化不是一个周期和频率；也就是说整个架构要能支持不同周期、不同频率的周期任务。
3. 需要能支持用户的一类需求：每天 n 点，帮我收集信息、任务；今天 n 点提醒我干啥。
4. 需要能支持用户的一类需求：1 个小时后提醒我干啥。
5. 能支持多个 zhixing 并行使用功能（一个用户运行了好几个 zhixing）。
6. 实现必须和平台无关（cli、server 等），并且表现一致。

需求补充：

1、场景：如果任务触发，但是zhixing没在跑，比如 任务1、2、3都错过了；

怎么处理：如果现已系统有相关实现，直接删了，处理干净；然后把相关状态维护好，未来再决定使用侧怎么接收；现阶段把提供侧的准备工作做好；

### 要求

1. 常驻开销要极低：空闲时 CPU 近乎为零（定时唤醒、不忙等轮询），内存随任务数有界、不随运行时长增长（无泄漏），不让调度本身成为系统负担。
2. 要够健壮，不能动不动就罢工；尽量自己内部解决问题，遇到不可抗力无法处理要有反馈给用户，而且要友好反馈。
3. 杜绝失控级（runaway）故障：死循环、CPU 占满、内存泄漏 OOM、任务触发 / 重试风暴等都不允许；失败必须有硬上界（超时、退避上限、最大重试、并发上限），且单任务失败被隔离、绝不升级成进程级灾难（挂死 / 崩溃 / 资源耗尽）。

### 怎么处理已经实现的调度器版本

1. 先了解已有实现，核实已实现的每一处细节，知道现有架构和短板。
2. 依据原则，只要最优架构和方案；如果现有架构符合最优方向，那就基于它改造和扩展，如果它不是最优架构方向，那就直接重构。

### 原则

1. 我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计。

---

## 二、现有运行方式与割裂的现状

> 一手核实：`cli/src/index.ts`（命令注册）、`cli/runtime/session.ts:317` 与 `serve/command.ts:451`（两处 scheduler 装配）。

### 运行方式

- `zz`：交互模式（REPL），对话终端，日常主用法。
- `zz -p "..."`：单次执行，跑一次即退出。
- `zz serve`：服务模式（serve）前台——常驻进程 = HTTP + WebSocket + 调度器 + 按配置接渠道（飞书等），占住终端、长驻。
- `zz serve --daemon`：同一 serve 进程的后台姿态（守护进程 daemon）——脱离终端独立运行，配 `serve stop / logs / status` 管理。
- `zz rpc <方法>`：远程调用（RPC）客户端，连上已在跑的 serve 发请求。

要点：**没有独立的 `zz daemon` 命令**。守护进程（daemon）不是单独程序，是 serve 的"后台运行"开关（`--daemon`）；serve 与 daemon 跑的是同一个 server，区别只在前台 / 后台。

### 割裂的现状（多实例零协调）

"交互模式"与"后台服务"之间没有任何桥，各起各的调度器、互不知情：

- `zz` 交互启动时在 cli 进程内**无条件自起**一个 Scheduler（`session.ts:317`，关终端即随进程消失），且**不传 `systemHandlers`** → 这个调度器跑不了系统维护任务。
- `zz serve` 另起一个 Scheduler（`command.ts:451`，传了 `systemHandlers` + delivery）。
- 两者的 store 默认都指向**同一份** `~/.zhixing/scheduler.json`，构造入参里无锁、无 leader、无任何协调。

后果：开 N 个终端 = N 个调度器抢同一文件——同一定时任务被执行 N 次、各自用旧内存快照 save 互相覆盖丢任务。`process-lock`（`process-lock.ts`）只保 daemon 的端口 / PID 单例（仅 serve 的 `runServer` 内 `acquireLock`、且在 `scheduler.start` 之后），**保护不到调度器的执行**；交互模式根本不走它。

这正是"交互模式"与"后台服务"缺一座桥的根因——第三部分的「单一调度权威 + 确保拉起（ensure）」就是来架这座桥。

---

## 三、新架构

> 核实基于一手源码：scheduler 全包（scheduler / timer-loop / task-executor / error-policy / task-store / run-registry）+ 进程模型（server/process-lock、cli/serve/daemon、cli/runtime/session 与 serve/command 的装配点）。

### 现状核实

**好的骨架（符合最优方向，保留改造）：**

- 分层干净：Scheduler 协调 / TimerLoop 定时 / TaskExecutor 执行 / ErrorPolicy 退避 / TaskStore 持久化 / RunRegistry 可中断，职责分离 + 依赖注入 + 可测时钟。
- 低开销定时：`setTimeout` 动态唤醒（非忙等轮询）+ `unref`（不阻进程退出）——已满足「要求 1」空闲近零开销。
- 有界失败：执行超时 + 指数退避 + Full Jitter + 并发上限 + 连续失败 auto-disable + 优雅停机 drain——已覆盖「要求 3」大部分。
- 统一任务模型：once / interval / cron × agent-turn / system 两类动作；系统任务走 `systemHandlers` + `task.system`（不可删）——`__journal-gc` handler 已注册，「需求 1/2」的**通道**已在（但运行态承载需落地，见决策 5）。
- 原子写：JsonTaskStore 先写 `.tmp` 再 rename。
- 平台无关内核：核心包只靠 DI（runAgentTurn / store / systemHandlers），不绑任何平台。
- **daemon 侧已是完整调度宿主、RPC 接入已就位**：`serve` 装配了独立 `ephemeralRuntime`（定时执行、零磁盘痕迹）+ delivery + 端口 listen 单例（`server.pid` / `server.port` / token 文件为发现辅助、单例由端口 listen 的 EADDRINUSE 保证，见决策 7）+ `systemHandlers`（含 `__journal-gc` handler，仅注册、无运行实例——见决策 5）；RPC 完整暴露 `schedule.create / list / update / delete / run / abortRun` + 事件桥接（`schedule.started / completed / disabled`）；cli 也已有 `RpcClient`。「单一权威 + RPC 接入」所需的基础设施已存在——这是决策 1 的复用基础（但「拉起方式」要轻，见决策 1③）。

**短板（对照需求 / 要求，必须重做）：**

1. **多实例零协调（最严重 —— 违「需求 5」+「要求 3」）**：cli 交互（session.ts）和 daemon（serve）都**无条件** `new Scheduler({ store: new JsonTaskStore() })`，共用同一个 `~/.zhixing/scheduler.json`，既无文件锁也无 leader。开 N 个终端 = N 个调度器：同一定时任务被执行 N 次、各自 save 用旧内存快照互相覆盖丢任务。现有 `process-lock` 只在 serve 内写 PID 旁路文件、**保护不到 scheduler 的执行**（交互模式根本不走它；真正的进程单例靠端口 listen，见短板 5 / 决策 7）。
2. **missed 是「补一次」（与第一部分需求冲突）**：`start()` 检测 missed + timer-loop `nextRunAt <= now` 补执行。新需求要的是「不补、记录事实」。
3. **同进程 save race**：save() 用固定 `.tmp` 路径，maxConcurrent=3 时多任务同时完成会并发写同一 `.tmp`，可能丢更新 / 损坏。
4. 执行语义未声明（幂等假设下的 at-least-once）。
5. **进程拓扑 / 接入层 / 生命周期的待补项（违「需求 5」+ 拖累未来依赖）**：端口默认 `18900` 且 ensure 沿用默认会让不同 `ZHIXING_HOME` 的实例撞 `EADDRINUSE`（违「需求 5」多实例并行——但动态端口+发现机制**已就位**：`listen(0)` OS 分配、回填 `listenAddr`、`acquireLock` 写 port 文件、`discoverServer` 读实际端口，差的只是 ensure 按 home 区分）；`RpcClient` 一次性连接、断即死、无重连（与 idle 宿主自动消失冲突）；`discoverServer` 只查进程存活、不查 scheduler 就绪；`runStartupCheck` mode-blind（schedule profile 仍按 server 模式校验 messaging）；agent runtime 无显式 `workspace.root` 时兜底 `process.cwd()`、两进程环境分叉。逐条见决策 7 与可执行 B / C。**注**：owner / 单例**不在此列**——现状端口 listen 即原子单例锁、PID/port 文件是发现辅助（`server.ts:8` 设计如此），与决策 7 主张一致、无需重做;唯一边角是 acquireLock 失败时 `server.close()` 自杀（仅「端口空闲但 PID 指向活进程」的残留场景，low）。

**判断（分三层，结论不同，不是笼统的「只改造」）：**

- **调度内核**（分层 / 低开销定时 / 有界失败 / 任务模型 / 原子写 / 平台无关内核）→ **保留**。依据是「从零按最优去推、也会得出这套标准要素」——是最优反推与现状重合，而非迁就现状。内核层仅有局部可优化耦合（`Scheduler` 协调类偏厚：CRUD + 执行编排 + 状态机 + 投递揉在一起；delivery 直接耦进调度器，更优做法是 scheduler 只产「完成事件 + 结果」、投递由独立消费者做），属**改造**取舍、非硬伤。
- **进程拓扑 / 权威模型 / 接入方式**（谁实例化 Scheduler、有几个、进程间怎么协作、cli 怎么接入、owner / 边界 / 生命周期怎么定）→ 现状是错的（N 个自包含 Scheduler 抢同一文件、零协调，且 owner / 单例 / 接入层一串硬伤见短板 5），**重构**——决策 1（单一核心宿主权威 + cli 改 RPC client）+ 决策 7（owner / 边界 / 生命周期协调）就是推翻这一层重做。
- **missed 语义** → **重做**（补一次 → 记录不补）。

合起来：**内核保留 + 拓扑重构 + missed 重做**，三层并存。

### 新架构：单一调度权威 + 多 client 接入

**核心宿主定位（一等概念，与「统一核心」方向对齐）** —— 这个"独立于终端的单一权威进程"不是"只会跑定时任务的专用 daemon"，而是**核心宿主（agent core host）**：每个 `ZHIXING_HOME` 唯一（单例边界见决策 7）、持有**一个 agent 核心**（身份 + 会话态 + 记忆 + 工具 + 调度能力）、对外 RPC 接入、一组**可运行时挂载 / 卸载的接入面（access surface）**的进程；**调度只是它当前点亮的第一个能力**。

把地基做对的关键是别选错承重件——恒定核心与可选接入面必须划清：

- **恒定核心（任何形态都在）**：agent 核心运行时 + **会话态 owner**（管理会话 / 上下文状态、保证 per-conversation 同一时刻只跑一个 turn；现状 `ConversationManager` 是其首个实现）+ Scheduler + RPC server（HTTP+WS 传输层，承载 RPC 接入与就绪探测）。核心运行时有**两条执行路径**：**会话执行面**（有状态，会话态 owner 实现）承载用户对话 / 远程会话，跨端共享、可接续；**无会话执行面**（`ephemeralRuntime`）承载定时 agent-turn 等"无需历史累积"的一次性执行。`ephemeralRuntime` 只是后者的特例、**不是核心运行时本体**——它 by-design 每次从空上下文起、不持会话（`ephemeral-executor.ts`），只配跑无状态调度任务；绝不能把它当"核心已就位"，否则 unified-core 要塞会话共享时是承重件替换、不是增量。
- **接入面（可挂载 / 卸载，profile 控制）**：cli stdio、飞书等 channel 适配器、MCP 工具源、未来 web——核心的 I/O 面与能力扩展，**不持核心状态**。"要轻"时该省的是**重接入面**（channel 长连接、MCP eager connect），**会话态 owner 不在可省之列**（它是核心、且本就轻、无外部连接）。

- **接入面 profile**（一等概念）：profile 不"砍核心"，**声明该档的完整行为画像**（启用哪组接入面 + 启动校验模式 + 生命周期，见可执行 B 的 `PROFILES` 描述符）。核心宿主按描述符**数据驱动装配**——每个接入面是带 `setup` 的单元（teardown 因 LIFO 时序约束走 shutdown-chain、不进单元接口，见可执行 B），装配 = 遍历启用集合各自 setup；新增接入面 = 注册一个单元 + 纳入某 profile 集合，**不回改装配主干**（杜绝 if-枚举式装配每加一面就改主干这一"声明面领先生效面"复发）。
  - **调度 profile（最小形态，ensure 拉起）**：恒定核心（会话执行面本轮可不实例化、只保留其挂载位）+ 不挂任何重接入面。够跑定时、且轻。
  - **全量 serve profile（显式 `zz serve`）**：调度 profile + 挂 channel + MCP + 点亮会话执行面。
  - **升格（schedule→full）本模块用「停旧起新」，热挂载留给未来**：接入面做成 `setup / teardown` 单元（解耦边界，为 unified-core 的运行时热挂载 / 位置切换留位）；但本模块**不预实现热挂载**——`zz serve` 要 full 时若已有 schedule 宿主在跑，经 RPC `server.shutdown` 令其 drain 退出（在跑任务跑完、释放端口）→ full 宿主接管（`scheduler.json` 持久、任务定义不丢），停机窗口秒级、与「定时尽力而为」一致。运行时热挂载（让已建 scheduler late-bind 新 delivery / channel——需改 `scheduler.ts:62/78` 的构造期 readonly 依赖）属 unified-core 那层、本模块不背，避免为远期需求过度预建。
- **远期方向（只标方向、不在本模块展开）**：知行是"一个"智能体——核心单例，cli / 飞书 / RPC 都是它的接入面，支撑"多端协同同一份工作"（独立模块，见 [unified-core-and-access-surfaces.md](./unified-core-and-access-surfaces.md)）。本进程就是该核心宿主的**最小形态**：本轮把恒定核心的**接口形态**与接入面挂载机制**按通用核心宿主定死**，会话共享 / 多端协同在该宿主上长出，不重起核心宿主。

- **诚实标注：本轮真正在场受力的恒定核心 = Scheduler + RPC server；会话态 owner 是「为 unified-core 留的承重位 / 接口形态」，本轮未受力验证。** 一手核实：cli REPL（`session.ts:91/158` 自持 `agentRuntime`、自起 scheduler）走本地 runtime、**完全不碰 ConversationManager**；schedule profile 不实例化它；它只在显式 `zz serve` full 在场。所以「会话态 owner 是恒定核心」当前是**接口承诺、非已受力的在场组件**。unified-core 需求1（cli 会话不锁死在 cli 进程内存）要把 cli 从「自持 agentRuntime」迁成「宿主会话执行面的 RPC client」——这是与决策1（迁 scheduler）**同量级的承重件迁移、不是增量**。地基本轮能做对的是：把「会话执行单一互斥入口」「会话态可被另一宿主接管（可序列化快照为单一事实源、live runtime 是其投影）」立为 owner 的**接口不变量**（见防债注记），让那次迁移落在已对的接口上——而不是把它写成「已就位、增量长出、不返工」。

> **前提**：定时任务需要一个**独立于 cli 终端**的后台进程来跑（不能依赖某个终端开着）。但「要求 1：要轻」决定了它**不是 7x24 守护、更不开机自启**——而是**按需启停**：用到时拉起、空闲退出。配合「missed = 尽力而为、错过记录」（决策 2），定时语义是「daemon 在则触发、不在则记录错过」，不是雷打不动。要雷打不动的强可靠定时，留给用户**显式** `serve` 常驻、或未来 OS 定时唤醒（见落地边界），不作默认。

**决策 1 —— 调度权威单一化到核心宿主**（解决多实例 + 定时的常驻本质）

- 每个 `ZHIXING_HOME` **只有核心宿主里一个 Scheduler 实例**（单例如何原子仲裁、边界多大见决策 7）。cli 交互 / cli 命令 / 未来任何接入面**都不自起 Scheduler**，而是作为 RPC client 向核心宿主注册、查询、取消、即时运行、订阅任务事件。
- 收益：单一真相源、零重复执行、零并发覆盖；多终端天然一致（终端只是 client）；平台无关（「需求 6」，都走同一宿主、行为一致）。
- **复用基础**：宿主调度装配 + RPC `schedule.*` + cli `RpcClient` 均现成（见现状核实），「单一权威 + RPC 接入」骨架已就位；缺的是 client 接入这一层、生命周期协调（决策 7）、接入面 profile 装配（核心宿主定位 / 可执行 B）。
- **核心新建（现状为零、是本决策的主体工作量）**：
  - ① cli 交互从「自起 Scheduler」改成「RPC client 接入核心宿主」——这条桥现状完全不存在（cli 交互纯 standalone）。
  - ② 核心宿主**按需拉起（懒）+ 空闲退出**（已拍板）：纯聊天会话零后台进程；仅在「用户碰调度（任何写 / 执行 schedule 操作）」或「cli 启动轻检查命中」（判据见可执行设计 C；含系统维护防饿死，见决策 5）时才 ensure。空闲自动退出（idle 判据 + ensure/idle 经端口原子交接 + client 重试，见决策 7）；近期一次性任务（如「1 小时后」）期间守到触发再退；显式 `zz serve` 长驻。ensure 失败 → **ensure 层封装的**友好提示「定时功能当前不可用：<原因>」+ 本次操作失败（**不**复用 spawnDaemon 面向人的原始日志倾倒、**不**静默记意图补建）。
  - ③ 拉起的是**调度 profile**（接入面装配分流见核心宿主定位 / 可执行 B）。`spawnDaemon` 本身 **profile 中立**（只透传参数、负责 detach / handshake），**可直接复用**——逼向全量的不是它，而是它转发的参数不带 profile + 下游 `runServerProcess` 恒全量装配 + startup check 走 server 模式。真正要改的是：`buildForwardedArgs` 透传 `--profile=schedule` + 下游按 profile 数据驱动装配 + startup check 按 profile 校验（见可执行 B / C），**而非"换掉 spawnDaemon"**。
- agent-turn 任务由宿主的**无会话执行面**（`ephemeralRuntime`）执行；任务的 **workspace / 上下文是任务自身的属性**（见防债注记），不是宿主进程的隐式 cwd。**cli 交互的对话本模块仍走 cli 本地 `agentRuntime`**（`session.ts:158`）——本模块只把 **scheduler** 从「cli 自起」改成「RPC client 接入宿主」，**不迁 cli 对话**；「cli 对话迁成宿主会话执行面的 client」属 unified-core 的承重件迁移（与本决策同量级，见核心宿主定位的诚实标注），不在本模块。任务结果回用户：在线走 RPC 事件 `schedule.completed`（现成）；离线补传归「使用侧、未来」（现有 delivery / origin 为 channel 设计，cli 终端不是 channel、不走 delivery）。
- 性质：**拓扑层重构**（「每进程自起」→「单一权威 + 多 client」），落点在接入方式与生命周期协调——接口与基础设施现成，重构实体是 cli 接入逻辑 + ensure / 生命周期机制。

**决策 2 —— missed = 记录事实、不补执行**（按第一部分需求）

- 关键不是删掉到点判断（timer-loop 的 `nextRunAt <= now` 同时承担「准时触发」，删了正常触发也没了），而是**在到点判断里分流**：
  - **在线到点**（`nextRunAt` 落在「本次上线时刻 − 容差」之后）→ 正常执行；被并发推迟也保持 due 等待、不因等待时长误判。
  - **离线错过**（`nextRunAt` 早于「本次上线时刻 − 容差」，即应触发于宿主离线期间）→ **不执行**，把这次错过记成一条**事实**（taskId、应触发时刻、检测到时刻）维护进状态，并把 `nextRunAt` 直接 advance 到下一个未来时刻（once 错过则标记 terminal-missed）。
  - **判据锚「本次上线时刻」、不锚 now**：锚 now（`now − nextRunAt > 容差`）会随时间漂移——在线但被并发饱和推迟的准时任务，迟到时长迟早越过容差被误判错过、once 因此被饿死永久丢失。锚上线时刻只区分「离线期间错过」与「在线到点」，在线并发延迟无论多久都不误判。
- 一并删掉 `start()` 里那个只 log 的 missed 计数——它不实际补执行，但属旧的「补」框架，清掉。
- 提供侧把「错过了哪些」做成可查询的状态 / 事件暴露；使用侧（开机后怎么告诉用户、补不补）留到未来。
- 副作用收益：杜绝「开机一次性补一堆」的触发风暴（呼应「要求 3」杜绝 runaway）。
- **与「按需起落」（决策 1②/可执行 C）同批落地、不可拆**：宿主时开时关，每次 ensure 后 `start()` 都会看到一批 `nextRunAt` 已过期的任务；若仍是旧「补一次」语义，按需起落反比常驻更频繁触发「每次拉起补一堆」的风暴——容差分流（不补、记录）正是按需起落的前提，两者拆开落地、中间态比现状更不稳。

**决策 3 —— 持久化：单写者 + 修并发**

- 单一核心宿主权威后，只有宿主写 scheduler.json → 跨进程并发覆盖**从根上消失**（不是加锁打补丁）。
- 但「单写者」必须坐实为**进程内也串行化的单一写队列**，不靠「只有一个宿主」这个进程级假设兜底。修同进程 save race：`save()` 是全量覆盖式序列化（整张 Map 快照）——「唯一 `.tmp` 后缀」只能防文件损坏，防不了 last-rename-wins 丢更新（后 rename 者用更旧的快照覆盖前者已写入的别 task state）；必须让 read-modify-write 整体互斥才根治。未来更多写来源（远程会话 / 多端）汇聚同一 store 时，这条只会更必要。
- 任务定义跨重启存活（保留 JsonTaskStore 的 load / save）。

**决策 4 —— 保留并强化「有界、隔离、不失控」**（要求 2/3）

- 保留：执行超时、退避 + jitter、并发上限、auto-disable、优雅 drain、单任务失败隔离（不拖垮整个调度器）。
- **补一个现状的洞——同一 task 的并发互斥不完整**：现状只有 `handleDueTasks` 过滤 `activeTasks`，而 `runTask`（RPC `schedule.run`、agent 工具都走它）不检查就执行；与 timer 到点撞同一 task 会并发两个 run、共用同一 RunRegistry key（taskId）互相踩，破坏并发计数 / abort / 「一一对应」。单一 daemon + 多 client 新拓扑会放大这条路径。修复=把 `activeTasks` 守卫下沉 `executeSingleTask` 统一入口（`runTask` 与 `handleDueTasks` 都经它）、撞在跑的同一 task 即拒绝——保证「同 task 同时只一个 run」，taskId 与 run 重新一一对应、RunRegistry key 保持 taskId 即安全（不引 per-run id，免得牵连现状的 abort 链路）。不能当「已有的保护」继承（command.ts 注释「互斥锁保证」与代码不符）。
- 强化：missed 不补（防风暴）；系统任务同样受全套保护；遇不可抗力（LLM / 网络长时间不可用）→ auto-disable + **友好反馈给用户**（要求 2），而非无限重试。

**决策 5 —— 系统维护任务 = daemon 里的 system task**（需求 1/2）

- 持久化分片清理（如 `__transcript-gc`）、skill 淘汰等，各自注册为 system task、配各自 cron（不同周期 / 频率）。
- 复用现有 `systemHandlers` + `task.system` 通道（已有 `__journal-gc` 先例）。
- 这些任务天然幂等、容忍延迟、补一次即可，和调度器能力模型契合——missed 不补对它们无害，下个周期照跑。
- **防饿死（已拍板）**：纯聊天用户从不碰调度 → 宿主从不拉 → 系统维护永不跑（而纯聊天照样产生 transcript / journal、确实需要 gc）。死锁根因是判据方向——旧式「有逾期 system task 行才 ensure」在全新 / 纯聊天用户（json 里还没 seed 过 system task）下永远命中不了、永不拉、永不 seed（要拉才 seed、要 seed 才拉的鸡生蛋）。破法是把判据反过来：cli 启动读 scheduler.json，**「无 system task 行（首次）或有 system task 的 `nextRunAt` 已逾期」即视为该维护、ensure**（无行 = 逾期）；daemon 首次唤起即 seed + 跑。复用单一维护状态（json）、不另起时间戳文件。系统任务容忍延迟，偶尔靠启动唤起即可，无需为它强制常驻。

**决策 6 —— 内部 vs 外部任务：同一内核、一个维度分流（不拆子系统、不新建字段）**

调度需求分两类——**内部**（系统维护：持久化清理、skill 淘汰，未来可能更多）与**外部**（用户定时：提醒 / 收集）。二者**共用同一调度内核**（同一 timer / executor / 持久 / 有界失败），**不拆两套子系统**——拆 = 重复内核、两份失败处理与持久化要同步，本身是债。差异只是任务的一个**来源维度**，驱动一组周边策略分流：

- **可见性**：外部进用户 `list` / turn-context 注入；内部不进（用户不关心系统维护）。
- **可管理性**：内部不可删 / 改（`system:true`：deleteTask 拒删 + updateTask 拒改，双向显式守卫，不靠"外部拿不到 id"间接兜底）。
- **结果触达**：外部回用户（RPC 事件 / channel）；内部静默、失败仅运维可见。落点是三个对外触达边界统一用 `isInternal` 拦内部任务——RPC 事件桥（`event-bridge`）、channel 投递（`enqueueDelivery`）、门面事件订阅（`facade.onEvent`），**缺一即泄漏**（内部维护任务的运行通知漏到用户终端）；事件模型本身不带来源标记，由谓词在边界现查 `task.system` 推导，守「不新建字段」。
- **信任**：内部系统信任；外部 agent-turn 走安全管线 / 工具授权。
- **防饿死判据**：可执行设计 C 的 ①近期用户任务 / ②系统维护逾期，正是这条分流。

**落地不新建字段**——复用现状 `ScheduledTask.system: boolean`（现仅用于 deleteTask 拒删），把语义明确为「内部任务」标记，上述分流统一由它推导；封装单点谓词 `isInternal(task) = task.system`，各分流调它、不散落 `action.kind` / `system` 判断。它与 `action.kind`（`system-handler` / `agent-turn`，执行方式）**正交**：内部任务现状是 system-handler（如 `__journal-gc`），未来若出现「需 agent 跑的内部维护」就是 `system:true + action.kind:"agent-turn"`，现状模型直接支持、纯增量——故**不为内部/外部维度新建标记字段**（注：现状已有的 `ScheduledTask.origin?:{channelId,to}` 是投递来源、与「内部/外部」维度无关，勿混；拿未确认的未来撑现在建字段才是债）。

**决策 7 —— 单一权威的进程边界与生命周期协调**（地基级，unified-core 直接依赖）

单一权威要立得住，「谁是 owner、边界多大、怎么起落交接」必须由原子设施定死，不能靠拼凑——这层正是 unified-core「位置切换 / 多端协同」要直接踩的地基：

- **单例边界 = 每个 `ZHIXING_HOME` 一个核心宿主**。「多个 zhixing 并行」（需求 5）的正确语义是**多个不同 `ZHIXING_HOME`**（各自独立数据 + 宿主 + 端口）；同一 home 开多终端则是多 client 接同一宿主（决策 1）。落点：ensure 拉起 schedule profile 时端口**按 home 区分**（传 `--port 0` 由 OS 动态分配，或按 home 派生），不沿用默认 `18900`（现状默认固定会让不同 home 撞 `EADDRINUSE`）。**发现机制已就位、复用即可**：`startServer` 支持 `listen(0)` 并回填 `listenAddr`、`acquireLock` 已写 port 文件、`discoverServer` 已读 PID 文件里的实际端口——无需新建。unified-core 同样按 home 共享会话 / 记忆，单例边界与它一致。
- **owner = 端口 listen 原子仲裁（现状已如此，定为不变量）**。阻止两宿主并存的是 `listen` 的 `EADDRINUSE`（OS 原子保证），`server.pid` / `server.port` 文件本就是发现辅助、非单例保证（`server.ts:8` + `process-lock.ts` 设计明示）——这与本决策一致、**无需重做**。唯一要补的边角：现状 `acquireLock` 失败时会 `server.close()` 自杀（仅「端口空闲但 PID 指向活进程」的残留场景触发），改为「listen 成功即我是 owner、PID 文件遇 stale 直接覆盖、不自杀」即可。**此条与 idle reaper 同批落地**——idle-ensure 高频起落后宿主分钟级起停成常态、PID 残留 + 复用窗口被放大（Windows 无 `startTime`、无 PID-reuse 检测 `process-lock.ts:194-202`），靠「端口才是真锁、PID 仅发现辅助」兜底，不能延后。unified-core 位置切换依赖的原子 owner，现状端口锁已提供。**（已落地）**：`acquireLock` 改纯覆盖式——owner 由 listen 确立，PID / port 文件仅发现辅助、覆盖任何残留（stale 或被复用 PID 指向的活进程），不再检测抛、`lifecycle` 不再 `server.close()` 自杀；删除「PID 当锁」的残留 `ProcessLockError` / `detectStale`，`startTime` 降级为 PID 文件诊断信息（`isProcessAlive` / `resolveProcessStartTime` 保留供 discoverServer / 诊断用）。
- **ensure 与 idle 退出之间靠端口原子交接 + client 重试，不改 shutdown 契约**：idle 判据 = **无活跃 RPC client + 无活跃会话 / 接入面 + scheduler 无「近期 `nextRunAt`」**。其中「近期」窗口**必须 ≥ 决策1 守候近期 once 任务的窗口**——否则近期 once 在 idle 退出后、下次 ensure 前到点 → 被决策2 判 missed 不补 → 用户「1 小时后提醒」静默丢；故近期 once 守候窗口内宿主**不 idle 退**。交接方式：宿主进入 drain 即退（**保留现状 `lifecycle.ts:153-163` 的 idempotent-once 不可逆 shutdown——不为本模块重写成可中止状态机**）；drain 期间新调度操作连不上（或连上发现 shutting down）→ client 当「无宿主」**重新 ensure** → 旧的退完释放端口、新的 listen 拉起（OS 端口原子裁决保证两 listen 不并存）。代价是偶发一次「退了又拉」的秒级延迟，但不碰 shutdown 契约。**可中止 drain（drain 中途撤销退出、平滑不断正在进行的会话）是 unified-core 平滑位置切换才需要的，留给那层**——本模块 schedule profile 无会话面，退完重拉无损。
- **接入层必须健壮**：`RpcSchedulerFacade` 要**可重连 + 可重新发现 + 断线自动重订阅**——既然宿主会 idle 自己消失，client 一次性连接（现状 `RpcClient` 断即死、无重连）与之同台就是自相矛盾；宿主消失后下次操作要能重新 ensure + 重连 + 重订阅事件。这是 unified-core 多端协同 / 远程接续的前置。**WS 层还需补应用级 ping/pong liveness**——现状 `connection.ts` 只在 socket close 置 closed、无心跳，半死连接（手机切后台 / 弱网）会让宿主 idle 判据误判「有活跃 client」该退不退（违「要轻」），是 idle 判据可信的前置。
- **就绪契约统一**：ensure 的「可用宿主」判据要发现侧与拉起侧对齐——发现既有宿主时也探**能力就绪**。现状 `discoverServer` 只查进程存活、不查就绪（可在 `scheduler.start` 前连上、写操作撞 `requireScheduler`）。注意 `/api/status` 的 `scheduler` 字段只表示「对象被赋值」（`routes.ts:70` `ctx.scheduler ? {...} : undefined`），**不等于 `scheduler.start()` 已完成**——数据驱动 profile 装配后若 context 先建、能力异步 setup 在后即 TOCTOU。故就绪契约应是 **per-capability 显式 ready**（如 `scheduler.started:boolean`），收敛进现有 `ServerStateFile` 的 phase 机制（注：现状 `ServerStateFile` 仅 daemon child 写 `command.ts:481`、前台 serve 不写 `status.ts:123` 那套就绪信息整段缺失，两套就绪覆盖面不对等——统一进单一带 phase 的就绪事实源，ensure 发现侧 / serve status 运维侧 / unified-core 判活共用），避免「字段存在=就绪」这一「声明面领先生效面」。

### 可执行设计

> 从架构方向落到实施蓝图：改哪些文件、新增什么、关键接口契约。内核块（E）与拓扑块（A–D）可并行，F/G 收尾。file:line 为现状锚点。

**A. 调度门面 `SchedulerFacade`（解耦核心，消除「本地 scheduler vs RPC」双轨）**

新增平台无关接口（`core/scheduler` 或 `orchestrator`）：

```
interface SchedulerFacade {
  create(spec): Promise<TaskView>;        // 返创建后的视图（含内核算出的 nextRunAt）
  list(): Promise<TaskView[]>;
  update(id, patch): Promise<TaskView>;   // 返更新后的视图
  delete(id): Promise<void>;
  run(id): Promise<AgentTurnResult>;      // 即时运行
  onEvent(h): () => void;                  // 订阅 completed 等（内部任务事件在此边界过滤）
  dispose?(): Promise<void>;               // 释放底层资源（RpcFacade 断连/清订阅；Local 通常无需）
}
```

- 两实现：`LocalSchedulerFacade`（直调本进程 `Scheduler`，daemon 内用——它是**恒定核心**，在核心 `Scheduler` 创建后实例化一次；daemon 内**所有执行面**经 `getSchedulerFacade` 惰性共用同一实例：当前 ephemeralRuntime（定时 agent-turn）+ 会话执行面（per-session，飞书等 channel 会话创建 / 管理任务），未来 unified-core 点亮会话执行面亦复用同一 facade、非承重件替换——facade 绑核心 Scheduler、与「哪个执行面」正交。惰性原因：per-session `runtimeFactory` 装配早于 Scheduler 创建，故消费者持 getter 闭包、晚绑；工具 call 必在 daemon 跑起来后、ref 已就位）、`RpcSchedulerFacade`（经 RPC client 调 daemon，cli 用，调用前 ensure 宿主）。
- 所有调度消费者（schedule 工具、cli `/schedule` 命令）只依赖此门面——不再直接 `new Scheduler`、不直接碰 RPC。这是「单一权威 + 多 client」的接口落点。**读写分离**：写 / 执行（create / update / delete / run）经宿主 ensure（唯一写权威）；list / get 这类纯读直接读 `scheduler.json` 从属投影、**不拉 daemon**——磁盘是宿主单写者的只读投影（每次状态变更都 save），读它不构成第二写权威、不破单一权威；代价仅是看不到「此刻哪个正在跑」的瞬态运行态（价值低，且宿主没跑时本无运行态）。用户 `list` 只列 external（按 `isInternal` 过滤、内部维护不进用户视图，见决策 6）。读投影仅适用 scheduler 这类**无状态、可序列化、宿主单写**的子系统（依赖原子 rename，读到的要么旧版、要么新版完整快照）；有状态会话（unified-core）的跨端共享是另一套机制、不在本模块、不可照搬此读投影。**读投影的状态摘要计算须纯函数化**：现状 `getStatusSummary` 是 `Scheduler` 实例方法（`scheduler.ts:252`），cli 去自起后没有实例——把它抽成平台无关纯函数 `computeStatusSummary(tasks, now, window)`（放 `core/scheduler`），daemon turn-context（持 Scheduler 实例、过滤 internal 后直接调）与 cli 读投影共用，cli **不重复实现**这套 active/recentlyCompleted/recentlyFailed 逻辑（否则即新的重复债）。**已落地补记**：纯函数抽出后 `Scheduler.getStatusSummary` 这层 wrapper 失去消费者（去自起后 turn-context 改 closure 投影）、已删除——共用点就是 `computeStatusSummary` 本身，不再经 Scheduler 实例方法。

**B. 核心宿主装配：接入面单元 + 数据驱动 profile（`cli/serve/command.ts`，现 `runServerProcess`）**

现状 `runServerProcess` 是约 350 行**线性内联装配**（`mcpHub.connectAll@212` / ConversationManager@253 / setupChannels@292 / ephemeralRuntime@349 / Scheduler@451 全硬编码顺序）。profile 化**不能**落成「`if profile==='schedule'` 跳过这几行」——那每加一个接入面都要回改主干（声明面领先生效面复发）。改为数据驱动：

- **恒定核心始终装配**：runtime + 会话态 owner 的位 + Scheduler + systemHandlers + runRegistry + RPC server。`server` 包本身**零改**——`ServerContext` 的 `conversations` / `channels` / `scheduler` 本就全可选（`server.ts` 全程 `ctx.conversations?` 可选链），`/api/health` 不依赖外部资源（`routes.ts`）。
- **profile = 完整行为画像描述符 `PROFILES`（单一来源）**（已落地独立模块 `cli/serve/profile.ts`——profile 概念簇 `ServerProfile` 类型 + `DEFAULT_PROFILE` 默认 + `PROFILES` 描述符，作叶子模块被装配 / 接入面遍历 / CLI 入口单向依赖，消除 command ↔ access-surface 概念循环）：profile 是「装配档位」一等概念、会随升格 / unified-core 演化增长；它决定的**全部**行为差异收进 `PROFILES[profile]: ProfileSpec`——`surfaces`（启用的接入面集合）/ `startupMode`（启动校验模式）/ `idleReap`（空闲退出生命周期）。装配主干一律读描述符、**绝不枚举 profile 名**（`if (profile==='schedule')`）；新增 profile = 加一条 PROFILES 记录、主干零改。这杜绝双重债：profile 行为硬编码主干随档位增长逐处回改、以及 profile 定义散落多处（接入面集合 + startup if + idle if）改一档漏一处即 bug。**profile 名零硬编码贯穿全链路、不止装配主干**：argv 编解码也中立化——`buildForwardedArgs` 透传 `opts.profile`（不枚举名）、CLI 入口按 `name in PROFILES` 校验解析、默认值收敛 `DEFAULT_PROFILE` 单一来源。只把接入面集合表化、却把 startup / idle / argv 留成 `if profile` 或字面散落，是治了一半的债。
- **接入面抽成单元**（已落地 `cli/serve/access-surface.ts` 框架 + `access-surfaces.ts` 单元）：MCP / 会话执行面（`ConversationManager`）/ channel / 投递栈 / 文本确认渲染器 / 远程确认桥各封成 `AccessSurface { name, phase, setup(ctx) }` 单元；`setupAccessSurfaces` 读 `PROFILES[profile].surfaces` 按数组序（= 依赖拓扑序）遍历、装配「当前 phase 且被本 profile 启用」的接入面。装配主干无任何 `if (profile===...)`；新增接入面 = 写一个单元 + 在 PROFILES 对应 `surfaces` 加一个名字、主干零改。落地时定形两处客观约束（非可选，是「线性内联 → 数据驱动」过程中暴露的真实交织）：
  - **phase 分层（pre-server / post-server）**：核心 Scheduler 构造期吃 delivery 接入面产物（`delivery` 构造期 readonly、不能 late-bind），故 Scheduler 排在 pre-server 接入面之后构造、读 `ctx.deliveryStack`；confirmationBridge 依赖 runServer 之后的 `server.connections`，归 post-server（runServer resolve 后回填 `ctx.runner`）。`AssemblyContext` 单线程顺序装配传递产物（conversations→channel→delivery→scheduler、connections→confirmationBridge），共享安全。
  - **teardown 不进接入面接口**（故无 `teardown()` 方法）：接入面 teardown 有 LIFO 时序硬约束——必须在 `server.close` 之前执行（= runServer 之后注册）；而 pre-server 接入面 setup 在 runServer 之前，若在 setup 内注册 teardown 会落到 LIFO 末尾、跑在 server.close 之后致双重 dispose。故 pre-server 接入面只 setup（产物写回 ctx，由 runServer 后的 `shutdown-chain.ts` `registerCoreCleanup` 用 ctx 产物统一注册清理，复用既有数据驱动 LIFO 关停链）；仅 post-server 接入面（本就在 runServer 后）在自己 setup 内注册 teardown 到 `ctx.cleanup`。teardown 体系不另起、沿用 shutdown-chain。
  - `profile:"schedule"`：恒定核心，接入面集合为空（会话执行面**不实例化、只保留挂载位**；不挂 channel / MCP）。够跑定时、且轻。RPC server（HTTP+WS）照常起——它是 client 接入与就绪探测的传输、不是「面向人的 chrome」，必须保留。
  - `profile:"full"`（显式 `zz serve`）：启用全部接入面（`PROFILES.full.surfaces` = MCP / 会话执行面 / channel / 投递栈 / 文本确认渲染器 / 远程确认桥）。
  - **升格（schedule→full）= 停旧起新**：`zz serve` 发现已有 schedule 宿主 → RPC `server.shutdown`（现成，`ctx.requestShutdown`）令其 drain 退出（scheduler.stop 等 activeTasks 跑完、in-flight 不丢）→ 端口释放后起 full（load `scheduler.json` 恢复任务）。**不实现运行时热挂载**（已建 scheduler 的 delivery 是构造期 readonly 注入 `scheduler.ts:62/78`，热挂载要改核心，属 unified-core）。接入面 `setup / teardown` 单元抽象仍建——为未来热挂载留边界。
  - **边界：停旧起新仅对无状态可序列化子系统无损（scheduler.json 单写 + 原子 rename），对有会话面的位置切换不适用**——`server.close()` 走 `conversations.disposeAll()`（`conversation-manager.ts:720-741`）只 dispose 不 flush，turnCount<2 的 ephemeral 会话态（`:564` 才 promote）整段丢。本模块升格是 schedule→full（旧的 schedule profile 无会话面、无态可丢），故无损；但 unified-core 的 full↔full 位置切换两端都有会话面，**不可复用停旧起新、须走会话态 handoff**（会话态以可序列化快照为单一事实源、live runtime 是其投影；见核心宿主定位诚实标注）。
- serve 命令加内部标志 `--profile <profile>`（ensure spawn 时由 `buildForwardedArgs` **中立透传** `opts.profile`、不枚举具体名；用户 `zz serve` 不传则取 `DEFAULT_PROFILE`=full）。
- **startup check 按 profile 校验**（修 mode-blind 门）：现状 `runServerProcess` 顶部无条件 `runStartupCheck({mode:'server'})` 会追加 `checkMessaging`，partial-channel 配置（messaging 已声明但缺凭证）下非 TTY 直接 `exit(2)`；调度 profile 概念上不需要 messaging。改为 schedule profile 只校验 model、不校验 messaging（全新空 messaging 用户本就不触发）。**已落地为数据驱动**：校验模式由 `PROFILES[profile].startupMode` 声明，主干 `runStartupCheck({ mode: PROFILES[profile].startupMode })`、不 `if profile`。
- 调度 profile 下 RPC registry 仍可全注册，`session.*` 因无会话执行面在调用时友好抛错；cli 调度 client by-construction 只调 `schedule.*`，无害。

**C. ensure 机制 + cli RPC 接入（`core-host-connection.ts` 连接生命周期 + `rpc-scheduler-facade.ts` 门面 + `scheduler-projection.ts` 读投影 / 启动判据）**

```
class CoreHostConnection { getClient(): Promise<RpcClient>; onNotification(m, h): () => void; dispose() }  // 懒连 / 并发去重 / 断线重建 / 重订阅
class RpcSchedulerFacade implements SchedulerFacade { create|update|delete|run 走 RPC; list 读 json 投影; onEvent 走 notification; ensureHost() }
```

> 形态注：早期草案设想单一 `ensure-core-host.ts` / `ensureCoreHost(): Promise<SchedulerFacade>`；实现把「连接生命周期」与「调度门面」拆成两类（连接层不懂 schedule 语义、门面叠加 ensure），更解耦——下文按落地形态描述。

- 发现 / 就绪：`discoverServer` 读 PID/port 文件（已读实际端口）+ 验进程存活。**就绪不靠显式探测、靠写入时序保证**——`lifecycle` 把 `acquireLock`（写 PID）排在 `startServer`（listen）之后、`command.ts` 把 `scheduler.start()` 排在 `runServer` 之前，故「PID 文件存在」即隐含 listen 完成 + scheduler 已 start，discover 命中即就绪（比「per-capability 显式探测」更简洁，且根治决策 7 警示的「对象赋值 ≠ `start()` 完成」——这里赋值与 start 都先于 PID 写入）。不在 → 复用 `spawnDaemon`（profile 中立、detach + `startupHandshake` 三项探测：PID alive + `.ready` marker + `/api/health` 200）、由 `buildForwardedArgs` 中立透传 `--profile schedule`（不传 `--port`：child 按 home 派生端口 → 同 home listen 原子仲裁单例、并发拉起只活一个）→ handshake 等就绪 → 连上。**spawn 失败 / EADDRINUSE 时先重新 discover**——并发抢 ensure 的败者 child 因端口被占自杀，但赢家宿主已可用，重发现连上即可；只有重发现也失败才抛 `CoreHostUnavailableError`（避免并发下败者把「宿主已可用」误报成「定时功能不可用」）。
- 连接层（`CoreHostConnection`）**可重连 + 重新发现 + 断线重订阅**（决策 7）：宿主 idle 消失后 client 关闭，下次 `getClient` 重新发现 / 拉起，并把持久订阅的 notification handler 挂回新连接。`dispose` 收尾在途 `establish`（dispose 撞在连接建立期间时关掉建立中的连接、不泄漏、不守活宿主）。
- 失败 → 抛**封装的友好错误** `CoreHostUnavailableError`（spawn 时给静默 console、不复用 `spawnDaemon` 面向人的 `printLogTail` 原始日志倾倒），cli 捕获提示 + 操作失败（决策 1②，不静默队列）。
- cli 启动轻检查（`repl.ts` 的 `shouldEnsureOnStartup`）——满足任一才调 `RpcSchedulerFacade.ensureHost()`（fire-and-forget、失败给一行降级提示不静默），否则纯聊天零后台：① **近期用户任务**：读 `scheduler.json`，有近窗（`NEAR_WINDOW_MS`，与 idle reaper 的 near 窗口同值 → 软不变量「ensure 窗口 ≤ reaper 窗口」，避免拉起即被判 idle 退的抖动）内待触发的 user task；② **系统维护逾期**：仍读 `scheduler.json`——「有 system task 的 `nextRunAt` 已逾期」或「没有 system task 行（全新 / 首次、尚未 seed）」即视为逾期、ensure。**无行 = 逾期**是破死锁关键（非旧式「有逾期行才 ensure」的鸡生蛋，见决策 5）；复用单一维护状态（json）、不另起时间戳文件。

**D. cli 去自起 scheduler + 全部消费者改接入（不只 schedule 工具）**

cli 进程现状有四类 scheduler 消费者（grep 全仓 `listTasks/createTask/...` 穷举所得），去自起后**都要迁**，漏一个就功能回归：

- `cli/runtime/session.ts:317`：删自起 Scheduler（`createScheduler` + bootstrap 调用 + dispose stop + reload 重建四处）。cli 不再持本地 scheduler。
- **① schedule 工具**（`tools-builtin/schedule.ts`）：`createScheduleTool` 入参从「Scheduler 实例 / getter」改「SchedulerFacade」；`cli/runtime/builtin-extra-tools.ts` 注入 `RpcSchedulerFacade`（懒 ensure），`command.ts` 在核心 Scheduler 创建后实例化恒定核心 `LocalSchedulerFacade`、daemon 内会话执行面（per-session）与 ephemeralRuntime 经 `getSchedulerFacade` 惰性共用它。（`SchedulerFacade.list()` 的 `TaskView` 须覆盖工具渲染所需字段——handleList/formatTaskBrief 用到 id / name / schedule / priority / enabled / state，别裁成读不全。）
- **② SchedulerProvider（turn-context 注入）**（`session.ts:292` 的 `getSchedulerStatus`）：cli 对话 agent 的 turn-context 注入「当前定时任务状态」（`turn-context-providers.ts`：让 LLM 看到有哪些任务 / 最近完成 / 失败），现状读本地 `scheduler.getStatusSummary()`。改为**读 `scheduler.json` 从属投影**（纯读、不拉 daemon，落在 A 的读写分离；缺「此刻哪个在跑」的瞬态活跃态可接受——daemon 没跑时本无活跃态、LLM 也不需要）；经 `computeStatusSummary` 纯函数（见 A）算 summary、**不重复** getStatusSummary 逻辑；只注入 external（`isInternal` 过滤，系统维护不进 agent 上下文，见决策 6）。
- **③ REPL 任务事件渲染**（`repl.ts:1131-1147` 订阅本地 `schedulerEventBus` 渲染 `task-completed / failed / disabled` 终端通知）：事件源从本地 scheduler 改为 `RpcSchedulerFacade.onEvent`——连上 daemon 时经 RPC 订阅（`event-bridge.ts` 桥接 + `RpcClient.onNotification` 现成）、桥回 `schedulerEventBus` 复用现有渲染；无 daemon（无任务）时无事件，cli 退出订阅即断（离线结果归未来，与既定一致）。注：RPC 事件模型与本地不一一对应——`event-bridge.ts` 把 `task-failed` 并入 `schedule.completed{status:"error"}`、`task-completed` 是 `{status:"ok"}`；桥回时要按 `status` 拆回本地 `task-completed` / `task-failed` 再喂现有渲染。
- **④ `/tasks` REPL 命令**（`info-commands.ts:370-399`，"查看定时任务"）：现状经 `deps.getScheduler()` 调 `scheduler.listTasks()` + `scheduler.activeTaskCount` 渲染。改为 `SchedulerFacade.list()` 读 json 投影（同 A 读写分离）；`activeTaskCount` 是宿主内存瞬态、读投影拿不到——降级不显示"N 个执行中"（daemon 没跑时本无活跃态；如需精确可在 connected 时经 RPC 取）。

**E. 内核改造（`core/scheduler/`）**

- **missed 容差分流**（`scheduler.ts` + `config.ts` + `types.ts`）：config 加 `graceWindowMs`；scheduler 记本次上线时刻 `onlineSince`（start 设、不持久化、每次拉起重置）；到点判断**以 onlineSince 为锚**分流——`nextRunAt` 早于 `onlineSince - grace`=离线期间错过（不执行、记 `state.lastMissed={scheduledFor,detectedAt}`、advance `nextRunAt` 到未来；once → 标 terminal-missed/disable），其余=在线到点正常执行（被并发推迟则保持 due、不误判）。删 `start()` 只 log 的 missed 计数。**锚 onlineSince 而非 now**——锚 now 会让在线并发延迟随时间漂移越过容差被误判错过、once 被饿死丢失。
- **单写队列**（`task-store.ts:60-80`）：`save()` 串行化（内部写队列/promise 链，read-modify-write 整体互斥），根治多任务并发 save 的 last-rename-wins 丢更新。
- **同 task 并发守卫**（`scheduler.ts:223-227`）：把 `activeTasks` 守卫下沉 `executeSingleTask` 统一入口——`runTask`（RPC / 工具）与 `handleDueTasks` 都经它，撞在跑的同一 task 即拒绝。守卫保证「同 task 同时只一个 run」后，taskId 与 in-flight run 一一对应，**RunRegistry key 保持 `taskId`**：现状 abort 链路（`schedule.abortRun(runId=taskId)` / `abortAll` / drain）原样不动，不引 per-run id 的额外改造。

**F. system task 运行态 seed（`scheduler.ts` + `command.ts`）**

- `Scheduler` 加 `ensureSystemTask(handler, schedule)`（seed-if-absent、幂等、`system:true` 不可删）。seed 用**固定 id**（如 `__journal-gc`）才能判存在性——现状 `createTask` 强制 `generateId`（`scheduler.ts:154`）、不接受外部 id，故 `ensureSystemTask` 内部绕 createTask、直接 `store.addTask`（固定 id + `system:true` + 算 nextRunAt）。
- daemon 装配后 seed `__journal-gc`（及未来 `__skill-evict` 等），各自 cron、各自周期。现状只注册 handler（`system-handlers.ts`）、**无 task 行**——此为需求 1/2 的运行态落地。

**G. 核心宿主生命周期 + 结果回传（落决策 7）**

- idle reaper：**装不装由 `PROFILES[profile].idleReap` 门控**（主干 `if (PROFILES[profile].idleReap)`、不 `if profile`；full 长驻 idleReap=false、schedule idleReap=true）；装上后周期检查 idle 判据（**无活跃 RPC client + 无活跃会话 / 接入面 + scheduler 无近期 `nextRunAt`**；「近期」窗口 ≥ 决策1 守候近期 once 任务的窗口）→ 进入 drain 即退（**保留现状 `lifecycle.ts:153-163` 的 idempotent-once 不可逆 shutdown，不重写成可中止状态机**，见决策 7）；drain 期间撞上的新调度操作连不上 → client 当「无宿主」**重新 ensure**、旧的退完释放端口后新的 listen 拉起（OS 端口原子交接，秒级「退了又拉」）。可中止 drain（平滑不断会话）留 unified-core。reaper 实现逻辑（判据 + 窗口）留主干、由 flag 门控——它是单一 schedule 特有行为、非会增长的集合，做成「生命周期单元」是过度设计（YAGNI），boolean flag 是恰当粒度。
- owner：listen 成功即确立 owner，随后写 PID（诊断 / 发现，遇 stale 覆盖、不回滚自杀）；port 文件供发现（决策 7）。与 idle reaper 同批落地。
- 结果回传：cli 在线经 `RpcSchedulerFacade.onEvent` 收 `schedule.completed`（`event-bridge.ts` 现成）渲染；离线补传归未来、不实现。

**防债注记（守扩展位、不焊死）**

- **执行环境与 workspace**（取舍三，已拍板）：定时 agent-turn 用宿主的无会话执行面执行（当前提醒 / 收集 / 系统维护不依赖创建者本地目录，正确）。但 **workspace 是任务（未来是会话）的显式属性、不是宿主进程的隐式 `cwd`**——现状 `create-agent-runtime.ts` 的 workspace 已有独立解析链（CLI > 目录配置 > 全局 > cwd），但无显式 `workspace.root` 时兜底 `process.cwd()`（`:574` / `:1502`），cli runtime 与宿主 runtime 因进程目录不同而环境分叉；地基阶段把「workspace 属任务 / 会话」立为不变量（agent-turn 任务携带或继承明确的 workspace、不落进程 cwd 兜底），unified-core「同一上下文跨端连续」的上下文首要就是它。**不预留** `creatorContext` 半成品字段——将来要「带创建者环境」给 `ScheduledTask` 加 optional 字段是纯增量。仅守一条：执行侧别把「用宿主默认环境」焊死成唯一路径。
- **两执行路径一致性 / 单一装配源**：会话执行面与无会话执行面（`ephemeralRuntime`）同 config 装配、能力 / 记忆同源（同一持久层），否则「同一指令在对话里和定时里行为不同」成债。现状是 **3 处独立 `createAgentRuntime`**（serve 会话 `command.ts:231` / serve ephemeral `command.ts:349` / cli REPL `session.ts:252`），靠注记对齐、无单一工厂强制——本模块尚一致（low），但 unified-core 长会话共享时两路径能力集 / 记忆接入会悄然分叉；地基应把「核心运行时装配」收敛成单一工厂、让两路径从同一产物分叉，别靠人记。
- **接入面挂载位**（呼应「核心宿主定位」/ 决策 7）：接入面是 `setup` 单元（teardown 因 LIFO 时序约束走 shutdown-chain、不进单元接口，见可执行 B）、数据驱动装配；新增接入面 = 注册单元 + 纳入 profile 集合，不改宿主骨架。本模块升格用停旧起新（见可执行 B）；unified-core 要的「运行时热挂载 / 不停机位置切换」在此单元抽象上增量加 late-bind，届时再碰 scheduler 等构造期依赖——本模块不提前预建。
- **执行面并发互斥一律在执行面 owner 内原子完成**：决策4 已把调度侧 `activeTasks` 守卫下沉 `executeSingleTask` 统一入口；会话侧对称——现状 ConversationManager 的串行闸门散在 caller（`enqueue` 只读 busy 不认领 `conversation-manager.ts:654`，认领由 `rpc/methods/session.ts:84` + `inbound-router.ts:259` 各做 enqueue→判 immediate→`setBusy(true)` 三步、已复制两份）。本模块不新增入会话路径、不受此力；但 unified-core 需求2（同会话并发串行）一旦新增第二条入会话执行路径，新路径不复刻三步就会两 run 踩同一会话——故立此不变量：会话侧应把「认领式入队 / `runExclusive(convId, fn)`」做成 owner 原子原语，与调度侧守卫下沉同型，别让互斥活在 caller 纪律里。

### 用户视角：这套架构对用户意味着

- **开几个终端都行**：定时任务只执行一次、不重复，任务列表哪个终端看都一样。
- **定时不绑某个终端、尽力而为**：任务交给独立后台进程，不依赖你开着哪个窗口；近期的（如「1 小时后」）会守到触发，远期周期（每天 n 点）你在用时触发、后台让位时若错过就记下来下次告知（不默默丢、不开机轰炸式补）——要雷打不动可显式开常驻。
- **跨端一致**：cli、server、未来其他端，同一套任务、同样行为。
- **多个独立知行各管各的**：用不同 `ZHIXING_HOME` 起的多个知行各自独立（数据 / 后台 / 端口都不共享、互不干扰）；同一个知行开多个终端则共享同一套任务（多终端一致）。

---

## 待根治项登记（技术债，留待专项重构）

> 审查过程中发现、但**不属当前步骤范围、也不宜用补丁修补**的债，登记于此，待对应专项重构统一根治——避免「为一个轻症状加一行补丁」反而延续病根。

### scheduler 错误结构化（消除 RPC handler 的 `message.startsWith` 错误分类）

- **债**：`server/src/rpc/methods/schedule.ts` 各 handler 用 `err.message.startsWith(...)` 字符串匹配 scheduler 抛出的 plain `Error`（"Task not found" / "Cannot delete system task" / "Cannot modify system task"…）来映射 RPC 错误码。脆弱（scheduler 改个错误措辞，handler 分类就错）、分散（create / update / delete / run 各写一遍）、易漏。
- **现表现**：`schedule.delete` 把 "Cannot delete system task" 转 `INVALID_PARAMS`，`schedule.update` 漏了 "Cannot modify system task"、throw 原始 → `INTERNAL_ERROR`——update / delete 改 / 删 system task 的错误码不对称，正是「字符串匹配易漏」的症状。
- **为何不在此修**：功能正确（decision 6 内核双向守卫已拒改 / 拒删 system）、仅 RPC 错误码语义不当、触发面窄（用户经 `list` 过滤拿不到 system task id）。给 update 再补一条 `startsWith` 是在脆弱字符串匹配上叠加、延续病根（违「不修修补补」）。
- **最优根治**：scheduler 定义结构化错误（typed error 带 `kind`：not-found / system-protected / invalid-schedule …），抛错点用它；RPC handler / facade / 工具按 `kind` 分类映射，彻底不碰 message 字符串。属 scheduler 错误体系专项重构，范围跨所有抛错点 + 消费者，单独评估优先级后统一做。
