# 两层上下文架构 (Two-Layer Context Architecture)

> **定位**:梳理知行上下文管理的两层结构——物理持久化层(历史对话落盘)与
> 注意力窗口层(管理给 LLM 的上下文)——各自的职责、触发、响应与边界,作为该子系统的单一参照。
>
> **范围约束**:本文聚焦两层的**架构梳理**(各层管什么、按什么触发、如何响应、边界如何划),
> 不展开与之无关的实现细节;概念的通用生命周期定义见 [lifecycle-concepts.md](lifecycle-concepts.md)。

---

## 信息梳理：

1、claudecode开启交互模式，无论之前有没有历史对话，有多少历史对话，进入交互模式后都是一个“空对话”，也就是没有开启上下文编排，因为没进入对话，在“空对话”发送第一个消息时自动创建新对话，这个时候上下文编排才开启。或者它在空对话里不发送，直接/resume切换到旧的历史对话，那上下文编排也开始了；

2、zhixing不同，是个人助手，不是纯粹的编程场景，而是覆盖这个工作场景，意味着用户进来永远有对话，所以zhixing是只要进入交互模式，没有历史对话就创建了一个并且上下文编排已经开始了；如果有历史对话，那就是拉起之前的历史对话，上下文编排也开始了。这一点和claudecode不同。

## 一、由来:上下文管理从一层到两层

最初只有**物理层**一层: 对话持久化文档内容也就是物理层直接全进llm输入，按尺寸阈值管理,物理层里的全部内容直接作为上下文喂给 LLM。

后来发现一个问题:一些小模型,聊天内容的尺寸远未触及其上下文边界,但输出效果已经非常差——
单凭物理尺寸不足以保证质量。

于是引入**第二层**,专门管理"给 LLM 的上下文窗口";它的阈值不取物理上限,而是依据不同模型的**优质上下文尺寸**来决定（优质注意力窗口）。

现状：在概念上，上下文管理出现了两层；

问题：

1、概念混乱，实际上物理层已经和 llm上下文不是一回事了，只负责持久化，但是还有着原来的那一套 看起来像是管理上下文的“比例阈值”还分级压缩，这是概念混乱

而且现在物理层 还依赖 一套 基于 不同模型的上下文最大尺寸去 管理的压缩阈值，实际上这和 物理层无关；持久化不需要关心 模型是谁；

> 本条所指"那套"= `context/budget.ts` 的 contextWindow 百分比三级阈值 + `message-drop`/`llm-summarize` 分级策略，在 `turn-end.ts` 中作为 ①budget-driven 与 ②segment 注意力切段**并列**装配，且与 segment 走同一个 `compactBefore` 出口物理删 transcript。它代码虽落在 `context/` 目录、却不代表属注意力层——按职责它就是本条说的"物理层遗留那套"。

2、边界混乱，注意力窗口实际上维护 给llm的上下文，但是 还掺杂着 物理层压缩方式（已端到端核实属实：注意力层切段产出的 marker 经共享的 compactBefore 落盘路径，会原子重写 transcript、物理删掉被摘的历史 run record），它应该只维护数据层，不该动物理层；

判断：这里需要从头梳理，重新理清边界，重新架构设计，持久化就只管持久化，不操心上下文的事儿；注意力窗口就只管数据层的事儿，不管物理层；

---

## 二、架构优化需求碎片

> 方向锚点（承上节判断 + 本次待落定的两条思路）：
>
> - **持久化**只管信息存储，有自己独立的尺寸与清理体系，与 LLM 输入 / 模型尺寸彻底无关；原先那套"看起来像上下文管理"的分级压缩，从持久化侧整体丢弃。
> - **上下文管理**采注意力窗口方案，完全独立；启动时从持久化取一次，之后自行维护"给 LLM 看多少、看什么"，不回头碰持久化。

### 已明确需求碎片

- **持久化职责清晰**：只存读**原始**对话信息，永不因上下文 / 模型尺寸删数据；读出来的就是原始内容，"渲染摘要、拼装窗口"等构建 LLM 视图的活归上下文层。倒读原语天然服务**两类消费者**——上下文层（按 token 预算装填给 LLM）与各端 UI 历史渲染（按条数渲染给用户、可分页续读）：同一倒读原语、不同预算单位，UI 渲染不得绕开持久层另立读取。配套产品缺口记录：现状 cli 启动 / 切换对话不渲染任何历史（只报"N 轮对话"），新架构落地后会变成"agent 全记得、用户面前空屏"的信息不对称反转——用户侧连续性（打开即见最近对话尾巴）与 agent 侧预填充是同一个"回到工位"的两半，落地时同期补上。
- **持久化独有维护体系**：把按 contextWindow 百分比的压缩 + compactBefore 截断从持久化整个拿掉（不再认识"压缩"）；改由持久化自带的独立体系防膨胀，维度只能是自身物理量（run 数 / 字节 / 时间 / 磁盘配额），不挂模型或上下文。生效维度已落定为时间窗（分片封笔时刻 + 27 天——封笔 = 后继片 createdAt，见下方「周期性持久化维护方案（确认）」）；字节 / run 数 / 磁盘配额等其余物理维度留作未来余地。
- **上下文管理模块**：依然采用注意力窗口，优质注意力上限、风险注意力上限的概念保留，这部分核心设计不动。
- **窗口运行态是一等内存状态（本次重构的第一承重墙）**：现状不存在独立的窗口——run 输入 = transcript canonical（commitTurn / compactAll 返回 canonical 整体回灌 `conv.messages`，每 run 同步一次，`repl.ts:1414`），窗口与 transcript 是焊死的。新架构窗口由上下文层持有、跨 run 留存，**且留存发送视图**（启动装填条目本就是窗口内容、随窗口存续——挂在现有"每 run 从 canonical 重建"的轨道上，重建会把它冲掉，这正是窗口运行态必须先立的原因）；所有「经 canonical 回灌窗口」的路径全部改道，run 后窗口自行追加本 run 产出、不再从持久化取回。**实施顺序锁死：窗口运行态先立，启动预填充订阅者才有轨道可挂**；窗口的具体 owner 与生命周期归属由 spec 落定（随注意力窗口生命周期存续，崩溃即弃、重启走启动倒读重建——这正是派生视图的代价与自由）。
- **取数单向且一次性**：上下文层启动时向持久化读一次，运行期不再为上下文决策回头要数据。本条约束的对象是**窗口的被动维护路径**——压缩 / 切段 / 装填等窗口自身决策永不隐性依赖持久化；**不约束**未来的检索召回（有用户 query 的显式主动读、工具化按需捞回、增量注入，见「为未来留口」）——两者不是同一条路，别拿本条堵死召回，召回落地之日本条也不作废。
- **写入触发分离**：持久化写应**只由"新对话内容产生"驱动**（run 完成即如实追加），与上下文层压不压缩无关。彻底拆开"压缩驱动写盘"这条现有耦合。落盘粒度**有意识沿用 run 级**（一个 run record 原子追加）：run 内崩溃丢整 run 是已知耐久边界、本次不改——原子记录正是 7M 边界判断与倒读简单性的来源；未来长时任务若需更细耐久粒度，以"run 内增量 append + 半成品记录修复语义"另立需求，不混进本次。
- **/clear 是事件、不是销毁**：现状 /clear 走 `compactAll` 原子重写、物理毁盘——根因正是窗口与 transcript 焊死（`session-commands.ts` 注释自证：只清内存会被下次 canonical 回灌让历史回流）。两层拆开后，若 /clear 只重置窗口而持久化保留，「启动必预填充」会在重启后把用户亲手清掉的历史原样灌回——背叛用户预期；若沿用毁盘，「永不删数据」就多了一个未声明的例外。按本文档自身原则推导，解是唯一的：持久化侧 **append 一条 clear 边界标记**（它本身就是"新对话内容产生"，与写入触发分离自洽），绝不重写、绝不删数据；**所有读路径以最近 clear 标记为硬边界**——启动倒读、摘要装填、各端 UI 历史渲染、未来检索召回都到此为止（用户语义是"忘掉"，对一切读取生效），预填充为空正是用户预期的"清空"；窗口侧照旧走注意力窗口换代（onWindowClose/onWindowOpen("clear")），clear 同时使更早的摘要快照退出「在用」状态（退役规则见「怎么读」架构设计·与 GC 协调）。clear 前数据物理仍在、超窗后由 27 天 GC 自然收走；`compactAll` 原子重写路径随之整体废弃。
- **多触发源**：cli / server / 未来其他平台应该与实现解耦，持久化机制和上下文管理是核心部分，与平台无关，能支持任意平台且行为一致。
- **为未来留口**：未来可在归档上做检索召回（把被摘掉的细节按需捞回；属显式主动读，与「取数单向且一次性」约束的被动维护路径正交）。本次只需不堵这条路，不实现它。
- **上下文状态要不要落盘** → 原文持久化分片是唯一真相源；上下文窗口状态本身不落盘。摘要快照可以作为派生缓存落盘（丢了可从原文重建、不得反向定义事实），不破坏单一真相源。重建保证以保留窗为界：超窗原文被 GC 真删后，其蒸馏价值仅存于在用快照（见「与 GC 协调」），快照若再丢，退化为"保留窗内纯倒读"冷启动——可接受的缓存降级（等同从没切过段的对话），不是正确性事故。
- **总方向坐实**：append-only 持久层作唯一真相源 + 上下文作可重建的派生视图、压缩绝不反噬归档——这是 Event Sourcing 的标准范式，主流 agent 正收敛于此。
- **清理的形态与"完整"的强度** → 真删除 + 不需要垃圾桶，不需要找回 + 冷存（27 天时间窗）。**敢真删的前提**：transcript 是情景缓冲、不是长期记忆——持久价值在运行期已由蒸馏路径外溢（memory flush 进记忆库、structuredSummary 滚动摘要），删除的安全垫是"蒸馏物存续"；未来任何削弱记忆 / 摘要侧的改动，须连带重审本条删除强度。
- **怎么读**：
  1、注意读的时机：是用户进入交互模式后启动上下文编排时读取持久化内容，只读一次；后面压缩都和这个没关系了；
  2、拿到的内容作为**注意力窗口的起始条目**进入首个 run 的发送视图（system-meta 对，沿运行期压缩摘要对的既有模式），紧贴当前 user message **之前**——不注入物理持久化里的历史首条、也不改写用户消息本身；用户消息原文直达落盘，"只存原始输入"由结构保证、无需任何剥离逻辑；
  3、按照尾部按 token 预算倒读，填到注意力窗口 optimal 即止；这个窗口初次拿取尺寸边界已在下方「怎么读」架构设计（确认）落定：启动额度 = 「优质上限 × 1/4」与「24K」两个基准取较小者，再保「最近一组对话 + 一条摘要」的连贯底线
  4、现阶段 从持久化中拿7组对话（注：「7 组」已被下方灵感池修正为结果而非输入——以 token 预算 optimal 为主导、7 组降为经验初值 / 下限参考，组数是装填的结果），一组对话为“一个用户消息 + llm调用多次”；

  - 说明：这是上下文维护模块，是注意力窗口启动时的读取，这时候 用户还没发消息呢，所以检索没意义，都没用户消息怎么检索。
- **持久化体系** ：
  1、 我们本身是分对话的；对于一个对话来说，不可能让它的持久化文档无限膨胀，所以需要分片
  2、 一个文档的 尺寸上限是 7M，如果 一组对话（一个 run record：一个用户消息 + LLM 多轮调用）正好卡到了7m边界但是还在继续的话，这一组的都持久化到这个文档；下一组对话在新的文档中持久化；也就是说7m是判断时机，所以还需要维护一个当前正活跃的 持久化文档的 索引对吧，这样才知道往哪个文件存，超过7m且是新组对话就开新的文档，然后更新索引继续；
  3、活跃文档的定义：一个对话对应只有一个文档是当前正在写的，这个活跃状态 和 用不用没关系，而是 如果这个对话在发生， 持久化写入的话就往这个文档写，那它就是活跃的，而且每个对话至少有一个文档
  3、每一个文档都有一个创建时间，核查的时候（先别管什么时候核查，谁核查），发现文档创建时间距离 现在超过27天丢掉，说一个边界情况，只有一个文档（只有一个它必然是活跃文档）时，即使超过27天了，也不删；永远不删活跃文档；
  4、多个对话并行运行时可能存在的，意味着 多个对话活跃，就有着多个 活跃文档；活跃文档是动态的，只要超过 7m，下一组对话就进入新文档，活跃文档也就是新文档；
  


  待落定的两件事（✅ 均已完成，成品见下方对应「确认 / 调研」节；编号保留，供确认节标题「对应上方第 1/2 点」引用）：
  1、周期性持久化维护方案 —— 调度器模块已实现完，基于它设计维护方案。✅ 已落定，见下方「周期性持久化维护方案（确认 · 对应上方第 1 点）」；含什么周期 / 怎么处理 / 谁来处理，以及「要不要加 ai」（已定：不加）。
  2、怎么读的第三点（到底拿多少、拿什么）—— 已先调研最新论文方向与前沿成果作前置，再行架构设计。✅ 已落定，见下方「怎么读」设计灵感池（调研）+「怎么读」架构设计（确认 · 对应上方第 2 点）。





### 周期性持久化维护方案（确认 · 对应上方第 1 点）

定性：纯物理层 GC——只看索引元数据（分片封笔时刻 + 是否活跃、快照自身 `createdAt`），不碰语义、不认识模型；对调度器是纯增量复用、不改其内核。

**职责分层（最关键）**：清理算法属持久层「自带的独立维护体系」（承上「已明确需求碎片」），内聚分片枚举、封笔时刻判定、三条铁律、真删——只有持久层懂「活跃文档」语义；持久层对外暴露一个 `runRetentionSweep(retentionDays)` 能力。调度器的 system handler 只是极薄的**触发壳**：到点调用该能力、把返回转成 `{status, summary}`，自身不含任何清理逻辑。绝不可把算法写进 handler / 调度层（否则持久层维护逻辑泄漏到调度层，正是本部分要消灭的耦合）。此分层让未来同类维护（需求 2 的 skill 淘汰）复用同一干净模式：该模块暴露自己的 sweep + 注册一个薄壳，调度内核零改。

- **谁处理**：落成调度器一个 system task（固定 id `__transcript-gc`、`system:true`、`action:"system"`，走现成 `systemHandlers` 通道）。核心宿主单一 Scheduler 调度，daemon 装配后 `ensureSystemTask` seed-if-absent 落地运行态；handler（薄触发壳）只调持久层 `runRetentionSweep`；结果经 `isInternal` 拦在用户视图 / 投递 / 事件之外，只进 `lastSummary` 供运维——用户无感。
- **什么周期**：天级，cron 每天一次（判据是天级时间窗，更频繁是无谓唤醒、更稀疏清理滞后）。系统任务幂等、容忍延迟、错过即补跑一次（价值在最终被执行，具体时刻不重要）。两条腿驱动：宿主在跑即到点触发；按需起落错过则靠 cli 启动「维护逾期 → ensure」拉起宿主后当场补跑一次（"无 task 行 = 逾期" 正好覆盖纯聊天用户——不碰调度但照样产 transcript）。语义是「每天尽力清一次」、非雷打不动。
  - 依赖前提（继承自调度器决策 5、非本方案缺陷，记此防丢）：防饿死靠 cli 启动检查，「用户长开 cli、纯聊天、连续多天不重启」是该触发的已知盲区。
- **怎么处理**（即 `runRetentionSweep` 内部算法，住持久层）：枚举本 home 所有对话 → 读各对话分片索引 → 对每片按**封笔时刻**判：非活跃且封笔超 `retentionDays`（默认 27）→ 真删整片（**不写索引**）。封笔时刻 = 后继分片的 `createdAt`（rollover 登记新片的时刻即本片停止写入的上界，索引里天然记录、零新增元数据）——rollover 按大小触发、片龄 ≠ 数据龄，一片可能跨数月仍在写，只有封笔也出窗、片内一切数据才真正超期（保留窗承诺以数据时刻为准）。三条铁律：永不删活跃文档；对话只剩一个文档（必然活跃）即使超期也不删；真删、不入垃圾桶。同一轮顺带清理**摘要快照**（持久层派生缓存）：按快照自身 `createdAt` 走同一时间窗判，当前在用（最新）快照视同活跃永不删（「在用」以最近 clear 标记为界，clear 前快照已退役）——快照是蒸馏物、不随其覆盖的原文失效（详见下方「怎么读」架构设计·与 GC 协调）。健壮性：单对话失败仅跳过 + warn、不拖垮整轮；幂等；只 stat 元数据、绝不打开分片正文。
- **要不要加 AI**：不加。清理是 100% 确定性规则（超期 + 非活跃 → 删）、无判断空间；删除不可逆，交概率模型是纯风险；且会把这次重构刚砍掉的「模型 ↔ 持久化」耦合焊回去。AI 的位置留给未来 read 侧的检索召回（「该捞回哪段历史」才是有事实有工具的语义判断），与清理 write 侧正交、互不污染。
- **语义边界（与 Event Sourcing 唯一真相源的协调）**：保留窗（27 天）内的归档才是「唯一真相源 + 可检索召回」；GC 真删意味着**放弃**窗外数据的真相源地位与召回可能。未来检索召回的范围 = 保留窗内，不得假设能捞回全部历史。
- **对持久层的反向约束**：① 分片索引须显式记录每片 `{createdAt, isActive}`，`createdAt` 取索引记录值、不依赖文件系统时间戳（Windows birthtime 不可靠、跨平台不一致），GC 判据才稳；同理，最近一次 clear 的时刻须由 owner 落在索引 / 对话元数据（快照退役判定 = `snapshot.createdAt < lastClearAt`，sweep 仍只读元数据、不开分片正文找标记）；② 须能枚举本 home 下所有对话（sweep 遍历的前提；目标态 ConversationRepository 的 list 能力即可）；③ **索引由写入 owner 维护，GC 对索引只读、对分片只删，绝不写索引**——owner 指当前负责该对话写入的 TranscriptStore / 后续持久层写入路径：init 建首片并写索引；run record append 时判断活跃片是否超过 7M；需要 rollover 时把旧活跃片置 inactive、新建活跃片并更新索引。GC 只读索引判出超期非活跃分片 → 直接删这些分片文件、全程不碰索引写；这样从根上消除跨进程并发写索引的冲突，而非给它加锁。根因：GC 在核心宿主进程、cli 写仍在 cli 进程（本模块不迁 cli 对话 / 调度器决策 1），进程内 ADR-TR-8 锁跨不了进程；若 GC 也写索引，整文件原子重写 last-write-wins 会让 cli 刚写的新分片从索引消失或留悬空引用（正确性事故）。索引写于是只剩 owner 写路径，进程内 per-conversation 锁即足够，无需任何跨进程锁。删后索引里短暂的死记录（指向已删分片）由两件轻事化解：读取容错（倒读遇索引指向但已不存在的分片 → 跳过，本就该有的鲁棒性）+ owner 加载 / 写入该对话时惰性剔除死记录（可选，死记录仅占几字节、无害）。残留的「GC 删文件 vs 另一进程读老分片」冲突被幂等吸收：Windows 删被占用文件失败即跳过、下轮再来，POSIX 靠 inode 语义本就安全。原则：消除共享可变写优于锁住它，且省掉一个随 unified-core 单写者到来终将退化的跨进程锁承重件。




### 「怎么读」设计灵感池（调研 · 对应上方第 2 点）

> 发散素材，供接下来架构设计取用，**非定稿**。问题锚定：注意力窗口在启动那刻从持久化倒读做预填充，此刻无用户 query → 纯 recency 冷启动装填，要定「拿多少」与「拿什么」。

**拿多少：**

- **optimal 是天花板、不是 KPI**：Context Rot（Chroma 2025，18 个前沿模型实测）证明 token 越多质量越降、且远未满就开始——200K 窗口可在 50K 就显著降质，100K–500K 最陡，曲线非线性非均匀。Anthropic「Effective Context Engineering」把上下文定义为「稀缺、边际效益递减的资源」，目标是「最小高信号 token 集」；LongMemEval 实测 focused(~300 词) 远胜 full(~113k 词)。→ 启动装填的目标应是「最小高信号集」，optimal 只是护栏上限，别为填满而填。
- **optimal 取标称 ~50% 有实证背书**：有效上下文利用率普遍落在标称的 50–65%，且模型相关（小模型更低）——正好契合知行「按各模型优质窗口定阈值」，并加强「设计依据」已有的「有效上下文 ≈ 标称 50–75%」。
- **位置效应（lost in the middle，U 形）**：首尾强、中间弱，开头准确性最高。→ 装填顺序要让高信号落在首尾、别埋中间。

**拿什么：**

- **分层装填（可选）**：MemGPT/Letta（虚拟内存分页）、tiered hot/warm/cold——近期给原始 run record（hot）、更早给摘要锚（warm），而非单一粒度。
- **摘要锚 / 结构化笔记注入（可选）**：Anthropic「结构化笔记 + compaction」——重启后靠一份高信号会话摘要 / 笔记快速恢复状态，而非只靠倒读原始 run record 拼。这正是 Event Sourcing「派生视图」可包含的摘要层。
- **无 query 下的信号维度**：Generative Agents 的 retrieval = recency × importance × relevance；启动无 query → relevance 用不上（碎片判断正确），recency 是唯一强信号（契合倒读），importance 可选叠加（需打分成本）。

**两点要落到设计里的修正：**

- **「7 组」应是结果而非输入**：前沿无统一固定 run 数（取决于应用 + 预算）；知行应以 token 预算（optimal）为主导，「7 组」作经验初值 / 下限参考，组数是装填的结果。
- **JIT / 检索召回是未来**：Anthropic just-in-time（维持轻量标识符、运行时按需捞）是另一范式；知行「启动一次倒读、不回头」在无 query 下是合理简化，JIT 思想留给「为未来留口」的检索召回。

> 关键来源：Chroma《Context Rot》、Anthropic《Effective Context Engineering for AI Agents》、《Lost in the Middle》(arxiv 2307.03172)、MemGPT/Letta、Mem0(arxiv 2504.19413)、A-Mem、Zep、Generative Agents(arxiv 2304.03442)、《Memory in the Age of AI Agents: A Survey》(2025-12)。




### 「怎么读」架构设计（确认 · 对应上方第 2 点）

定性：启动那刻还没有用户提问（纯靠「最近」来取）——用最小高信号让 LLM 恢复连贯，把模型**优质上限**（该模型能稳定保持高质量输出的 token 上限）的大部分**留白**给接下来的实际对话。注意力是稀缺资源：启动是「少而精 + 留白」，绝不一上来把优质上限塞满历史（那样塞进一窗口低信号、又把更早的高信号挤出去，双输）。

> 优质上限是每个模型一个**具体 token 数**（内置默认表 + 用户可覆盖 + 未知模型兜底 64K，见 `model-capability.ts`），**不是标称窗口的固定百分比**（如 deepseek-v4-pro 标称 1M、优质上限 128K；flash 标称 1M、优质上限 32K）。下文一律用这个具体值，不再乘 50%。

**1. 启动额度 = 两个基准取小，再保连贯底线：**

- 两个基准**同时生效、取较小者**：① 优质上限 × 1/4（留 3/4 给运行）；② 24K（防优质上限很大的模型一次灌入过多旧历史反伤注意力）。两者都是「不超过」，谁小听谁——小模型多半 1/4 更小，大模型 24K 更小。
- **连贯底线**：无论上面算出多少，必须保证至少装得下「最近一组对话 + 一条摘要」；算出的额度不够这条底线时（极小模型），以连贯底线为准。

**2. 额度内怎么分 = 摘要先放、字数封顶，其余全给最近原文：**

- **摘要先放、总量封顶几百字**：更早历史的摘要小而精（够唤起「之前在干啥 / 什么状态 / 什么决策」即可），封顶几百字、**不按固定比例**（摘要往往用不到额度的零头，固定比例会浪费）。现成 `structuredSummary` 本就小而精、正常用不满此上限；万一超出，启动侧截 active 尾部、保 facts / state（核心连贯不动，细节留给未来检索召回），不现场重摘。
- **其余全给最近原文**：启动额度减去摘要，剩下**全部**装最近对话原文；用户 / 助手自然语言内容保持原文，工具调用与工具结果按可读文本渲染，不伪装成协议 role message。
- **摘要来源**：复用运行期段切换本就生成的 `structuredSummary`（facts / state / active 三段），缓存为派生快照、启动直接读、**不现场重新摘要**（故启动轻）。快照可落盘、是派生缓存、丢了能从原文重建，不破坏「原文是唯一真相源」。

**3. 顺序 + 没有摘要时的兜底：**

- **顺序**：摘要放前面、最近原文贴最后（挨着用户即将说的话）。模型对开头结尾记得牢、中间易忽略，把最该看见的放两头。
- **没有现成摘要时**：若历史里没有段摘要（对话从没切过段 / 无快照），摘要层为空——启动额度**全部给最近原文**，绝不为了凑摘要而现场生成（短对话本就不需要摘要，最近原文已覆盖全部历史）。

**连贯底线（不可破）**：最近一组对话要完整放进去；若某组特别大（工具吐了几万字、一组就超过整个优质上限），改放该组的**压缩核**（开头意图 + 结尾结论 + 最后两轮原话），而非硬塞整组。

**与 GC 协调（修正：快照不随原文失效）**：「超窗真删不找回」约束的对象是**原文细节**，不是蒸馏物。摘要快照是滚动蒸馏（structuredSummary 递归覆盖全部更早历史），恰是上方「敢真删的前提」里那块安全垫——若按"覆盖范围超窗即同步失效"执行，任何活过 27 天的对话启动连贯性即断、蒸馏价值随原文陪葬，删除反而不再安全。故快照按**自身 createdAt** 走同一 27 天时间窗老化：当前在用（最新）快照视同活跃文档永不删，被换代的旧快照超窗即删。「在用」以最近 clear 标记为界：clear 使更早的全部快照**即刻退役**（转入被换代行列、按自身 createdAt 同窗老化收走）——否则 clear 前的末代快照会被"在用"规则永久保护、却被 clear 读边界永久跳过，沦为永生的死数据。执行归属：快照是持久层派生缓存文件，由同一 `runRetentionSweep` 顺带清理（同一把刀、同一规则，不另立第二套清理）。不变式照守：快照只作连贯性唤起、不得反向重建原文（"不得反向定义事实"）。

**未来留口（不堵不预建）**：① 检索召回——有用户提问时在保留窗历史里按需捞回原文细节，增量加在摘要之外；② 重要性打分——摘要从纯「最近」升级为按重要性挑；③ 多端统一核心——多端共享同一份原文 + 快照、视图可重建。

> 工程取值待校准：1/4、24K、摘要几百字上限都是工程初值，落地挂真实负载校准、不一次定死；摘要只取严格早于最近原文覆盖范围的段，防与原文重叠矛盾。
>
> 本质：启动像人早上回工位——不重读昨天每句话，瞄一眼笔记（摘要）+ 记得刚才在干啥（最近原话），就秒回状态。







设计依据：
1、单个对话分片放多大结论很集中:MB 级,不是 GB 级;推荐单分片上限 ~10MB(合理区间 4–16MB),个位数 MB 最稳
2、有效上下文 ≈ 标称的 50–75%,知行据此把各模型优质上限实测固化为 `model-capability.ts` 绝对值、启动直接用该值不再乘百分比
3、logrotate count=0 到期即删不留旧档；Kafka 7 天 / 单段 1GB；Claude Code 30 天

---

## 三、可执行架构设计

> **定位**：把 §二 已定稿的需求碎片落成可直接实施的目标形态与实施序列。每个设计点回指其约束来源（§二 碎片 / 一手代码事实），不重复论证。
>
> **术语对齐**：现有代码的 `Turn` 类型（`transcript/types.ts:33`，userMessage + 最终 assistantMessage + 扁平 toolCalls）按 [lifecycle-concepts.md](lifecycle-concepts.md) 的概念实为 **run record**（一个用户消息 + LLM 多轮调用的完整往返）——命名与形态都是历史债。本节按目标语义统一称 run record；目标类型 `RunRecord` 以完整协议 `messages` 为唯一权威字段（3.1.2，旧三字段降为读侧派生），`turnIndex`→`runIndex` 等重命名随实施落地，不另立兼容层。

### 3.0 模型总览：两层三触点

```
  上下文层（内存 · 派生可重建）          持久化层（磁盘 · 唯一真相源）
 ┌──────────────────────────┐          ┌──────────────────────────────┐
 │ AttentionWindowState     │ ←─触点A── │ readRunsReverse + 快照读      │  启动装填，一次
 │ （窗口运行态，owner=会话层）│          │                              │
 │        │                 │          │ <conv>/transcript/index.json │
 │   inputMessages 构造      │ ──触点B─→ │ <conv>/transcript/NNNNNN.jsonl│  run 完成追加
 │        ↓                 │          │ <conv>/snapshots/<ts>.json   │
 │ agent-loop（run 瞬态）     │ ──触点C─→ │ 快照文件（派生缓存，可丢）      │  段切换后派生
 └──────────────────────────┘          └──────────────────────────────┘
```

两层只在三个触点相遇：**A** 启动装填读一次（被动维护路径仅此一读）；**B** run 完成后 owner 追加原始 run record（含 clear 事件追加）；**C** 段切换摘要落为派生快照。除此之外互不感知：持久化不认识模型与窗口，窗口运行期不回头读写持久化。

**owner 定义**（贯穿本节）：窗口与持久化的协调者是**会话层**——cli REPL 的 conv 状态（`repl.ts` state.conv）、server 的 `ConversationManager`/SessionRuntime。`AttentionWindowState` 的类型与逻辑住 `@zhixing/core` 的 context 模块（§二「多触发源」：核心部分平台无关）；实例由会话层持有。窗口与持久化的耦合面收敛在三个触点上，owner 可整体搬迁宿主而不动两层本体。

### 3.1 持久化层

#### 3.1.1 目录与文件形态

```
<conversationsDir(scope)>/<conversationId>/
  meta.json                      # 现状不动：ConversationRepository 管身份/segmentMetadata/viewLayerState
  transcript/
    index.json                   # 分片索引，owner 唯一写者
    000001.jsonl                 # 分片：header + run/clear 记录，append-only
    000002.jsonl
  snapshots/
    <createdAt-ISO-safe>.json    # 每快照一个文件 —— sweep 只删整文件、永不重写（与分片同纪律）
```

旧 `<conversationId>/transcript.jsonl` 单文件格式**直接退场**：项目未发布、无存量兼容义务——不迁移、不读取、不删除（开发机存量由开发者自行清理），新 store 只认 `transcript/` 目录,无任何 legacy 读写路径。

#### 3.1.2 Schema

```ts
// transcript/index.json —— owner 唯一写者，整文件原子重写（tmp+rename）
interface TranscriptIndex {
  version: 1;
  conversationId: string;
  activeShardId: string;                  // 恰指向一个 isActive:true 的分片
  lastClearAt?: string;                   // 最近 clear 事件时刻（§二 反向约束①：快照退役判据，sweep 只读元数据）
  shards: Array<{
    id: string;                           // "000001"
    file: string;                         // 相对 transcript/ 路径
    createdAt: string;                    // ISO，取索引记录值、不依赖文件系统时间戳（§二 反向约束①）
    isActive: boolean;
  }>;
}

// 分片记录（JSONL，每行一条）
type ShardRecord = ShardHeader | RunRecord | ClearRecord;

interface ShardHeader {                   // 每分片首行。现 TranscriptHeader 的 model/provider/name
  type: "header"; version: 1;             // 不再入 header——全仓核实仅测试消费、无生产读者;
  conversationId: string; shardId: string; createdAt: string;   // 身份信息单一归属 meta.json
}
interface RunRecord {                     // 一个 run 的完整协议消息序列 —— 唯一权威内容字段
  type: "run"; runIndex: number; timestamp: string;
  messages: Message[];                    // [用户原文 user, ...本 run 全部 assistant 与 tool_result 消息]
  usage?: TokenUsage; source?: TurnSource;
}
interface ClearRecord {                   // §二「/clear 是事件、不是销毁」
  type: "clear"; timestamp: string;
}
```

**`messages` 是唯一权威、零冗余**：现 `Turn` 的 `userMessage / assistantMessage / toolCalls` 三字段全是 `messages` 的投影，**不落盘**——读侧纯函数派生（`userOf = messages[0]`；`finalAssistantOf = 末条 assistant`，**无 assistant 时返回空 assistant**（`content=[]`，沿现 buildTurn 的 EMPTY_ASSISTANT 语义）——兜底收敛在读侧单点，记录本身不伪造消息，abort / 错误路径下 `messages` 可合法地只含 `[user 原文]`；`deriveToolCalls` 即现 `extractToolCalls` 原样复用），全仓核实持久化 `toolCalls` 零生产读者（仅测试）。可构造性有一手依据：`buildTurn` 的输入本就是 `[userMessage, ...newMessages]`，而 `newMessages` 的契约（`turn-builder.ts:47`）正是 `[assistant, toolResult_user?, assistant?, ...]` 完整协议增量——run 末组装全序列零新机制；turn-context 等注入是输入侧变换、不在输出侧 yield 重建中，序列天然干净。完整协议保真（工具轮结构 / 顺序 / 交错）直接服务未来检索召回与 UI 渲染；记录变大由 7M rollover + 27 天 GC 天然吸收；项目未发布，此 schema 无迁移成本。不变量：`messages[0]` 恒为用户原文、全序列不含任何注入。

分片内**禁止**出现：`CompactMarker`、summaryPair、任何窗口派生状态（§二「持久化职责清晰」）。`runIndex` 对话内单调递增、跨分片连续；**唯一 assigner 是 store**——append 时分配 `nextRunIndex` 并随返回值带出，调用方传入的 `turnIndex` 仅作诊断、不进盘。owner 打开对话时从活跃分片尾行推导 `nextRunIndex`（活跃片空则看前一片；都无则 0），**不**存进 index——append 快路径不重写 index。

快照文件（触点 C 的产物，每快照独立文件）：

```ts
interface SegmentSnapshotFile {
  version: 1; conversationId: string;
  createdAt: string;                      // 退役/老化判据（§二 与 GC 协调：按自身 createdAt）
  coveredThroughRunIndex: number;         // 摘要覆盖的最后一个完整 run —— 启动装填防重叠锚点
  structuredSummary: { facts: string; state: string; active: string };   // 现 ParsedSummary 三段原样
  tokensBefore: number; tokensAfter: number;
}
```

#### 3.1.3 写入算法与崩溃恢复

`appendRunRecord(conversationId, record)`（owner 经它写，per-conversation 进程内锁，沿 ADR-TR-8 模式）：

1. 取锁 → 读 index（无则 init：建索引 + 首片条目,分片文件惰性创建）。
2. **rollover 判断**（§二：7M 是判断时机）：`stat(活跃分片).size ≥ 7M` 且本条是新 run → 先 rollover：原子重写 index（旧活跃 `isActive:false`，登记新分片条目为 active，`createdAt` 取当前时刻）。**index 先行、分片文件惰性创建**——新分片文件在首次 append 时才写入（header + record 一次写）；读路径容忍"index 指向的分片文件尚不存在"= 空分片。
3. append 记录到活跃分片（单行 JSONL append，不重写既有内容）。
4. 释放锁。返回 `{ runIndex, shardId }`，**不返回 messages**——持久化不再构造任何 LLM 视图（根除 canonical 回灌，§二 第一承重墙）。

`appendClear(conversationId)`：同锁内两步——append `ClearRecord` 到活跃分片 + 原子重写 index 的 `lastClearAt`。读边界以**分片内 ClearRecord** 为权威（倒读遇之即止）；`lastClearAt` 是给 sweep 退役判据的元数据投影，短暂不一致无害（sweep 是最终一致的清理）。

崩溃恢复全枚举：

- **rollover 后、首次 append 前崩溃**：index 已指向不存在的分片文件 → 读容错视为空分片，下次 append 补建。无修复动作。
- **append 单行被截断**（进程崩在写中）：JSONL 尾行解析失败 → 读路径丢弃坏尾行（该 run 视为未持久化，与"run 级粒度、崩溃丢整 run"碎片一致）；owner 推导 `nextRunIndex` 时同样跳过坏尾行。
- **index 原子重写本身**：写 tmp → 替换。POSIX `rename` 原子覆盖；Windows 走 unlink → rename，存在"旧已删、新未就位"的崩溃微窗口——但窗口内形态确定（unlink 只发生在 tmp 完整落盘后，故"目标缺失 + tmp 存在"时 tmp 必完整），owner 打开时先收尾 tmp（最新 tmp rename 回目标、其余清理），原子替换的承诺跨崩溃成立。
- **索引缺失 / 损坏（兜底不变量）**：索引只是分片的派生投影——读（倒读原语）写（owner 打开）两路径共用同一自愈核：索引读不出时扫描目录现存分片全量重建（shards 序号升序、`createdAt` 取分片 header 记录值、active = 最大序号、`lastClearAt` 倒扫分片内 ClearRecord），重建即落盘；目录真空才视为新会话（且只有写路径会新建——读不存在的对话零副作用）。**分片文件在，会话就在**：任何索引层事故都不会把已有会话误判为新会话（误判会让旧分片失联、rollover 撞号互写）。
- **clear 两步写之间崩溃**（ClearRecord 已落分片、`lastClearAt` 未更新）：读边界不受影响（以分片内 ClearRecord 为权威），受损的只是快照退役判据滞后——若不修，clear 前的最新快照会被"在用豁免"永久保护、又被读边界永久跳过。修复：owner 下次打开推导 `nextRunIndex` 读活跃分片尾行时顺带校核——**尾行是 ClearRecord 且时刻 > `index.lastClearAt` → 补写 index**（owner 写索引合法；崩溃窗口内不可能发生 rollover，ClearRecord 必在活跃分片尾行，只查尾行即完备、零额外扫描）；修复先于任何新写入，一次 open 收敛。

#### 3.1.4 倒读原语（双读端，§二「持久化职责清晰」）

```ts
interface TranscriptReader {
  // 从活跃分片尾部（或 before 游标处）向前逐条产出 run record，跨分片续读，遇 ClearRecord 即终止。
  readRunsReverse(
    conversationId: string,
    opts?: { before?: { shardId: string; runIndex: number } },  // 无状态分页游标：传上一页最早一条的 ref，从它之前继续
  ): AsyncIterable<{ record: RunRecord; shardId: string }>;
  // 自最近 ClearRecord 以来的 run 数——计数也是读路径,同守 clear 边界
  //（清空后对话列表显示 0 轮,与现状 compactAll 归零的 UX 一致）。
  countRuns(conversationId: string): Promise<number>;
}
```

唯一倒读实现，两类消费者各自决定停止条件：上下文层启动装填按 **token 预算**停（3.2.2，不传 `before`）；各端 UI 历史渲染按**条数**停、下一页以上页最早 ref 作 `before` 游标续读更早——游标无状态，RPC 投影的远端 UI 与未来检索召回同用此口、不另开读法。实现按分片整文件读入再反向迭代（≤7M 有界）。clear 边界在原语层生效——任何消费者都不可能读穿 clear（§二：对一切读取生效）。

#### 3.1.5 GC（§二「周期性持久化维护方案」的落地形态）

`runRetentionSweep({ retentionDays = 27, now })`（住持久层，对外暴露）：

1. 枚举本 home 全部对话——遍历所有 scope（main + 各 workscene）的 `conversationsDir`。
2. 对每对话读 index：删 `!isActive && 封笔超期` 的分片文件，封笔时刻 = 后继片 `createdAt`（rollover 按大小触发、片龄 ≠ 数据龄，以数据时刻守保留窗；无后继的非活跃片是异常态，保守不删）（**只删文件、不写 index**；删失败/被占用即跳过，下轮再来）。三条铁律照守：永不删活跃分片；对话仅剩一片（必活跃）不删；真删不入垃圾桶。
3. 同轮清快照目录，单一判据：**删 iff `createdAt 超期 && !(是最新快照 && createdAt > lastClearAt)`**——clear 退役（`createdAt < lastClearAt`）只摘掉"在用豁免"、不提前删，老化一律按自身 `createdAt` 同窗判（§二「与 GC 协调」定稿语义：退役转入被换代行列、同窗老化收走）；最新且未退役的快照视同活跃永不删。每快照一文件 → sweep 只有"删整文件"一种动作，与 owner 的"写新文件"天然无共享可变写。
4. 单对话失败 warn + 跳过；幂等；分片只 stat 不开正文。返回 `{conversationsScanned, shardsDeleted, snapshotsDeleted, warnings}` 摘要（warnings 为单点跳过原因的文本聚合，薄壳计数进 lastSummary）。

调度接入（纯增量，零改内核）：daemon 装配 `ensureSystemTask({ id: "__transcript-gc", system: true, cron: 天级 })` + `systemHandlers` 注册薄壳（只调 sweep、转 `{status, summary}`，沿 `__journal-gc` 同款模式）；结果经 `isInternal` 拦在用户视图外；错过补跑由调度器 missed 分流（internal 补跑一次）+ cli 启动「维护逾期 → ensure」两条腿覆盖——均已落地，本模块只管注册。

#### 3.1.6 无迁移（项目未发布）

旧单文件 `transcript.jsonl` 无存量兼容义务：不迁移、不读取、不删除（开发机存量自行清理）。新 store 全新起步——无 legacy reader、无格式判别分支、无迁移崩溃面。`CompactMarker` 类型随旧 store 一并删除,全仓不再存在该概念。

### 3.2 上下文层

#### 3.2.1 AttentionWindowState（第一承重墙的本体）

```ts
// 建窗：owner 在 orchestration 启动时构造，bootstrap 为启动装填对（3.2.2，可 null）
createAttentionWindow(opts: { conversationId?: string; bootstrap?: [Message, Message] }): AttentionWindowState;

interface AttentionWindowState {
  readonly conversationId?: string;
  getMessages(): readonly Message[];            // 已接受的窗口事实（不含 in-flight 用户消息）
  acceptRun(input: {
    runMessages: readonly Message[];            // 本 run 协议消息序列（首条=用户原文）。窗口内部派生蒸馏对
                                                // [首条, 末条 assistant]——收消息序列而非 RunRecord 整体,
                                                // 是为了窗口模块零依赖 transcript 类型(上下文层概念,存储无关);
                                                // owner 喂 record.messages 即可,仍不拆字段
    runIndex?: number;                          // persistent=持久化返回值（accept 先持久化后窗口,调用时必已可得）;
                                                // ephemeral=pending 队列序号——promote 按 FIFO flush 到全新 transcript,
                                                // store 顺序分配必然一致(promote 对账,不一致以 store 为准修正并 warn),
                                                // 故 persistent 化后窗口配对恒有 runIndex、段切换快照不缺锚
    windowCompact?: WindowCompact;              // 段切换/手动 compact 的窗口重构指令（3.2.3）
  }): { coveredThroughRunIndex?: number };      // 应用了 windowCompact 且被折配对带 runIndex 时非空——owner 据此写快照（3.2.3）;
                                                // ephemeral 会话即使非空,owner 也不写快照（不变量 9）
  applyCompact(                                 // run 外重构入口（手动 /compact,3.2.3）——与 acceptRun
    windowCompact: WindowCompact,               // 共用同一折叠实现与元数据交出,owner 不触窗口内部结构
  ): { coveredThroughRunIndex?: number };
  reset(reason: "clear" | "switch"): void;      // 清空窗口（/clear、切换对话）——含 bootstrap 条目
}
```

**窗口事实的形态 = 蒸馏对**。`acceptRun` 先应用 `windowCompact`（若有：摘要对 `buildCompactSummaryPair(summary)` 置首并**取代其前全部条目**——含 bootstrap 条目与旧摘要对，单 frontier 语义、与今天 marker 覆盖前 marker 一致——再截掉被摘的前 N 个 run 配对，与 `applyCompactBeforeInLock` 同算法，目标从磁盘文件改为内存窗口），再追加从 `runMessages` 派生的配对 `[首条, 末条 assistant]`——无 assistant 的中断 / 错误 run 派生空 assistant 成对入窗（3.1.2 兜底），与 REPL"完成与中断都接受"的现状语义一致，acceptRun 对任何被接受的 run 都能稳定派生。**窗口条目带元数据**：内部存 `{kind:"bootstrap"} | {kind:"summary"} | {kind:"pair", runIndex?}`（对外 `getMessages()` 仍展平为 `Message[]`）；`pairsCompacted` 只计 pair 条目；runIndex 在 accept 时随持久化返回值记录，是 3.2.3 快照 `coveredThroughRunIndex` 的数据源——折叠时取被折最后一个 pair 的 runIndex（summaryPair 无 runIndex、折叠永不需要它的；`pairsCompacted`（沿现 `turnsCompacted` 数值语义）超过现存配对数时 clamp，与磁盘旧算法 `Math.max(0,…)` 同款；取值保守偏小只造成快照与原文轻微重叠，由装填"严格早于"规则天然吸收）。这**精确保持今天的跨 run 窗口语义**（canonical = [user, assistant] 配对 + summaryPair，`rebuild.ts:57-59` 一手核实）：run 内工具协议消息是 run 瞬态、跨 run 不留存。已知不对称并有意保留：启动装填会把工具轮渲染成可读文本（数据源 `messages`），而进程内跨 run 配对不含工具细节——是现状行为的延续，留作未来校准点，本次不改。

**accept / rollback 语义**：窗口只在 owner 决定接受时前进。接受策略归 owner（REPL 现状=完成与中断的 run 都落盘都接受；server 沿其现状 preRun 回滚协议`run-turn.ts`），本次不统一两端策略（非需求）。接受顺序固定：**先 `appendRunRecord` 成功、后 `acceptRun`**——持久化失败则窗口不前进（下轮重试同一基底），消灭现状"持久化失败 append newMessages 产生内存漂移"的降级分支。

**run 瞬态 vs 窗口事实的边界**（一条规则定死）：`onBeforeRun.injectUserContext` 的贡献与 per-LLM-call turn-context 块是 **run 瞬态**——只进该 run 的发送视图、不进窗口事实（窗口配对派生自 runRecord 原文,看不见 runtime 内部注入是特性而非缺陷：要每 run 可见就每 run 重注,谓词自然成立,窗口里也不堆陈旧副本）。进入窗口的非 run 内容只有窗口**自身构造**的两类条目——bootstrap 装填对（3.2.2）与折叠摘要对;不存在任何"改写用户消息"的注入,**用户消息在发送视图、窗口、持久化三处同一（原文）**。

**生命周期**：随注意力窗口生命周期存续（lifecycle-concepts.md §1）；崩溃即弃、重启走启动装填重建（派生视图的代价与自由）；闲置可弃（重建免费），eviction 策略留给宿主层、本次不建。

#### 3.2.2 启动装填（「怎么读」确认节的落地形态）

**落点（§二「怎么读」第 2 点的载体落定）**：装填内容是**窗口的起始条目**,由 owner 侧装填器在建窗时一次性置入。运行效果满足 §二 第 2 点的全部要求（紧贴当前 user message 之前、随首个 run 进发送视图、落盘只存原文）,但**载体不是改写 current user message**——早先草稿期的"注入到当前 user message"方案已被本载体取代,§二 字面已同步修正,两处现为一致;也不是 onBeforeRun 订阅者（订阅者看不见 accept/rollback,失败语义不可控）。这个载体让一整类问题不存在：装填内容与 run 成败无关（首 run 失败回滚,窗口条目原样在）,"只装一次"由建窗时机天然保证（无 loaded flag、无 pending 协议）,用户消息永远是原文（无 sent/original 双轨、无 server adapter 透传需求）,失败语义平凡。

流程（orchestration 启动时，用户发首条消息之前）：

1. owner 调 `buildStartupBootstrap({ conversationId, reader, snapshotReader, capability, estimator })` → 返回装填对（或 null：无历史 / clear 后为空）。
2. 预算：`budget = max(min(optimalMaxTokens / 4, 24_000), continuityFloor)`；`optimalMaxTokens` 取 `model-capability.ts` 绝对值；`continuityFloor` = 最近一组对话 + 一条摘要的估算（单组超大改用压缩核估算）。
3. 装填：`readRunsReverse` 倒读,逐组（整 run record）经 estimator 估算入预算,装满即止——组数是结果（§二:7 组降为经验参考）；最近一组必完整,单组超过优质上限改放压缩核（开头意图 + 结尾结论 + 最后两轮原话）。
4. 摘要：取最新有效快照（`createdAt > lastClearAt` 且 `coveredThroughRunIndex <` 已装原文最早 runIndex，不满足则向更旧快照回退），封顶几百字（超则截 active 尾、保 facts/state）；无快照 → 预算全给原文,绝不现场生成。
5. 渲染为一条 **system-meta 装填对**：`core/context/system-meta` 新增 `kind="startup-bootstrap"` 构造器（与 compact summaryPair 同模式——user/assistant 对保角色交替合法,标签机制生成、不手写,明确标记为机制插入、不冒充用户原话或历史回复）。内容文本：摘要在前、最近原文按时间正序在后（最贴近用户即将说的话）；用户/助手内容保持原文，工具轮从 `messages` 渲染为可读文本、不伪装协议消息。
6. owner 建窗时把装填对作为 **bootstrap 起始条目**置入（`createAttentionWindow({ bootstrap })`,3.2.1）。首个 run 输入 = `[...window.getMessages(), 用户原文消息]`——用户消息无任何改写,持久化 `messages[0]` 即原文是**结构性保证**（无需 originalUserMessage 之类的双轨契约,server adapter 零改动）;run 失败回滚不动窗口,装填天然存续;装填条目随窗口跨 run 可见,直到被折叠摘要对取代（3.2.1 单 frontier 语义）。

窗口换代（clear / switch / resume）→ 弃旧窗、建新窗重新装填；clear 后装填天然为空（读原语止于 ClearRecord）。

#### 3.2.3 运行期窗口重构：同一数据流，改道终点

段切换现有机制整体保留（评估时机 runTurnBegin/runTurnEnd ②、optimal/defer/risk 三态决策、byte-equal 摘要调用、`ParsedSummary` 三段），唯一改动是**产物的去向**：

- `SegmentManagerOutput.marker`（CompactMarker 形态）→ 更名 `windowCompact`,语义改为**窗口重构指令** `{ summary, structuredSummary?, segmentId?, pairsCompacted, tokensBefore, tokensAfter }`;orchestrator 现有累积器照常累积,经 `RunResult.windowCompact` 带出（替代 `RunResult.compactBefore`,字段删除）。M5 后生产者只剩段切换一个——compact 累积订阅（`subscribeCompactAccumulator`）随 engine 退场一并删除,不留死订阅者。
- owner 在 accept 时消费之（3.2.1）；若含 `structuredSummary` 且对话持久化 → 同时写一个快照文件（触点 C；`coveredThroughRunIndex` 取自 `acceptRun` 返回值——折叠发生在窗口内部,被折配对的元数据经返回值交出,owner 不触窗口内部结构；写失败只 warn,不影响 run record 与窗口）。
- transcript 不再收到任何 marker：`commitTurn({compactBefore})`、`appendCompact`、`compactAll`、`normalize` 的 compact 语义全部退场（store 重写后这些路径物理不存在）。
- 手动 `/compact`：重定义为**强制段切换**。`forceCompact` 重实现：本地构造 SegmentManager（阈值置零 → `risk-exceeded` 强制 trigger,天然绕过 in-progress defer——用户明确要求压缩,不该被推迟）,复用 instance 权威 prompt + tools 满足摘要调用的 byte-equal cache 对齐（现 `forceCompact` 的双 engine 降阈值重试走 LLMSummarize、无 cache 对齐——目标实现严格更优）;产物与自动切段同构：`windowCompact` + 可选快照,owner 经窗口的 run 外入口 `applyCompact` 应用（拿 `coveredThroughRunIndex` 写快照,与 acceptRun 同一折叠实现）并触发 `onAttentionWindowChange("compact")`——`AttentionWindowChangeReason` 的 `Extract` 同步纳入 `"compact"`（现仅 `clear | resume`,`lifecycle.ts:70`;run 外手动压缩本就是窗口换代）,不落盘;history<4 守卫留 owner 侧不变;`ForceCompactResult` 演进为 `{modified, messages, windowCompact?, budget}`（budget 由 checkBudget 纯计算继续供展示）。旧 engine+strategies 实现随 M5 物理删除——全系统只剩段摘要这一条 LLM 压缩路径,**/compact、自动切段、应急地板是同一机制的三种触发**。
- run 内换代信号（windowLifecycle.onChange）与 `segment:new_started` 事件照旧（payload 去 marker 化,带快照摘要元数据）。

#### 3.2.4 旧 budget 体系退场（缺陷一的窗口侧清除）

- **turn-end ① 移除**：`runTurnEnd` 的 budget-driven 兜底步骤删除,①②③④ 编号收敛为 ②③④;run() 入口的 pre-flight `resolveContextManager` 块删除——其职责（首调前防超窗）已由 `runTurnBegin` 的段评估覆盖（turn-end.ts 注释明示 ② optimal 是最早触发点）。
- **三级百分比阈值退役**：`context/budget.ts` 的 normal/warning/compact/critical 判定不再驱动任何压缩;`calculateBudget` 仅保留为 UI 占用快照展示的纯计算（`context:tokens_snapshot` 路径不动）。
- **strategies 处置**：`MessageDrop` 删除（物理删早期消息语义无存在理由）;`LLMSummarize` 删除（职责被段切换完全覆盖）;`MemoryFlush` **迁挂段切换时刻**——从 budget usage≥0.75 触发改为 `SegmentTransitionHook.afterSummarize`（types.ts 预留接口的首个真实消费者）,段切换正是自然蒸馏点。两处配套：① `SegmentTransitionContext` 扩展携带被摘段 `messages`（只读）——现 ctx 仅 `{conversationId, segmentId, tokensBefore}`,记忆提取无输入可用;② 挂 afterSummarize 而非 beforeSummarize 由失败语义决定——segment-manager 既有分级是 beforeSummarize 失败**中止段切换**、afterSummarize 失败降级 warning 继续,记忆提取失败绝不该陪葬段切换,且段切换成功才提取、不为失败切段白花成本。强制 /compact（3.2.3）与 ephemeral 段切换同样触发提取,覆盖面不低于现状。此项不可静默丢弃,它是「敢真删的前提」安全垫的一半。
- **ephemeral 覆盖**：段评估的 `no-conversation → pass` 放宽为"无 conversationId 时照常评估与切段,仅跳过快照/segmentMeta 持久化"——budget 引擎退场后 ephemeral 长任务的窗口保护由段机制接管。
- **应急地板**（注意力层自己的最后兜底,与旧三级阈值划清界限）：`risk-exceeded` 触发切段而摘要 LLM 失败时,机械保尾截断窗口（无 LLM、不落盘、阈值挂 `riskMaxTokens` 不挂 contextWindow 百分比）,防 run 失控撑爆物理窗口。
- **serve 补接段机制（M5 硬前置）**：一手现状——只有 REPL 链恒传 segmentDeps（`repl.ts:359` → `session.ts:177`）;**serve 的两处 `createAgentRuntime` 都不传**（per-session 工厂 `serve/command.ts:250`、定时任务 ephemeralRuntime `:340`）,飞书/RPC 会话与 ephemeral 任务今天的唯一窗口保护就是 budget 引擎,且应急地板挂在段机制上——budget 退场而 serve 不补接 = 全线零压缩、零地板。故 M5 硬前置：serve 两处装配注入 segmentDeps——taskListReader 复用既有 `builtinExtraTools.taskListService`,persistence 在 serve 未接 ConversationRepository 之前注 no-op 实现（`SegmentPersistence` 失败语义本就允许 segmentMeta 缺写,`segment/types.ts:127-131`）;ephemeralRuntime 同样注入（与上条「ephemeral 覆盖」放宽配合,该路径才真正生效）。`cli/runtime/types.ts:87-89` 的"降级为 budget-only 兜底"注释同步改写（不传 segmentDeps 的路径自此无任何窗口压缩,仅剩测试/纯嵌入消费）,防声明面领先生效面。

#### 3.2.5 /clear · 切换 · resume

- **/clear**（`session-commands.ts` clear handler 重写）：① `appendClear`（事件落盘,3.1.3）;② `window.reset("clear")`;③ 现有 `resetConversationState` + `clearViewLayerState` + `onAttentionWindowChange("clear")` 链照旧。`compactAll` 调用删除。
- **切换 / resume**（`session-commands.ts:262`、`switch-to-new-conversation.ts`、workscene 恢复）：`conv.messages = loaded.messages` 改为"建新 `AttentionWindowState` + 启动装填(3.2.2) + 窗口换代钩子"——resume 不再全量 load transcript 当窗口。
- **UI 历史渲染**（§二 双读端的 cli 投影,M7）：启动/切换时经 `readRunsReverse` 按条数取最近数组对话渲染为屏上历史尾巴;遵守 clear 边界;实现细节归 cli 渲染层。

### 3.3 各包改造落点

| 包 | 改造 |
|---|---|
| `core/transcript` | store 重写：index + 分片 + `appendRunRecord` / `appendClear` / `TranscriptReader` / `runRetentionSweep`,无 legacy 路径;删除 commitTurn 全家（compactBefore/appendCompact/compactAll）、`CompactMarker` 类型与 `rebuildCanonicalMessages` |
| `core/context` | 新增 `context/window`（AttentionWindowState）+ `context/bootstrap`（buildStartupBootstrap）;`context/system-meta` 新增 `kind="startup-bootstrap"` 装填对构造器;segment 输出改 `windowCompact`、`SegmentTransitionContext` 扩展被摘段 `messages`（只读）;strategies 三处置;budget.ts 降级为展示计算 |
| `core/loop` | turn-end ① 删除;RunResult `compactBefore`→`windowCompact`;buildTurn → buildRunRecord——组装 `[userMessage, ...newMessages]` 完整协议序列（现有输入即此,纯函数改返回形态;派生 helper userOf/finalAssistantOf/deriveToolCalls 同居此处） |
| `orchestrator` | run() pre-flight 块删除;累积器目标字段更名为 `windowCompact`（compact 侧订阅随 M5 engine 退场删除,segment 侧长期保留）;MemoryFlush 迁挂 afterSummarize（3.2.4）;`forceCompact` 重实现为强制段切换（3.2.3） |
| `cli` | repl run 尾部改 accept 协议(`repl.ts:1408-1414` 回灌点);/clear、切换、resume 三处改造;M7 历史渲染 |
| `server` | `ConversationManager.recordTurn` 改 accept 协议(去 canonical 回喂);session 挂起的 `loadHistory` 全量加载改启动装填(`access-surfaces.ts:37-45`,与 cli 同一 owner 协议、无 server 特例;adapter 零改动——装填是窗口条目,不碰 user message);ephemeral 分支= pending run records + 同一窗口,promote 仅 flush 落盘 + runIndex 对账(3.2.1) |
| `cli serve 装配` | `__transcript-gc` seed + 薄壳 handler 注册;两处 `createAgentRuntime`（`serve/command.ts:250`/`:340`）注入 segmentDeps（taskListReader 复用 taskListService、persistence 先 no-op,3.2.4） |

### 3.4 实施序列（每步独立可验，按依赖锁序）

- **M1 窗口运行态立起**（行为等价步）：AttentionWindowState 落地,repl/server 全部 canonical 回灌点改道;过渡期 windowCompact 双应用（窗口 + 照旧写盘 marker）保持内存与磁盘等价。验收：全量现有测试过;窗口与磁盘 canonical 在所有路径 byte-equal;持久化失败时窗口不前进。
- **M2 压缩反噬退场**：windowCompact 停写盘（双应用撤一半）,/compact 去落盘,marker 只进窗口;并加**过渡期启动护栏**——磁盘不再截断后 canonical 失界,M4 之前启动仍是全量 load,超长对话重启后窗口可超模型物理上限,此时段评估想自愈、但摘要 LLM 调用本身要发送整个超限窗口,自愈失效;故窗口初始 load 后按 `riskMaxTokens` 机械保尾截断（无 LLM、不碰磁盘,与应急地板同手法）,M4 预算装填落地时删除该护栏。验收：任何段切换/压缩后 transcript 文件不变短;`commitTurn` 不再收到 compactBefore;超长 canonical 启动被护栏截到 risk 以下、随后段评估正常压缩。
- **M3 持久化分片**：新 store(index/分片/clear 事件/倒读),/clear 切 clear 事件并删 compactAll;旧单文件格式连同 `CompactMarker` 概念整体删除（无迁移,3.1.6）。验收：新对话零根级 transcript.jsonl;旧格式零读写路径、全仓无 CompactMarker 类型;每条 run record 含完整协议 `messages` 且 `messages[0]` 为用户原文;clear 后倒读为空;7M 边界 rollover 正确;崩溃恢复全形态测试过（含 clear 两步写中断补写 lastClearAt、Windows 替换窗口 tmp 收尾恢复、索引缺失 / 损坏从分片全量自愈——读写两路径共用）。
- **M4 启动装填 + 快照**：bootstrap + 快照写读 + owner 建窗装填;cli 的 resume/切换与 server session 挂起的 loadHistory 同步改装填——两端同协议,杜绝"cli 预算装填、server 仍全量灌 canonical"的劈叉(后者即 M2 过渡期启动护栏所防的同款失界敞口);同步回写 agent-runtime-lifecycle.md §四② 三场景表——"启动从持久化倒读历史"一行由 owner 侧装填器承接(本文 3.2.2 落点修正),onBeforeRun 保留其余场景,消除兄弟 spec 矛盾。验收：重启后首 run LLM 见装填对+最近原文且第二 run 仍见(窗口存续);落盘 `messages[0]` 为用户原文——结构性保证,cli 与 server 两端用例仍覆盖;首 run 失败回滚后装填不丢;无快照时纯倒读;M2 过渡期启动护栏已随预算装填删除。
- **M5 budget 体系退场**：serve 补接 segmentDeps（硬前置,3.2.4）+ ①/pre-flight/三级阈值/strategies 处置 + MemoryFlush 迁挂 + /compact 切段化 + ephemeral 段覆盖 + 应急地板。验收：全仓无 compact 驱动路径;serve 会话与 ephemeral 任务的段切换端到端测试;memory flush 在段切换时触发的集成测试;/compact 强制切段端到端测试（绕过 defer、窗口经 applyCompact 前进、快照含正确 coveredThroughRunIndex、不落盘 transcript）;`cli/runtime/types.ts` 的"budget-only 兜底"注释已同步改写。
- **M6 GC**：sweep + system task + 快照退役。验收：封笔出窗的非活跃片删（封笔=后继片 createdAt，片龄超期但封笔在窗内不删）/活跃片永存/单片不删;快照按"超期 && 非(最新且未退役)"单一判据删、退役不提前删;sweep 与 append 并发安全;GC 全程零索引写。
- **M7 UI 历史尾巴**：cli 启动/切换渲染最近历史(双读端兑现"回到工位"用户侧那一半)。验收：打开即见;/clear 后不见;渲染遵守 cli 渲染层行宽合约。

### 3.5 不变量清单（机械可验，进测试）

1. 分片文件只追加、永不被重写;index 只有 owner 写;GC 对索引零写、对文件只删。
2. 持久化任何 API 不返回/不构造 LLM 视图;`RunRecord.messages` 是唯一权威内容字段（零冗余派生字段落盘）,`messages[0]` 恒为用户原文、全序列不含任何注入。
3. 目标分片不含 CompactMarker/summaryPair;窗口重构永不缩短 transcript。
4. 一切读路径（装填/UI/未来召回）止于最近 ClearRecord。
5. 窗口只经 acceptRun/reset 前进;accept 先持久化后窗口;失败回滚到 preRun 基底。
6. 启动装填对是窗口起始条目、跨 run 存续直到被折叠摘要对取代;injectUserContext/turn-context 为 run 瞬态不进窗口;用户消息在发送视图/窗口/持久化三处同一（原文）。
7. 快照可全删而系统照常（仅启动连贯性降级）;快照永不参与窗口/transcript 的权威重建。
8. ephemeral run 不产生任何持久化写（record/快照/segmentMeta）。
9. 摘要快照只在 persistent 对话的 run accept 成功后、或 run 外手动 compact 经 `applyCompact` 应用成功后落盘（ephemeral 会话两条路都不写）;`coveredThroughRunIndex` 严格早于装填原文起点。
10. 段评估对有无 conversationId 行为一致（仅持久化副作用差异）。

---
