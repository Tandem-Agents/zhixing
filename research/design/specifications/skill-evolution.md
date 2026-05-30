# 技能（Skill）自我进化 — 技能管家架构规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **本文是执行规格(execution spec),不是修订日志。**
> **只写**:当前生效的架构与方案、决策的"为什么"、与真实代码的对接点(精确到文件:符号)。
> **不写**(协作者修订时一并清理):版本号 / 修订日期 / "最后更新";"vX vs vY" 对比;"改了什么 / 废案"叙事。
> **演化方式**:设计变化时**原地修改**,不追加修订段。历史留给 `git log`。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **需求依据**:[drafts/skill-module.md](../drafts/skill-module.md) §2.3 /§3「自我进化(谨慎版)」、§4「第二版·自进化」。
> **父规格**:[skill-system.md](./skill-system.md)(Store / 索引 / `load_skill` / 控制面 §五 / §九 v1→v2 插座)。
> **相关规格**:[skill-authoring.md](./skill-authoring.md)(**起草引擎** —— v2 自主产生 / 迭代复用的同一引擎)。
> **事实依据**:对接点均对已落地代码核实,标注 `文件:符号`。

## 〇、定位与范围

本文回答 **v2 怎么让技能库"越用越懂我"**。v1 是静态 + 手动的技能库;v2 引入**技能管家(Skill Steward)**——一个自主负责技能**产生 / 迭代 / 治理**的后台角色,把静态库变活体。它全程建在 v1 已落地的插座(§一)与**来源边界**(§二)之上,是**纯增量、不返工 v1**(父规格 §九铁律)。

- **本文范围**:产生(回合后台复盘)、治理与淘汰(周期 curator)、来源标记与写隔离、度量第二消费者。
- **不在范围**:v1 已有的渐进披露 / 索引 / 加载 / 唤醒 / 管理器(§五)/ 创作(skill-authoring.md)/ 接入(§六)—— 管家**复用**它们,不重述。
- **不可动摇的边界**:技能管家**只处理它自己产生的技能**;人手写的、人让 AI 在前台写的(`/skill-new`)、外部接入的(`/skill-add`),一律算**用户的**、管家不碰。这是"自我进化敢放手"的前提 —— 自动化越权改用户 / 官方技能是不可接受的。

## 一、建在 v1 的哪些插座上

v2 不新造地基,接 v1 留好的插座(父规格 §九 / skill-authoring §七;均已落地核实):

- **起草引擎** `draftSkill` / `reviseSkill`(`core/src/skills/drafting.ts`)—— 设计上就是 v1/v2 共享插座:v1 接「用户触发 + 屏内策展」,v2 接「自主触发 + 来源边界」,**同一引擎、换触发方**。引擎只收注入的窄 LLM 接口、不绑运行时,故 v2 在 orchestrator 绑自己的 `callText("main")` 即可。
- **度量** `usage/`(Store)—— v1 已用于 top-N 排序;v2 加**淘汰判断**第二消费者(§五)。
- **可逆删** `Store.archive`(`store.ts`)—— 移到 `archived/`、扫不到但不物理删;管家的淘汰即调它(§四)。
- **per-id 可扩展状态** `index.json` 的 `SkillState`(`{id, mode, pinned, disabled, createdAt}`)—— v2 加 `stewardCreated`(来源标记,§二)与 `lastCuratedAt`(治理轮转,§四)两字段即纯增量。
- **模式匹配范式** `content-scan.ts` / `secret-scrubber.ts`(`core/src/security` 与 `core/src/skills`)—— v2 复用其纯函数确定性匹配范式,做"用户沉淀信号"检测(§三触发)。
- **凭证脱敏** `scrubSecrets`(`core/src/security/secret-scrubber.ts`)—— 起草引擎已内置,管家产物天然过滤(§六)。
- **systemPrompt 可重建** —— v1 `systemPrompt` 保持闭包 `const`、`buildSystemPrompt` 是可重调纯函数;v2 把它 holder 化,技能集变更在**注意力窗口生命周期边界**经父规格 §3.3 的重建检查反映(§八)。
- **回合事件** —— `agent:run_end`(`agent-events.ts`,payload 含 `reason`)标记一次完整 agent run(用户的一次交互 / 任务)结束,是"做完一摊事"的复盘时机。注意 eventBus 是 **per-run**(每次 run 新建),不存在可持续订阅的全局 bus;故经 `decorateRunBus` 钩子(`DecorateRunBusFn`,`create-agent-runtime.ts`)在**每次 run 的 bus** 上挂监听(同 cli 既有的 renderer / retry / context 装饰),**只在 `reason==="completed"` 触发**(aborted / error / max_turns 不复盘)。**不取 `turn_complete`** —— 那是单个 LLM 工具轮、过于频繁且语义不对(§三)。
- **调度** —— `scheduler`(`core/src/scheduler/`)的周期任务(`interval`/`cron` + `system` 动作,同 `__journal-gc`)是治理 curator 的载体(§四)。

## 二、来源标记与写隔离(放手的前提)

**来源标记**:`SkillState` 加一个 `stewardCreated` 布尔(默认 `false`,v1 插座 = per-id 状态可扩展)。管家产生技能时标 `true`;其余一切(`/skill-new` 创作、`/skill-add` 接入、用户手放目录)都是 `false` = "用户的"。来源边界 = 管家只读写 `stewardCreated === true` 的技能,对 `false` 一律不碰。用户**接管**一个管家技能(改其内容)应转"用户的"(清 `stewardCreated`)—— 但 v1 没有"编辑已有技能"入口(创作只新建、管理器只 pin / 禁用 / 改 mode / 归档),故这条转移随 v2 的编辑入口一并落地;**在那之前,用户保护某个管家技能靠 `pin`**(管家淘汰跳过 pinned,§四)。注意这与 `linked` 的 fork-on-edit 是两回事 —— 后者是用户改**接入**技能时 copy 到 `own/`,那些本就 `stewardCreated=false`。

**写隔离(两道兜底各司其职)**:管家**不直接用** Store 的通用写 API(`create`/`update`/`admit`/`archive` 是用户 / cli 路径用、能写任何区);管家经**受限写门 `StewardWriter`**(v2 新建,封装 Store),只暴露「在 `own/` 下新建并标 `stewardCreated`」「改 / archive 技能」。**不写接入区 = 能力层**保证:`StewardWriter` 根本不暴露 `admit`(唯一写 `linked/` 的入口),即便上层逻辑全错也写不进接入区。**不动用户技能 = 逻辑层**保证:每次写前校验目标 `stewardCreated===true`。这与父规格 §九「v1 `linked` 物理只读、v2 决断 `own` 是否再细分」一致,`StewardWriter` 是那道决断的落点。

> 用户侧不受此限:用户随时能改任何技能(改接入技能走 `update` 的 fork-on-edit copy 到 `own/`,原件不动),这是 v1 已有的能力,与管家写门正交。

## 三、产生(回合后台复盘)

**触发**:经 `decorateRunBus` 在每次 run 的 per-run bus 上挂 `agent:run_end` 监听(与 cli 既有 renderer 装饰组合成一个 `DecorateRunBusFn`),**仅 `reason==="completed"` 才算**(过滤 aborted / error / max_turns)。

**门槛 = 确定性沉淀信号(主)+ 计数兜底(辅)**:`run_end` 不携语义,但 `state.conv.messages` 在手 —— 用**确定性模式匹配**(复用 `content-scan` / `secret-scrubber` 同款的纯函数模式范式,零 LLM 成本)扫用户消息里的**教学 / 约定 / 纠正措辞**(中英:记住 / 下次 / 每次都 / 总是 / 不对、应该 / 我们一般 / 以后别 / remember / always / from now on / don't…)。命中即"用户正在教一个可复用做法 / 立一条约定"的强信号。
- **信号命中** → 立即上 `main` 精判,及时抓住用户在沉淀的时机;
- **信号没命中** → 计数兜底:每累积 `N` 个 completed run 才复盘一次,捞确定性模式漏掉的隐性沉淀;
- **既无信号、又没到计数** → 不烧 main(闲聊 / 一次性问答绝不打扰)。

信号优先 + 计数兜底,比盲目每 N 次烧一发**准得多、又仍廉价**(信号是确定性的)。复盘**后台 fire-and-forget**、不阻塞用户下一轮(监听器只做模式匹配 + 计数,复盘异步)。最终"值不值得"仍由下面的 main 精判定夺 —— 信号只负责把"值得让 main 看一眼"的时机挑出来。

**复盘判定(产生的真命门 —— 定死,不甩给一句「交给 LLM」)**:`main` 档单发。
- **输入**:最近对话(`state.conv.messages` + `extractText`,同退出纪要范式,skill-authoring §二)+ 当前 mode 的现有技能索引(**含来源标记** —— 让它知道哪些可迭代、哪些是用户的碰不得、避免重复造)+ **近期自产反馈**(§五:自产里被用户删 / 禁、零命中的比例)。
- **输出契约**:`skip` / `create`(新建草稿)/ `revise`(迭代,目标 id + 改动)—— **`revise` 的目标只能是自产技能**(`stewardCreated`);若这摊事已被**用户 / 接入技能**覆盖,管家不得改它(来源边界,§二),只能 `skip`。
- **判定原则**(写进"安全裁判"式 system 角色):只沉淀**可复用的程序性做法 + 用户的特定约定 / 踩过的坑**;**排除**一次性任务、通用常识;已被覆盖的 —— 覆盖者是自产则 `revise`、是用户 / 接入则 `skip`。**宁缺毋滥** —— 拿不准就 `skip`(误产噪音的代价 > 漏沉淀一次,后者下次还有机会);近期自产被大量否掉时更收紧。原则措辞可实测调,但「输入 / 输出契约 / 判定维度」定死。

**产出**:复用起草引擎 —— 新建走 `draftSkill`、迭代走 `reviseSkill`(读已有技能成 draft 再改写 —— **该读不计 hit**,见 §五),产物过 `scrubSecrets` 脱敏(引擎内置),经 `StewardWriter` 落 `own/` 标 `stewardCreated`。`mode` 按**产生时所处模式**自动定(main 模式产生 → `main`、工作场景产生 → `work`),不靠模型判断(父规格 §七)。

**落盘策略 —— 默认自主、产生即告知、用户事后控制**:v2 默认**自主落盘**(标 `stewardCreated`),不每次打断用户确认 —— 否则不叫"无感自动攒"(drafts §2.3)。但**完全无感会让技能凭空出现、用户困惑**,故产生时给一行**轻通知**(告知"已把『X』存成技能,可在 /skills 管理",**不要求确认、不打断**)。用户控制在**另一端**:`/skills` 管理器看到管家产物(来源可视区分)、可删 / pin / 改。skill-authoring §七 的「proactive offer(产生时提议用户确认)」是 v1 用户确认闸门的演化点,作为**可配置的温和模式**预留;默认自主 + 轻通知。这条「自主落盘」的安全底气全在 §二的来源边界 + 写隔离 + §六脱敏。

## 四、治理与淘汰(周期 curator)

**调度(基于 scheduler 真实行为定死,不留"如每日"占位)**:注册为 `scheduler` 的 **system + `interval` 任务**(`__skill-curator`,同 `__journal-gc`;system 任务不可被用户误删 —— `scheduler.ts:210`)。**用 `interval`、不用 `cron`**:CLI 是开关不定的交互进程,固定钟点(cron)在没开终端的时刻根本不跑;`interval` 的下次时间从**上次跑完**算(`computeNextRunAt` 用 `finishTime` —— `scheduler.ts:494`),语义是「距上次治理跑完满 `everyMs` 才到下次」,不绑作息、不绑钟点。
- **触发检查时机**:开着终端时进程内 `TimerLoop` tick;关终端期间到点的,**下次启动由 `start()` 的 missed 检查补跑一次**(`scheduler.ts:97-114`)—— 用户哪天没开机不丢、下次补。
- **防重复**:scheduler **内建** —— `activeTasks` Set 挡执行中重入、跑完才从新 `finishTime` 重算 `nextRunAt`(`scheduler.ts:322-350`),v2 不自管。
- `everyMs` 的值(如 24h)是唯一可调参数(且 ≥60s,`scheduler.ts:148`)。curator 内部用 `main` 档判定(治理高副作用)。

**候选选取(两条线 —— 轮转保覆盖 + 相似度找重复)**:`SkillState` 加 `lastCuratedAt`(上次被治理审查的时间;新建 / 接入时初始化为 `createdAt`)。每轮:
- **轮转线(淘汰用)**:取**自产技能里 `lastCuratedAt` 最旧的 N 个**(升序轮转)—— 保证每个自产终会被审到、不遗漏,且有上界、不扫全库(N 是可调预算)。淘汰是逐个问题("它还有用吗"),适合轮转。
- **相似度线(合并 / 泛化用)**:对这批每个,用**确定性相似度**(description / 正文的词集重叠,复用"确定性粗筛 + main 精判"思路)在全库自产里捞出**疑似重复 / 可归纳的邻居**。合并 / 泛化是跨技能问题,不能靠"碰巧同批"—— 必须主动按相似度找,否则该合的永远碰不到一起。

把"这批 N 个 + 各自相似邻居"连同 `usage` 喂 main:逐个判淘汰、对相似组判合并 / 泛化;审完更新被审项的 `lastCuratedAt`。

**治理动作**(均限 `stewardCreated===true`,经 `StewardWriter`):
- **合并** —— 多个冗余技能并一个;
- **泛化** —— 多个特例归纳成一个通用技能;
- **淘汰** —— 见下。

**淘汰防误删(安全关键)**:删不删交管家**判定**(内容 + 使用信号 `usage` + 是否已被取代),**绝不设"X 天没用就删"的死阈值**(低频但仍精准命中的技能正是高价值)。删 = `Store.archive`(**可逆**,移 `archived/`、不物理删)。**一律不动**:`pinned`(用户钉住)/ `stewardCreated===false`(用户 / 官方 / 接入)/ 仍有近期命中的 —— 来源标记 + `pinned` + `usage` 三道守门,任一中即跳过。

## 五、度量与反馈闭环(让它越用越准)

`usage/`(v1 已建:最后命中时间 / 次数,top-N 排序的消费者)加管家**淘汰判断**作第二消费者。**关键不变量**:`hit` 是 agent 经 `load_skill` **真实使用**的专属采集点(`store.ts:loadText` 内 `recordHit`);**管家侧的读 —— 迭代时读技能成 draft、治理时扫描候选 —— 一律不计 hit**,否则管家自己的读会虚增使用度、污染它据以判淘汰 / 排序的度量(自我污染)。实现上管家走"读不记 hit"的途径(`loadText` 加不计 hit 选项,或单独的只读不计量入口)。保持 v1 的**极简信号**取向 —— **不建 active/stale/archived 状态机**(Hermes 那套);判断交管家用 `main` 档综合,而非状态机阈值跳转。度量不暴露用户。

**反馈闭环 —— "自动产 + 自动清"升级成"自我进化"的那一环**。光靠"产了再被治理清掉"会陷入"持续产噪音→清→再产"、判断永不长进。补一条把**用户的纠正**反哺给产生判断的线:

- **用户显式行为(一等反馈)**:用户在 `/skills` 对**自产技能**(`stewardCreated`)的删 / 禁 = "这个不该产"(强负反馈)、`pin` = "这个很好"(正反馈)—— 比命中率更直接,用户亲手否掉的就是判断错了。
- **自产命中率(辅反馈)**:自产产生后长期零命中 = 可能无价值(与一等反馈互补、非主依据)。

这些**全从现有状态即时算、不新增采集 / 持久化**:被删 = `archived/` 里的 `stewardCreated`、被禁 = `stewardCreated && disabled`、被 pin = `stewardCreated && pinned`、零命中 = `stewardCreated && usage 无 hit` —— 都已落在 index / usage / archived 区,治理 / 复盘时扫一遍即得"自产留存率"。把它**喂回产生复盘的判定输入**(§三),让 main 据"我产的多被用户否掉 / 没人用"自我收紧。反馈喂回 prompt、由 main 自校准,**不引入外部调参控制系统**(符合"判断交 LLM")。效果:用户的每一次删 / pin 都真实反哺,产生判断**越用越准**,而非垃圾反复产清 —— 这是这个核心功能"对用户真有效"而非"高级累赘"的命门。

## 六、凭证脱敏

产生 / 迭代的每次产出都过 `scrubSecrets`(系统层,起草引擎已内置,skill-authoring §五)—— 对话里冒出的 secret 绝不固化进管家技能(技能反复加载且设计上可分享,危害放大)。导出 / 分享同理复用同一件。

## 七、归属与对接点(汇总)

| 包 | 内容 | 关键对接 |
|---|---|---|
| `core/src/skills/` | 技能管家逻辑(复盘 / 治理 / 淘汰判定)、`StewardWriter` 受限写门、确定性沉淀信号检测、治理候选轮转、自产反馈聚合 | 复用 `drafting.ts`(`draftSkill`/`reviseSkill`)、`store.ts`(`archive`/`update` fork-on-edit、`usage`、不计 hit 的只读入口)、`SkillState` 加 `stewardCreated` + `lastCuratedAt`、`content-scan.ts`/`secret-scrubber.ts`(模式匹配范式) |
| `orchestrator` | **暴露**触发 / LLM / 调度能力(管家判定逻辑不在此,见 core) | `agent:run_end` 事件 + `DecorateRunBusFn` 钩子(`create-agent-runtime.ts`,per-run bus)、`AgentRuntime.callText(_, "main")`、`scheduler` 的 `systemHandlers` Map 注入 + `system` 周期任务(`task-executor.ts`,同 `__journal-gc`)、`buildSystemPrompt` holder 化(父规格 §九/§3.3) |
| `cli` | **装配接入**:经 decorateRunBus 挂 `run_end`(`reason==="completed"`)复盘监听、喂 `state.conv.messages`、绑 `callText("main")`、注册 curator 周期任务;`/skills` 的来源可视区分 + proactive 开关(反馈由 core 治理 / 复盘时从 index/usage/archived 即时算,cli 不额外采集,§五) | `decorateRunBus` 组合(同 renderer / retry / context 装饰)、`state.conv.messages`、`scheduler` 注册、`/skills` 管理器(父规格 §5.2)、`tRegistry.refresh()` |

## 八、systemPrompt 边界重建(父规格 §九插座)

管家产生 / 淘汰改变技能集(`own/` + `index.json`)→ 下次 Index 产出变 → 模型需在适当时机见到。但 `systemPrompt` 是 prompt cache 的稳定前缀(`create-agent-runtime`「prompt cache 死线」),按父规格 §3.1:**单个注意力窗口生命周期内 byte-equal 不动,只在跨窗口边界(压缩 / 模式切换 / resume)才允许重建**。故管家**不主动重建 systemPrompt**(在窗口内重建会破 cache),只改技能集落盘;模型见到管家的新 / 删技能是在**下一个注意力窗口生命周期边界**,由父规格 §3.3 的边界重建检查完成 —— 比对当前 mode 的 Index 产出(结构 hash + top-N),变了才重渲染索引段、替换 holder(v1 已留插座:`const systemPrompt` → `holder.value`),没变 byte-equal 不破 cache。挂载点是 §3.3 描述的「注意力窗口生命周期边界订阅点」(如 `context:compact_end`),**不属 skill 模块**;管家只是技能集的变更方之一(与用户创作 / 接入并列),**不是重建的触发者**。

## 九、测试拓扑

- **触发门槛**:`agent:run_end` 仅 `reason==="completed"` 才计;三分支断言 —— **确定性沉淀信号命中 → 立即上 main**、**无信号但计数到 N → 兜底复盘**、**既无信号又没到计数 → 不烧 main**;复盘后台异步、不阻塞(注入 mock 事件 + mock LLM,断言信号匹配是纯函数 + 低频 + 非阻塞)。
- **复盘判定**:输入含现有索引(带来源标记)+ 近期自产反馈;输出 `skip` / `create` / `revise`;**`revise` 目标只能是自产 —— 覆盖者是用户 / 接入技能时只能 `skip`、绝不越界改**(安全关键);宁缺毋滥(拿不准 `skip`);产物过脱敏、`mode` 按产生模式定;mock LLM。
- **来源边界 + 写隔离**:`StewardWriter` 只写 `own/` 标 `stewardCreated`、改 / archive 仅限 `stewardCreated===true`;**不暴露 `admit` → 能力层根本写不进 `linked/`**;对 `stewardCreated=false`(用户 / 接入)拒写。
- **治理候选**:轮转线取 `lastCuratedAt` 最旧 N 个(保证覆盖、不扫全库、审后更新 `lastCuratedAt`);相似度线确定性捞自产相似邻居(合并 / 泛化不靠碰巧同批)。
- **淘汰防误删**:`pinned` / `stewardCreated===false` / 近期有命中 一律跳过;删走 `archive`(可逆,`archived/` 可恢复);无死阈值(低频但近期命中的不删)。
- **反馈闭环**:被删 / 禁 / pin / 零命中**从 index/usage/archived 即时算**(不新增持久化)→ 汇成自产留存率喂回复盘输入 → 留存率低时判定收紧(注入"近期多被否"的状态,断言 main 输入带上该信号、倾向 `skip`)。
- **度量第二消费者**:`usage` 同供 top-N 与淘汰;**管家侧读不计 hit**(自我污染防护);无状态机。
- **systemPrompt 重建**:管家改技能集 → 下个窗口边界 holder 重建检查(hash 比对、没变不破 cache),管家非触发者。
- 纯逻辑注入 mock(LLM / 事件 / scheduler / Store / fs),无真网真 LLM 真调度。

<!-- ══════════════════════════ 待解决 · 核心问题(先锁问题、不谈方案) ══════════════════════════ -->
> 下面不是方案,是"想把这个需求做好、必须先回答好的核心问题"。先锁问题,解法再落到上面各节正文。

## 把"自我进化"做成资产而非累赘 —— 核心问题

v2 的本质需求:让技能库从**静态手动**变成**自主活体** —— 管家在后台自己产生 / 迭代 / 淘汰技能,使其越用越懂用户。难点不在"能不能自动做",而在**自主的同时不越权、不产噪音、不失控**。决定它是资产还是累赘的,是下面几个问题:

1. **判准 —— 什么才算"值得"。** 哪些对话片段值得固化成技能、哪个该迭代、哪个该淘汰,判准本身如何定。定不准,产出要么是噪音累赘、要么漏掉真价值 —— 这是整个进化的质量源头,也最难定死。
   - **〔hermes〕** 判断整个交给 fork 出的 review agent 读一段**固定 review prompt** 自己定(`agent/background_review.py:_SKILL_REVIEW_PROMPT`):基调是"**Be ACTIVE**、多数会话至少产一条、不产即错过学习"(与我们"宁缺毋滥"相反),要 class-level 伞形技能(富 SKILL.md + `references/`,不要一堆窄技能);信号=用户纠正风格/工作流、冒出非平凡技巧、已加载技能出错;并明列 Do-NOT-capture(环境失败、对工具的负面断言、瞬时错误、一次性任务)。治理判准另在 `agent/curator.py` 的 prompt(积极合并成伞形、archive 为最大破坏动作)。**没有确定性判准,全凭 LLM 读 prompt 判。**

2. **时机 —— 何时出手、按什么节奏。** 在毫无标注的交互流里,如何廉价又准确地认出"用户正在沉淀一个可复用做法"的时刻,既不频繁打扰 / 烧钱、又不错过;周期治理在开关不定的 CLI 里,又按什么节奏触发才不漏不扰。
   - **〔hermes〕** 产生是**纯计数门槛**、不做信号识别:memory 复盘按 user-turn 数(默认 10),skill 复盘按本回合 tool 迭代数(默认 10,config `skills.creation_nudge_interval`),到阈值且**响应已交付**(`final_response and not interrupted`、不与用户争注意力)才 fork(`agent/conversation_loop.py:433-439, 4205-4228`)。治理**无常驻 cron daemon**:驱动点是 **CLI 每次会话启动查一次**(session-start hook,`cli.py:12333`,传 `idle_for_seconds=inf`)、gateway 则搭已有 cron ticker 按 poll 率轮询(`gateway/run.py:17955`,`tick_count % CURATOR_EVERY`);跑不跑由 `should_run_now` 内部 gate —— 判"距上次跑完 ≥ interval_hours"(默认 **7 天**)、且空闲 ≥ `min_idle_hours`(默认 2);首次安装先 seed、延后一整个 interval(`agent/curator.py:199-249`)。**是"距上次满 N"的跨时间长度;但 CLI 只在启动时查、会话运行期间不 tick 治理 —— 这与我们 scheduler 的进程内 TimerLoop(运行中也到点跑)不同。**

3. **信息 —— 判断凭什么、给多少。** 管家判"值不值得",需要看见这摊事是什么、库里已有什么、自己过去产的效果如何;给少了判不准、给多了烧钱又稀释信号 —— 决策所需的最小充分信息边界在哪。
   - **〔hermes〕** 产生时把**整个对话快照**(messages_snapshot)喂给 fork,fork 是完整 agent(max_iterations=16)、自己调 skills_list/skill_view 探索现有技能 —— **不预先精选、给全量再让它用工具查**;省钱靠**继承父进程已缓存的 system prompt** 命中 prefix cache(`agent/background_review.py:442`,注释实测省约 26%)。治理则喂 `_render_candidate_list`(每条自产技能的 state/pinned/use/view/patch/last_activity 一行,`agent/curator.py:1349`),fork 再自己 skill_view 看正文。

4. **边界 —— 自主的安全前提。** 自主写库必须只动自己产生的、碰不到用户 / 官方 / 接入的;来源如何界定、越权如何在能力层就不可能(而非仅靠判断不出错)—— 这是"敢放手"的底线。
   - **〔hermes〕** 两层。能力侧 `tools/skill_provenance.py` 一个 write-origin ContextVar,**只有 background_review fork 内的写** origin 才是 `"background_review"`,前台(CLI/gateway/cron/subagent 帮用户写的)一律 `"foreground"`;标记侧 `skill_usage.mark_agent_created` 仅在该 origin 的 create 时写 `created_by="agent"`,curator 只碰 `created_by=="agent"` 的(`list_agent_created_skill_names`)。双名单 off-limits:bundled(`.bundled_manifest`)+ hub(`.hub/lock.json`);**手写技能即便落在 skills 目录也不按位置推断为可治理**;`archive_skill` 再 double-check 兜底。**与我们 `stewardCreated` 同构。**

5. **反馈 —— 如何越用越准。** 产出之后,如何从用户行为(删 / 禁 / pin)和使用结果(命中与否)学习,让判准自我收紧,而不是陷在"产噪音 → 清掉 → 再产"、判断永不长进 —— 这是"进化"区别于"反复瞎忙"的关键。
   - **〔hermes〕** **hermes 没有"产出表现反哺产生判准"的闭环** —— review prompt 固定、每次独立、看不到自己历史产了什么、被否多少。它的"越用越准"走另一路:usage telemetry(`tools/skill_usage.py` sidecar:use/view/patch + last_activity)只喂**治理侧** —— 时间状态机(30 天 stale / 90 天 archive、又被用则 reactivate)和 curator 的候选列表;用户 pin 让 curator 跳过。**产生判断本身不自校准** —— 这正是我们 §五 反馈闭环多做的一环。

6. **可控 —— 自主运行不失控。** 后台多次触发、周期治理、甚至多终端并发下,如何不重复做、不并发打架、不误删;以及用户始终看得见管家做了什么、能随时否决并夺回控制 —— 自主不等于黑箱。
   - **〔hermes〕** 产生:每回合最多 spawn 一次(memory+skill 合一)、触发即计数清零、best-effort 不抛(`agent/conversation_loop.py:4222`)、daemon thread;**无"复盘进行中不再触发"的互斥**,靠 10 轮门槛把频次稀疏化。治理:`.curator_state` 的 last_run_at(`should_run_now` 门)+ `is_paused` + 先存状态再跑 LLM(崩溃不立即重触发)+ 跑前 `curator_backup` 快照。淘汰只 `archive`(可逆)、绝不物理删,pinned/bundled/hub 全跳过。跨进程:usage.json 用 **fcntl/msvcrt 文件锁**串行读改写(`tools/skill_usage.py:_usage_file_lock`,**正是我们缺的那道**);但 `.curator_state` 的判定非原子,多实例并发治理无强互斥(靠 7 天 + idle 稀释)。

> 以上六个是**需求 / 质量层**的问题;下面四个是调研 hermes 后补出的**实现机制层**核心问题 —— 不搞清同样做不好。

7. **产出形态与动作 —— 沉淀成什么、用什么改。** 一条窄技能还是带子文件的"伞形"技能?用哪些动作落地?怎么保证自动改写不破坏结构?形态定错,库要么碎成几百条一次性窄技能、要么改坏没人兜。
   - **〔hermes〕** 形态目标是 **class-level 伞形**:一个 SKILL.md(YAML frontmatter 必带 name+description)+ `references/ templates/ scripts/ assets/` 子目录放会话级细节(`tools/skill_manager_tool.py`)。落地是单一 `skill_manage` 工具六分支:create / edit(全量重写) / patch(fuzzy find-replace,默认改 SKILL.md、可指定子文件) / write_file / remove_file / delete。护栏:patch 后重校 frontmatter 不被破坏、尺寸上限(SKILL.md 10 万字符、子文件 1 MiB)、名字正则 + ≤64 字、原子写(temp + os.replace);写成功即清 skills 段 system prompt 缓存(`clear_skills_system_prompt_cache`)。

8. **执行载体与隔离 / 成本 —— 用什么跑、怎么不拖垮主流程。** 迭代 / 治理在什么进程、什么模型档上跑?怎么不碰主对话的 prompt cache、不烧钱、不失控?
   - **〔hermes〕** 产生与治理都 **fork 一个独立 AIAgent + daemon thread + stdout 重定向**,但分档:产生用**主模型**、`max_iterations=16`、继承父进程 cached system prompt 命中 prefix cache(省约 26%);治理用 **auxiliary 模型槽**(`auxiliary.curator.{provider,model}`,可单配更便宜模型,默认 auto = 主模型)、`max_iterations=9999`(治理是 50-100 次调用的大扫除)、`skip_memory`/`skip_context`(`agent/curator.py:_run_llm_review`)。两者都关递归 nudge(fork 内不再触发自己)、危险命令 auto-deny;产生侧再加工具白名单(只 memory/skills)。

9. **防退化安全网 —— 自己改自己怎么防越改越烂。** 自动改写一旦改错 / 误合并,怎么发现、怎么回退?
   - **〔hermes〕** 治理侧三层(`agent/curator_backup.py`):① 每次治理**前全量 tar.gz 快照**(含 `.usage.json`/`.archive`/`.curator_state` + cron-jobs.json,保留 5 份轮转);② `rollback` 可回滚到任一快照,且**回滚前先对当前态再快照**(回滚本身可撤销)、失败自动恢复;③ `dry-run` 预览只读不改、出 REPORT.md 让人审。产生侧:每个写动作内置 try / rollback(写坏即还原原文)。再叠加淘汰只 `archive`、不物理删(可逆)。

10. **度量采集点 —— use/view/patch 在哪记、准不准。** 使用度量从哪采集?是否真实反映"被用过"、会不会被管家自读污染?
    - **〔hermes〕** sidecar `.usage.json`(`tools/skill_usage.py`)记 use/view/patch 三类计数 + 各自 last_*_at,跨进程文件锁串行读改写。采集点:`bump_patch` 实证由 `skill_manage` 的 patch/edit/write_file/remove_file 触发;据函数注释 `bump_view` 由 `skill_view()`、`bump_use` 由"技能加载进 prompt / 被 assistant 引用"触发(确切调用点本轮工具读取延迟未逐一核到,以注释为一手依据)。**关键**:bundled/hub 技能从不记 telemetry,只有 `created_by=="agent"` 才进 curator 度量消费。
