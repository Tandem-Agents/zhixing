# 子 agent 模块架构设计 —— 多视角发散收敛

## 一. 需求基线

**用户价值(做好后的效果)**:用户不需要学习"工作流"、不手动拉 agent、不自己设计流程。在复杂、重要、容易误判、需要高质量判断的问题上,知行临时拉开多个独立视角、再收敛成一个可执行判断;用户感受到的是判断质量更强,而非"多了一个功能":

1. 复杂问题不再只给单薄答案,明显经过多角度思考。
2. 关键设计 / 审查 / 研究 / 决策节点更稳,少掉单视角盲区。
3. 不必反复说"再换个角度想想""找别人审一下"。
4. 输出不是多个答案的堆叠,而是一个收敛判断:推荐什么、为什么、放弃了什么、风险在哪、下一步怎么做。
5. 只有方向、风险承担或偏好取舍必须由用户决定时,才把问题交还用户。

**第一阶段形态(关键:不赌 AI 自动判断)**:

- 先做成**中立基础设施**:并行执行多个上下文隔离子 agent + 一个独立收敛 agent。可由 AI 调用、也可由用户手动触发;**具体由谁触发是后续产品选择,第一阶段不做 AI 自主判断**(AI 自主判断 = 不确定 + 不透明 + 用户莫名多倍消耗;而用户自己触发,这个行为本身就是意图)。
- 子 agent **继承主 agent 注意力窗口的只读快照**作为初始上下文(要懂上下文才能对"这个问题"给出有意义的视角),在隔离上下文里发散,瞬时、不持久化、绝不写回主窗口;**只有最终收敛结果进主 agent**。
- **收敛由一个独立 agent 完成**,不把 N 份子结果灌给主 agent(主 agent 上下文珍贵)——主 agent 只收一份收敛判断。
- **成本闸门**:每个子 agent 带一份主窗口快照 = N 份 token,所以并发数量、组合、内置默认上限与死的最大边界是必须的控成本设计。

**独立子 agent 模块(知行目前没有)**:内置一批有鲜明特征、真正带来不同思维框架的角色(乔布斯 = 产品直觉与极致取舍、爱因斯坦 = 第一性原理、女娲 = 创造性重构——名人只是载体,价值是那个真不一样的视角框架,不是模仿秀);用户可自定义角色、可搭配组合、可控并发数量(**这些是第二阶段的能力愿景,第一阶段不做——见「阶段划分」**)。注意:"用户能自定义角色 / 搭组合"与"何时触发这个能力"是两件正交的事,不要混为一谈。

**复用与边界**:复用现有 subagent 执行底座(loop-runner / 事件 / 中断 / 安全 / 预算),只把被 Task 写死的 dispatch 入口通用化;Task(空白隔离子任务)作为另一种 dispatch 策略并存,不砍。

**定位**:它是内功能力,不是用户要学的流程系统;固定的是"发散 → 收敛"的工作形态,动态的是视角数量、视角内容、提示词、证据要求和收敛标准。

**阶段划分(切两批)**:

第一阶段(基础设施,先实现先验证):

- 四阶段最小闭环:视角分配 → 并发独立产出 → 交叉优化 → 独立收敛(见「执行流程」)
- 默认视角差异,由视角分配节点动态生成(见「差异来源」)
- 模型档位间隔装配(见「差异来源」)
- 基础参数:默认 3 并发 / 硬上限 5 / 至少 main 档(见「基础参数」)
- 手动触发口 `@`(升级现有 @ 为多业务提及面):`@ ` 空 query → 多视角、正文 = 问题;数量走正文(分配节点解析),不弹角色 / 组合(见「触发口」)
- 快照只读继承、瞬时运行态、独立收敛
- 无角色、无自定义、无持久化

第二阶段(在第一阶段上叠加,后做):

- 名人 / 自定义角色(提示词配置资产,见「差异来源」)
- 角色组合搭配
- 单角色临时唤醒
- 角色 × 视角配合策略(第二批架构前定)
- `@` 提及面加 `@角色` source(单角色唤醒)+ 角色 / 组合候选

持久化的边界:只属第二阶段,且要分清两种——**运行态**(子 agent 单次运行的上下文 / 状态)瞬时、用完即弃、永不持久化;**配置资产**(用户自定义的角色定义、组合)才需要存盘,只在第二阶段出现。第一阶段只用代码内置的默认视角(无需用户存)+ 瞬时运行态,**不涉及任何持久化**。

**基础参数**:默认 3 个并发、硬上限 5;每个子 agent **至少**用 main 档(系统必有)——有 power 时按档位间隔装配(见「差异来源」),不是永远只用 main。

**执行流程(四阶段,不是"并发 → 收敛")**:

1. **视角分配**:一个分配节点接收主窗口只读快照 + 用户消息(本轮要多视角的问题;`@` 触发下即 `@ ` 后的正文,含问题与可能的数量意图)+ 一次 dispatch 配置(至少含:默认 3 / 上限 5、当前可用的模型档位、角色槽——第一批角色槽为空;具体字段结构留架构定),按固定提示词("根据用户需求与给定数量,从不同角度切出视角")产出一份结构化视角列表。数量默认 3、用户可在正文要求(**分配节点从用户消息解析、有数量决策权**,不走任何 `@` 语法),硬上限 5——给超 5 也不报错,装满 5 个、多余丢弃。它产出的是**视角**(分析切面 / 工作方式),不是角色。
2. **并发独立产出**:按视角列表派 N 个子 agent,各自继承主窗口只读快照、带各自视角独立产出;模型按"档位间隔装配"(见「差异来源」)。
3. **交叉优化一轮**:把 N 份结果汇总分发回每个子 agent,各自基于所有版本再优化一次(互相吸收)。
4. **独立收敛**:一个独立收敛 agent 收齐结果,产出一份收敛判断,回主 agent。

收敛 agent 本身是 agent,它总会产出一段给主 agent 的回复——"收没收拢"是它输出的内容,不是系统要管的状态分支;交叉优化轮使分歧在收敛前已被互相吸收,基本不会"收不拢"。成本约 2N+2 次 agent 运行(1 分配 + N 独立 + N 优化 + 1 收敛),由数量上限控制;分配节点是串行前置,会加一点首延迟,默认 3 时温和。

**第一阶段触发口(`@` Mention Surface)**:手动触发,复用并升级现有 `@`(现在只引用文件)为一个**多业务提及面**——`@` 由单一聚合 provider 接管,内部按 query 分流到不同 source:**空 query → 多视角**(本能力)、**第一阶段非空 query → 文件**(现有);**第二阶段非空 query 再扩展到角色 / 组合等 source**(届时非空 query 进入角色 / 文件 source 仲裁,不再只等于文件)。触发规则:`@` 前是**行头或空格**(否则当普通文本,如 `email@x.com`),`@ `(`@` 后空格 = 空 query)即触发多视角、`@ ` 后到末尾的正文 = 给分配节点的问题;`@` 后无正文 → 不触发、当普通消息。**行头、文中都可触发**。数量**不用 `@` 语法**(`@5` 会变具名 query),走正文自然语言由分配节点解析(默认 3 / 上限 5)。选 `@` 而非新符号 `*`:`@` 是社交软件早教会的"召唤参与者"心智、零学习,且顺着现有 typeahead/provider 架构扩展。"谁触发(手动 / 未来 AI 自动)"仍后置为产品选择;`@` 是第一阶段的最小验证入口、长期保留。

**差异来源(多视角的"差异"从哪来:可叠加维度,系统自动取最强可用)**:差异是目的,视角 / 模型 / 角色都只是制造差异的**可叠加维度**,不是二选一。分三档:

- **默认(质量主力,人人可用)= 视角差异**:由「执行流程」第 1 步的**视角分配节点动态生成**——针对当前问题切出不同分析角度(而非固定一套通用维度硬套所有任务),发散阶段彼此独立不可见。这是差异的主力来源。
- **免费附加 = 模型档位间隔**:复用现有 main / power 档位、**不新增任何模型配置**——没 power 则全 main;有 power 则以 main 起间隔装配(main、power、main……)。我们只提供这个间隔机制、**不承诺它的差异效果**(main / power 是否真异源取决于用户配置),它只是"有就白赚"的附加层;质量主力始终是视角分配节点。light 档不进视角列表(视角要质量)。
- **可选叠加 = 角色装配(第二批)**:用户主动选内置名人 / 自定义角色,按并行列表顺序装配。**角色本质是一段提示词配置资产**——持久化的只是这段配置文本,它不是常驻 agent、不持久化运行态,只在 dispatch 时才装配进瞬时子 agent 的 system prompt(运行态仍瞬时)。角色(谁在想)与视角(从什么角度想)是正交两层、概念上不冲突;但角色自带视角倾向,**"有角色时分配节点是照常给视角让二者叠加、还是让角色按自己天性走"留第二批架构前定**。第二批还提供**单角色临时唤醒**:用户直接唤醒一个角色完成一次性任务(N=1 的退化形态),同样继承完整历史快照、瞬时生命、使用时才装配提示词。

**默认多视角路径下**,用户**不感知、也不选择**差异来源,系统按可用条件自动取最强可用差异、复杂性吞进去——**用户在第二阶段显式选角色 / 组合时除外(那是用户主动指定,不属"系统自动取差异")**。"真差异"的实现锚点是**收窄的评判框架 + 独立不可见**,不是语气模仿;若多视角产出雷同,即视角没切好、或单模型局限触顶。

**与模型配置的边界**:现有"主 / 强力 / 轻量"三档是同一份工作里选算力档,与"从不同角度分析问题"是两个不同的产品概念;此处的"档位间隔"只是**借用已有档位**做免费附加差异,**不为本能力新增任何模型配置**——用户怎么配档位是他的事,我们不关注、也不承诺其差异效果。

**实现说明(`@` Mention Surface 的实现约束)**:以下是上面「触发口」规则对应的实现约束,从问题区讨论收口而来、放在需求区末尾存档(问题区可删),供第二部分架构与实现遵循——不是新需求,是"按需求规则落地时必须守住的点"。

1. **触发识别走 submit 扫描独立 `@` token**(不是 prefix-only、也不是 typeahead accept 直接执行):submit 路由扫描消息里第一个满足"`@` 前是行头或空格、`@` 后是空格"的 `@`,其后到末尾的**非空**内容作问题 → 触发多视角;找不到这种 token、或 token 后无正文 → 当普通消息。于是 `@ 评估X`(行头)、`帮我看看 @ X`(文中)都成立;`email@x.com`、`@file`、`@5` 不触发。
2. **typeahead 的 accept 只"发现 + 补全"、不执行**:裸 `@` 时给一个"多视角"入口——**做成可选候选(像选文件、Enter 选中)还是只显示一行 hint(如"空格 + 问题启用多视角")由实现期定**,两种只为可发现、都不"选中即执行"。若做候选,accept 只把草稿补成 `@ ` 留正文位(`execute=false`)、**不触发任何 action**;两种最终都靠提交时正文经第 1 条的 submit 扫描触发。`@具名`(`@file` / 第二批 `@角色`)走 typeahead token 补全。
3. **第一阶段由单一 `MentionProvider` 接管 `@`**:内部 `agent source`(空 query → 多视角)+ `file source`(非空 query → 文件;**承接并迁移现有 FileProvider 逻辑,以回归测试保文件补全行为字节不变**)。同一时刻按 query 只一个 source 接管展示 / 交互。**空 query 是 `agent source` 自己声明匹配的业务规则,不是 Mention 框架的上层特判**——框架只把 `@` token 交给各 source 按各自 `matchTrigger` 认领,绝不在框架层对空 query 做 if/else。
4. **第一阶段封死不做**(只预留结构、留第二批):**不做 `accept→action`**(`AcceptPayload` 的 `metadata` / `executionHint` 在通用提交链路并不消费,第一阶段不补这条生效面;**留到第二阶段、且仅当 `@角色` 要做成"选中即召唤、不写正文"时,才按需补这条生效面**)、**不做候选混排融合**(同一 query 多 source 并列,留到第二批角色名可能撞文件名时)。
5. **据以收口的现有事实**(核实、非凭印象):typeahead broker 按 priority "首个命中"接管、一个 trigger 同时只一个 provider 出候选(故走单一聚合 provider);`@` 前边界由 trigger 的 `requireBoundary` 原生支持;`AcceptPayload` 的 `metadata` / `executionHint` 通用提交链路不消费(故 accept 不能直接触发 action、多视角改走 submit)。

---

## 二. 架构设计

> 范围:第一阶段做到可执行;第二阶段只在第一阶段结构里留接缝、不实现。全程仅围绕需求基线。

### 0. 设计基线:复用什么、绝不造什么

一手代码已确认的可复用底座(本能力不重造任何一项):

- `runChildAgent`(`orchestrator/subagent/factory.ts`)+ `loop-runner`:子 agent 执行单元,永不抛、三态返回、自带 budget / 中断 / 安全 / 事件血缘。
- `AttentionWindow.getMessages()`(`core/context/window`):导出主窗口当前快照(`flatMap` 出的真副本)。
- `RunResult { runRecord }` + `buildRunRecord()` + `ConversationManager.recordTurn()`:一轮结果进窗口的接受协议(先持久化后 acceptRun)。
- `roles`(main / power / light)+ `runtime.run` 纯执行体(收 `messages[]`)。
- `SessionRuntime` 抽象(server 侧、已含一排 `forceCompact?`/`callText?` 等"adapter 透传运行体能力"的可选成员)、typeahead `trigger + provider`、session RPC(`session.delta` 主通道 = `AgentYield`;`session.event` 带外通道)。

**绝不造**:不造引擎、不造持久化、不造状态机、不改 `agent-loop` / `ToolExecutionContext`。编排器是一个**薄函数**,内部全是 `runChildAgent` 调用。依赖方向沿用现状:cli → server → orchestrator,且 **server 只通过 `SessionRuntime` 抽象用运行体、绝不 import 具体 orchestrator**。

### 1. 分层落点(守 core 干净 + server 抽象)

| 层 | 增量 |
|---|---|
| `@zhixing/core` | **不动**——多视角是策略层能力、不是 core 不变量,类型不进 core(否则又走"底座为产品形态背书"老路) |
| `@zhixing/orchestrator` | ① **子 agent dispatch 基座**(`TaskToolEnv` 提升为通用 env、Task/deliberation 共享);② 多视角**内部类型**(`ViewpointSpec` 等,不外暴露);③ 编排器(消费基座、经 `AgentRuntime` 暴露,内部类型**适配成 server wire 契约**);④ `runChildAgent` 通用化(`initialContext` + `profileInstructions`);⑤ 分配/优化/收敛提示词 + 视角解析 |
| `@zhixing/server` | ① `SessionRuntime` 抽象加可选 `deliberate?`,**并定义其最小 runtime/wire 契约类型**(snapshot / question / 结果文本+usage / phase 枚举——`DeliberationResult`/`Phase` 契约在 server 自有,不 import orchestrator);② RPC `session.deliberate`:取快照 → 调 `runtime.deliberate` → 收敛走 `recordTurn`;③ 进度走 `session.event`。**不 import orchestrator** |
| `@zhixing/cli` | ① `AgentRuntime` 实现 `deliberate` 能力、adapter 暴露为 `SessionRuntime.deliberate`;② typeahead `*` provider + **提交路由 deliberate action** |

### 2. 通用化 dispatch(改 `runChildAgent`,保持底座纯净)

`runChildAgent` 现在已接**具体** `provider`/`model`/`llmRoles`、且写死 `subAgentProfile` 与 `[Begin]`。**底座不该懂"档位/视角"这些上层策略**,故只做两处最小参数化:

```ts
interface RunChildAgentOptions {
  // …现有 provider/model/llmRoles/securityPipeline/… 不变…
  initialContext?: Message[];         // 默认 [Begin](Task 策略);传 [...snapshot, 当前问题] = 多视角策略
  profileInstructions?: string;       // 只读提示片段:覆盖子 agent 的 instructions(视角 / 第二批角色文本)
  // 刻意不开放 profile: AgentRoleProfile —— 见下「类型收窄」
}
```

- **不加 `modelRole`**:档位是策略。编排器先把"档位 → 具体 `provider + model`"解析好,用 `runChildAgent` **现有的** `provider`/`model` 入口传。
- **不加 `viewpoint`、不改 `buildSystemPrompt` 通用签名**:视角 = 一段注入 `instructions` 的文本,经 `profileInstructions` 传入。
- **类型收窄,工具白名单结构锁死(安全红线)**:**不开放 `profile: AgentRoleProfile`**——它自带 `enabledTools` + `capabilities.canSpawnSubAgents`,整体放开等于把工具权限也开放,而"传了也忽略"是约定、不是保证。故参数收窄成 `profileInstructions`(纯提示文本);子 agent 的 `enabledTools` 由 `runChildAgent` **内部固定**为只读探索集(`["read","glob","grep"]`、`canSpawnSubAgents:false`、`userFacing:false`),**调用方(Task / deliberation / 第二批角色)根本没有放大它的入口**。"不能改文件 / 跑命令"由此是**类型 + 结构保证**,不是约定。
- `factory.ts`:`initialMessages = opts.initialContext ?? [Begin]`;`instructions = opts.profileInstructions ?? subAgentProfile 默认`;`enabledTools` 恒为内部只读集。`Task` 不传这两项、字节不变;底座由此完全不知道"档位/视角"。

### 3. 多视角编排器(orchestrator 实现,经 `SessionRuntime.deliberate` 暴露)

编排器**消费一个统一的子 agent dispatch 基座**(见下),自己不再 capture env;再由 adapter 暴露为 `SessionRuntime.deliberate`。**server 只传 snapshot + 问题 + abortSignal,既拿不到也不需要这些资产**——同时解决"资产可达"与"server 不依赖 orchestrator"。

**子 agent dispatch 基座(子 agent 模块的本体)**:现有 `TaskToolEnv` 的注释自承"对齐 `RunChildAgentOptions` 的 shared 子集"——它本就是通用的"跑子 agent 所需共享资产"(`provider`/`model`/`llmRoles`/`securityPipeline`/`workspace`/`parentBroker`/`parentTools`/`riskMaxTokens` …),只是被 Task 独占。把它**提升为子 agent 模块的统一 dispatch 基座**:`create-agent-runtime` 装配期 capture **一次**,`Task` 工具、deliberation 编排器、第二批单角色唤醒**都消费同一个基座**,谁都不再各自 capture。这才让"子 agent 模块"名副其实(一个基座 + 多消费者);消费者增多(能力 B / AI 自动触发)只是接基座、不复制 env,杜绝 env 漂移。`parentBus`/`parentLineage`/`abortSignal` 这类 per-dispatch 的量仍由各消费者按次提供(基座只持"跨次共享"的资产)。

**事件路径**:子 agent 内部事件**沿用现有 `parentBus + lineage` 冒泡机制**(编排器把 capture 的 `parentBus` 传给每个 `runChild`,父订阅者按 lineage 过滤);`onPhase` **只**承载四阶段的高层进度(分配 / 推敲 / 收敛),不另起一套子事件投影,避免与 EventBus lineage 双轨。

```ts
// SessionRuntime 上的可选能力(与 forceCompact?/callText? 同构,缺失则 fail-fast)
// 下列类型(DeliberationResult / DeliberationPhase / RoleSpec)是 server 定义的最小 wire 契约;
// orchestrator 编排器内部可有更丰富类型,实现时 adapter 适配成这套契约——server 不 import orchestrator。
deliberate?(input: {
  snapshot: readonly Message[];   // 主窗口只读快照
  userQuestion: string;           // 本次被多视角审视的问题
  requestedCount?: number;
  abortSignal: AbortSignal;       // 必传:贯穿每个子 runChild,连接关闭 / 用户中断时级联取消
  onPhase?: (p: DeliberationPhase) => void;  // 仅高层阶段进度;子 agent 事件走 EventBus lineage
  roleSlots?: RoleSpec[];         // 第二阶段接缝,第一批恒空
}): Promise<DeliberationResult>
```

四阶段(全是 `runChild` 调用,**"档位 / 视角"都在编排器内解析成"具体 provider+model / profile"**):

1. **分配**:`runChild({ initialContext: [...snapshot, 当前问题], profileInstructions: 分配指令(count) })` → `parseViewpoints` → `ViewpointSpec[]`。
2. **并发**:`Promise.all(viewpoints.map((v,i) => runChild({ initialContext: [...snapshot, 当前问题], profileInstructions: 视角文本(v), provider/model: 档位(i) })))` → N 份初稿。
3. **交叉优化**:同上,但 `profileInstructions = 视角文本(v) + 自己的初稿(待优化对象) + 其余 N-1 份初稿(参考)`——子 agent 是新调用、不记得自己上轮初稿,故自己那份也要回传。
4. **收敛**:`runChild({ initialContext: [...snapshot, 当前问题], profileInstructions: 收敛指令(优化稿) })` → 收敛判断文本。

- **子 agent 输入 = snapshot(主窗口历史)+ 当前问题**:`snapshot` 本身不含本次问题,故当前问题作为末条 user 消息拼进 `initialContext`,与主对话 run 输入 `[...window, userMessage]` 同构;问题不只放 system prompt。
- **数量闸门**:`clamp(requestedCount ?? 3, 1, 5)`,超 5 截断。
- **档位间隔**:编排器内 `slot(i)=power?(i%2?power:main):main`,**解析成具体 provider/model** 再传 `runChild`。
- **快照只读**:`getMessages()` 是 `flatMap` 新数组(真副本),编排器与子 agent 只读、不写回主窗口。
- **工具锁死**:分配 / 视角 / 收敛只改 `profileInstructions`,`enabledTools` 恒为 §2 的内部固定只读集(`read`/`glob`/`grep`、不可派生)——多视角全程只读思考,不改文件 / 不跑命令。

### 4. 结构化输出(subagent 无 schema 的应对)

确认底座无 schema 强制,故:

- **分配节点**:提示词约定输出 JSON 数组 `[{ "angle": string, "instruction": string }]`;`parseViewpoints` 做 `JSON.parse` + 形状校验 + 兜底(解析失败重试一次,再失败降级为 count 个"通用分析侧重"占位,绝不让整条链失败)。
- **优化 / 收敛节点**:自由文本即可——收敛判断本就是给用户看的一段话,不需机器结构。

### 5. 快照下传 + 收敛回主线(server-turn 集成面)

> **编排器与集成面解耦**:编排器只产出 `DeliberationResult`(收敛文本 + usage),"怎么回主线"是消费者的事。本节是**第一阶段的 server-turn 集成面**(`*` 手动触发、主 agent 不参与、收敛作一轮进窗口);终态的 loop-tool 集成面见 §7——同一编排器、换个消费者,核心不动。

RPC `session.deliberate` 与 `session.send` 守**同一 turn 纪律**(经 `ConversationManager.admitTurn` 入列、`busy` 串行、可 `abort`,绝不与 `send` 并发写同一窗口):

1. **turn admission + 可中断**:handler 走 `admitTurn`(与 `send` 同入口)拿 turn 槽位 + `abortSignal`;`busy` 期间与 `send` 互斥排队。`abortSignal` 透传进 `runtime.deliberate`、再贯穿每个子 `runChild`——连接关闭 / 用户中断时整条链级联取消。
2. **自建投影路径(不复用 `projectSessionTurn`)**:`projectSessionTurn` 内部绑死 `runTurnWithCommit → runtime.run`(agent loop generator 专用),而 deliberate 走 `runtime.deliberate`(Promise + 四阶段),喂不进去。故 deliberate 复用的是**更底层**的 `admitTurn` / `recordTurn` / `notify` 组播,**自建**投影:`onPhase` → `notify(session.event)` 推阶段进度(分配中 / N 路推敲 / 收敛中)。
3. **收敛文本走内容通道,投影顺序固定**:核实 CLI 渲染层——只有 `text_delta` 走 markdown 可见,`assistant_message` 是**空 case(不渲染)**,`complete` 也不载文本。故收敛判断的投影顺序必须是:① `text_delta`(发收敛文本、用户可见)→ ② `assistant_message`(作协议最终消息、进 transcript / `recordTurn`)→ ③ `turn_complete` → ④ `session.complete` 收束。**绝不能只发 `assistant_message`、也不能指望 `complete` 带文本**。
4. **收敛回主线 = `ChildAgentResult` 适配进窗口**:收敛那次 `runChild` 返回 `ChildAgentResult`(三态 + finalText + usage),**不是** `AgentResult`,需一层适配——finalText 包成一条 assistant 消息作 `newMessages`、usage 拼成 `agentResult.usage`,再 `buildRunRecord({ userMessage: 问题, newMessages, agentResult })` → `recordTurn` 进窗口。下轮主 agent `getMessages()` 即带上"问题 + 收敛"。
5. **收敛轮的作者语义(已知取舍)**:这一轮不走主 agent loop,收敛判断由收敛 agent 产出、以 `assistant` 角色进窗口——对用户都是"知行",可接受;长期若 `*` 高频需关注主 agent 连续性。
6. **不污染**:子 agent 中间过程只走各自(经 lineage 派生的)bus、用完即弃,绝不进主窗口;主窗口只多 `recordTurn` 的"问题 + 收敛"一条。

### 6. 触发链路(cli)

- typeahead 加 `*` provider(补全候选)。
- **关键:`*` 必须落在提交路由层,不只是 provider**——现有 `onSubmit` 经 `normalizeLeadingSlashAlias` 把提交文本分流成"命令 / 普通文本";`*` 前缀要在这一层加一个 **deliberate submit action** 分支(类比 `/` 命令分支),路由到 `session.deliberate`。否则它会被当普通文本走 `session.send` 发给 agent。
- 输入 `*` 触发默认多视角、可顺手带数量(如 `*5`);第一批不弹角色 / 组合候选。
- **`*` 的定位**:第一阶段的**手动辅助入口**,不是这个能力的"用户功能门面"——它与未来 AI 自动触发并存,不能让"用户学会用 `*`"固化成内功外露的退化。

### 7. 第二阶段接缝(本阶段只留口、不实现)

- `runChildAgent.profileInstructions` 入口同时接"视角"(第一批)与"角色"(第二批)——两者都只是**提示文本**,`enabledTools` 恒为 §2 的内部固定只读集;第二阶段角色结构上**无法放大工具权限**,dispatch 不变。
- `deliberate` 的 `roleSlots` 已在签名预留(第一批恒空)。
- `session.deliberate` 参数、typeahead 面板预留"角色 / 组合候选"位。
- **单角色临时唤醒** = `runChild({ initialContext: [...snapshot, 问题], profileInstructions: 角色文本 })` 单次 + `recordTurn`(N=1 退化,复用同一 dispatch 与回主线)。
- 角色 × 视角配合(叠加 / 角色自走)= 第二批在"profile 组装"这一处定,不动 dispatch、不动编排骨架。
- **loop-tool 集成面(终态接缝)**:工作台定义能力 A 终态是"主 agent 一次调用的原语"。因编排器已与回主线解耦(只产 `DeliberationResult`),终态把它做成主 agent loop 内的一个工具 / 机制即可——主 agent 在自己 turn 内调同一个 `runtime.deliberate`,收敛结果作 `tool_result` 回它综合(而非 server-turn 那样直接 `recordTurn`)。这是 AI 自动触发与能力 B 编织多视角的入口;**第一阶段不实现,但因核心解耦,终态加它只是加个消费者、不返工**。

### 8. 改动清单(可执行)

- `core`:**不动**(多视角类型不进 core)。
- `orchestrator`:① **把 `TaskToolEnv` 提升为通用 `SubAgentDispatch` 基座**(装配期 capture 一次,`Task` 改为消费它——纯重构,Task 行为字节不变);② `subagent/factory.ts` 加 `initialContext` + `profileInstructions` 两参数(`enabledTools` 内部锁只读、不开放);③ 新增 `deliberation/`(`types.ts`、`orchestrator.ts` = 编排器、`prompts.ts`、`parse.ts`、固定只读 profile 工厂),编排器消费基座;④ runtime 装配期创建编排器、`AgentRuntime` 暴露 `deliberate`;+ 单测。
- `server`:① `SessionRuntime` 抽象加 `deliberate?`(签名含 `abortSignal`);② `cli/serve` 的 adapter 透传 `AgentRuntime.deliberate` → `SessionRuntime.deliberate`;③ `rpc/methods/deliberate.ts`:走 `ConversationManager.admitTurn`(与 `send` 同 turn 纪律)→ `runtime.deliberate(abortSignal, onPhase)` → 进度 `session.event`、收敛文本 `session.delta`、适配 `ChildAgentResult` → `recordTurn` → `complete` 收束;+ 注册 + 单测。**不 import orchestrator、不复用 `projectSessionTurn`**。
- `cli`:① typeahead `*` provider;② 提交路由 deliberate action;③ 触发调 `session.deliberate`;+ 单测。

### 9. 验收(到可执行)+ 已知取舍

- 单元:dispatch 两参数化(Task 零变化 + `initialContext`/`profileInstructions` 装配)、**工具白名单结构锁死(无 `enabledTools` 入口、恒为只读集)**、`parseViewpoints`(正常 / 超 5 / 解析失败兜底)、档位间隔解析成具体 provider/model(有 / 无 power)、数量 clamp、四阶段(mock `runChild`)、`deliberate` 缺失时 fail-fast。
- 集成:`*` 提交 → 走 `admitTurn`(与并发 `send` 串行、不竞态写窗口)→ 四阶段 → 收敛文本经 `session.delta` 可见 + `recordTurn` 进窗口;进度走 `session.event`;**中途 abort 整条链级联取消**;无 power 全 main、有 power 间隔。
- 守恒:`core` 无多视角类型;`server` 不 import orchestrator(走 `SessionRuntime.deliberate`)、不复用 `projectSessionTurn`;**子 agent 工具集恒为只读(不改文件 / 不跑命令)**;主窗口只增"问题 + 收敛"一条;子 agent 中间过程不进主窗口 / transcript。
- **成本真相**:并发 + 交叉优化 = 2N+2 次 `runChild`,其中**交叉优化轮是 O(N²) token**——子 agent 瞬时独立、新调用不记得自己的初稿,故每个优化 agent 的输入 = 自己的初稿(待优化对象)+ 其余 N-1 份(参考)= N 份,N 个 agent 合计约 N² 份初稿量,是整条链的成本大头,数量上限 5 主要勒的就是这一轮。
- **产品前提(架构保证不了)**:本能力第一阶段的价值,取决于"用户真会在该用时按 `*`、且觉得这份多视角判断值回延迟与成本"——架构只保证不坏、可恢复、不污染、成本可控,保证不了"用户爱用",需第一阶段真实验证。

---

## 三. 实现执行计划(提交拆分)

**判断:不作为一次提交,拆 4 个提交单元。** 本能力横跨 orchestrator(基座 + 编排器)、server(契约 + RPC)、cli(触发)三个包四个关注点,且是一条清晰的单向依赖链;一次性提交会让 review 失焦、回滚粒度过粗。按依赖链拆成 4 个各自可构建、可测试、可独立合入的单元:

**提交 1 — 子 agent dispatch 基座 + `runChildAgent` 通用化(纯底座重构)**
- 把 `TaskToolEnv` 提升为通用 `SubAgentDispatch` 基座、`Task` 改消费它;`runChildAgent` 加 `initialContext` + `profileInstructions`、`enabledTools` 内部锁只读。
- **不引入 deliberation**,是纯重构 + 参数扩展,只动底座、不改任何对外行为——最易 review / 回滚,风险隔离在第一步。
- 验收:`Task` 行为**字节不变**(回归)+ 新参数单测;`pnpm build` 绿。

**提交 2 — deliberation 编排器(orchestrator 内自洽)**
- 新增 `deliberation/`(编排器四阶段 + 提示词 + `parseViewpoints` + 固定只读 profile 工厂)、`AgentRuntime` 暴露 `deliberate`,编排器消费提交 1 的基座。
- 验收:编排器单测(mock `runChild`:四阶段、数量 clamp、档位间隔解析、解析失败兜底)。能力就位但未接 UI。
- 依赖提交 1。

**提交 3 — server 接入(契约 + RPC + 回主线)**
- `SessionRuntime.deliberate` 契约类型(server 自有)+ adapter 透传 + `rpc/methods/deliberate.ts`(`admitTurn` turn 纪律 + `abortSignal` 级联 + 进度 `session.event` + 收敛文本 `text_delta` 投影顺序 + `ChildAgentResult` 适配 → `recordTurn`)。
- 验收:RPC 单测(turn 串行、投影顺序、回主线、abort 级联);静态校验 server 不 import orchestrator。
- 依赖提交 2。

**提交 4 — cli 触发(端到端打通)**
- typeahead `*` provider + 提交路由 deliberate action + 调 `session.deliberate`。
- 验收:端到端——`*` 提交 → 四阶段 → 收敛文本可见 + 进窗口;`pnpm cli` 自跑视觉确认。
- 依赖提交 3,此步用户首次可见。

**节奏**:每个提交独立构建(动上游包用 `pnpm build`、仅 cli 用 `pnpm cli:build`)+ 跑该层测试通过再合;提交 2、3 合入时**无 user-facing 效果**(能力就位、未接 UI),提交 4 才端到端可见——这是水平分层的预期,不是遗漏。提交本身按既有纪律由你拍板,我只在每个单元做完、构建测试通过后交回。
