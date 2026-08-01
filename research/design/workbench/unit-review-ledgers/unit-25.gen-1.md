# 单元登记:第 25 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:25
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-07-31
- **登记来源**:用户授权在补充功能遗漏开发完成后执行独立审查清单重定稿，并将第 25 单元纳入连续审查与修复工作台

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:五项专项功能审查发现同根残留，已解除冻结并回到集中修复
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否（专项审查已使旧指纹失效；待五项残留修复、受影响包验证和 U25-19 重建最终账本后重新冻结）
- **交付物文件集**:以同目录 `unit-25.delivery-manifest.json` 为唯一账本；当前 `pathCount=166`、`deletedCount=0`，完整路径、分组、路径集哈希均只从该文件读取，不再人工抄写
- **当前交付物指纹**:以 `unit-25.delivery-manifest.json.fingerprint` 为唯一值；由 `node scripts/unit-delivery-manifest.mjs --base 994f05c --check research/design/workbench/unit-review-ledgers/unit-25.delivery-manifest.json` 复算并校验，算法与逐路径 blob 输入由同一生成器冻结，工作台、单元登记文件和暂存状态不计入
- **架构来源**:分布式运行时总纲与可执行规格；持续在线需求；workscene、会话、运行时生命周期、常驻服务、权限、资源治理；第 13～24 单元适用排除项与迟发现教训；第 25 单元 21 项定稿开发清单

## 固定边界

- **功能范围**:S7 第 25 单元 Environment 与 workscene 接入：executor 本地 workspace binding 事实与管理/恢复、Environment probe、能力发布与选机、workscene 锚点注册、会话 owner 进出、活动投影、legacy cutover、manifest 冻结、executor 开跑前复验，以及对应生产装配、治理、用户面和结构性验收
- **架构不变量**:真实路径只留目标 executor；锚点、会话 owner 与 executor 各有唯一权威；单机/分布式只替换 adapter；全部新增耐久事实严格解析、可恢复且有界；无 P0/P1 方可提交
- **验收条件**:第 25 单元独立审查清单重定稿并全部通过；正式问题闭合；同一冻结交付物完成两轮终审、独立功能审查及必要最终验证
- **必要上下游**:第 16～24 单元冻结的 manifest、matcher、mesh、authority、资源治理、WAL/投影、surface 数据面、会话、PathGuard、确认、delivery 与生产组合根
- **明确不属于本单元**:第 26 单元 scheduler/job 产品闭环与旧投递退役；第 27 单元 advancement；第 28～29 单元统一 staged/control 与入口 lint；第 30～32 单元本地域 owner、离线新会话与收编；迁居、备份、服务生命周期和发布

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| `unit-25.delivery-manifest.json` 登记的当前完整交付闭包 | 路径数量、有限分组、路径集哈希与 manifest 指纹共同来自唯一生成账本；core 导出与 schema、server canonical registry golden、可执行 S7 耐久合同账本、包级类型、本机管理 owner/outbox 与生产组合根均须反向归项 | 运行唯一生成器 `--check`；冻结准备时核对分组求和、零未知分组、零未归项及全部派生资产 | 待核查 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| workspace binding catalog 与能力发布 | binding append-only 日志及根 manifest | 日志提交；reset 以根 manifest 原子切换提交 | CRUD、degraded、pending reset、发布响应丢失、重启 | executor 本地管理/恢复 owner、能力目录、selector | 分页恢复、固定 single-flight 与严格前进 revision | 待核查 |
| workscene 注册、会话 owner 与活动投影 | 锚点 registry 日志；SessionMeta 与 session-activity 内部记录 | GlobalStatePort 提交；owner session-create；同 CommitEnvelope 活动记录 | CRUD/CAS、enter/exit/delete、owner/anchor 重启、投影落后 | GlobalStatePort adapter、会话 owner、接入面、list/get | 增量投影，查询与正常 turn 零全量扫描 | 待核查 |
| legacy 兼容桥与 cutover | 旧注册表快照、迁移报告与新锚点日志 | 持旧写 fence 的单次 activation | 分页导入、源变化、响应丢失、回滚与再次升级 | host migration adapter、GlobalStatePort、binding migration port | open 才重驱，终态单向且材料有界回收 | 待核查 |
| probe、资源治理与开跑前复验 | probe 耐久日志、能力快照、ExecutionManifest | probe 结果提交；started 前复验 | 过期/伪签/错绑定、容量背压、revision 漂移、重启 | owner/client、executor handler、selector、runtime | 有界保留与分页维护；每 assignment 至多一次本地 preflight | 待核查 |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。整表须覆盖固定边界、全部交付文件、关键原语和九类核查面。
>
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。
>
> 本列表统一承载本单元尚未收口的补充开发与功能缺陷；进入“问题列表”只表示仍须处理，不等于把补充开发定性为普通缺陷。
>
> **本轮收口方式**：U25-02～U25-06、U25-11、U25-14 是已定稿开发义务没有真正完成的补充开发，不得按普通问题逐点修补或修一项审一轮；须与 U25-01、U25-10 两个功能缺陷组成一次集中实现闭包，按 `U25-01 → U25-05 → U25-11 → U25-03 → U25-14 → U25-02 → U25-04 → U25-10 → U25-06` 的依赖顺序完成生产链，最后统一建设 conformance 证据。U25-08、U25-09、U25-12、U25-13、U25-15 为非阻断问题，保持独立记录，不穿插本批阻断闭包。
>
> **当前实现核账**：U25-01～U25-06、U25-08～U25-15 的既有实现证据绑定旧 133 文件基线，保持“待验证”。四项首轮合并验证与账本检查曾在 `git-delivery-manifest-v1:3a45a6a87cbdd64f3bed7f6cf3cb2537099c5da18c13298102d45eb7be10b471` 通过，但随后专项功能审查分别发现：U25-16 的 transport secret 临时发布残留、U25-18 的 catalog 错误代数混写、U25-17 的测试映射伪见证、U25-19 的 rename 闭包缺口。该指纹及 V25-10 只保留为旧证据，不再证明当前四项闭合。
>
> **本轮实施顺序**：`U25-16 → U25-18 → U25-17 → U25-19`。先把 owner/bootstrap 生命周期收敛为单一事务，再补 committed 错误分类；随后重建由生产事实生成的耐久见证，最后修正交付闭包账本。三个 P1 必须集中修复后统一验证，P2 只做账本收口。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U25-01 | **P0，工作量：中；来源 P25-08 与执行者 1 号全审，功能缺陷。** binding CRUD 已提交权威日志后再发布能力，但 `deviceDigest` 不含 catalog generation/规范 workspace 集，版本存储复用旧 revision；生产复现为发布后 create 报 `Capability descriptor revision was rewritten`，且重启后 `publishedWorkspaces=[]`、全域无 catalog snapshot 重建调用，degraded/reset 撤回同样无法发布。 | binding 权威事实与能力快照各自推进版本，没有从 catalog 快照到严格前进 capability revision 的唯一版本输入和线性化发布原语。 | binding CRUD/reset/degraded、启动重建、CapabilityDescriptor、版本清单、selector、queued 唤醒及恢复测试；受影响 IR25-01、03、10、12、16～17、23、26～27。 | 以 catalog generation、规范 workspace 集和设备 readiness 共同生成唯一版本输入；启动先从 binding 日志重建发布集，CRUD、degraded 撤回、reset 与恢复重发都经同一串行发布原语取得严格前进 revision，响应丢失只重放原快照。验收覆盖发布后 CRUD、重启、损坏、reset、响应丢失及 selector 零失效候选循环。 | 待验证 |
| U25-02 | **P0，工作量：大；来源 P25-11 与执行者 1 号全审，补充开发（D25-F01/F02/F03 未真正完成）。** legacy 二写、observer 释放、同 envelope tombstone、重复删除与 owner 收敛主体已落地；物理清理现由组合根唯一创建的共享 owner 承载，会话与场景删除按场景串行，使用目标外耐久游标分页遍历，每个文件、空目录与游标步骤独立取得 storage permit；场景终态前还会有界清退崩溃遗留的会话游标。 | 场景会话的创建、活动、observer、删除与派生投影原先没有统一归属同一 owner/CommitEnvelope；物理清理也曾以一次递归删除无界占用并在崩溃后从头重做。 | GlobalStatePort adapter、WorksceneSessionOwner、ConversationDirectory/Manager、session.delete、session-activity、enter/exit、observer、quiesce、活动/删除投影与测试；受影响 IR25-01、06、08、12～13、16～18、21、23、26。 | 保留已经完成的唯一 owner 与同 envelope 语义；把场景目录清理改为由删除 owner 持有的可恢复分页义务：耐久记录页游标，每页只枚举并删除固定数量对象，叶级物理删除独立取得 storage permit，崩溃后从游标重驱，全部页完成后再删除空目录并标记清理终态。验收除既有 wire 删除、多接入面、quiesce/exit、重启与竞争外，增加大目录有界批次、页间崩溃续跑和零治理旁路。 | 待验证 |
| U25-03 | **P1，工作量：中偏大；来源 P25-09 与执行者 1 号全审，补充开发（D25-F04 未真正完成）。** 七条本地命令仍经 loopback RPC；list/rename/repath 响应直接返回 absolutePath，`LocalWorkspaceTransfer` 又把路径及 requestId 落本地文件后令 token 过 wire，CLI 暴露 bindingRef；RecoveryPort 启动恢复只 fire-and-forget 一次并吞错。 | local-only 管理与 committed recovery owner 没有形成真实生产入口，错误地用普通 RPC、路径中转文件和一次调用栈代替。 | CLI/桌面本机入口、server RPC/golden、AdminPort、RecoveryPort、路径 transfer、确认、reset owner、能力撤回/恢复及测试；受影响 IR25-01～02、04、12～14、18～20、23、26～27。 | 在目标设备本机组合根直接注入同进程 Admin/RecoveryPort，删除生产 RPC、facade 和路径 transfer；本机管理面可显示本机路径但不要求用户处理 bindingRef，跨设备仅传设备域引用；reset 先展示三项影响再签发单次 confirmation，预约后由全部适用拓扑必然创建的 committed owner 持续重驱。验收证明零 RPC/mesh/路径 token、零远端路径、零 bindingRef 产品文案及无人重试恢复。 | 待验证 |
| U25-04 | **P1，工作量：大；来源 P25-12 与执行者 1 号全审，补充开发（D25-F05 未真正完成）。** legacy 迁移仍全量、无治理；客户端 `importSetDigest` 使用 legacy `lastActiveAt` 且不规范化 name，锚点却强制 `lastActiveAt=createdAt` 并 NFKC，常见旧数据必冲突；空 `scenes` 也因没有 batch 永久拒绝 activation。 | 迁移缺少两侧共享的规范导入模型与有界 committed owner，导致正常旧数据无法 cutover，且大数据迁移不可恢复、不可治理。 | 旧注册表源、规范导入 DTO/digest、空集合、迁移报告、binding import、GlobalStatePort、storage maintenance、启动恢复、cutover/回滚与测试；受影响 IR25-07、15～17、19、23、26。 | 定义两侧共用的 path-free 规范 import entry 与空集合 digest；以冻结源清单、分页游标和有界 report 作为恢复事实，每批源读取、binding 导入、锚点提交与报告落盘由同一 committed migration owner 经 storage maintenance 执行，全部页完成后持旧写 fence 复核并单次 cutover。验收覆盖被 touch/NFKC 名称、零场景、容量不足、分页崩溃/重启、响应丢失、源变化与再次升级。 | 待验证 |
| U25-05 | **P1，工作量：中；来源 P25-10 与执行者 1 号全审，补充开发（D25-F06 的严格 schema 闭包未完成）。** workscene、binding、probe 三类 reducer 仅浅校验；`mutationDigest` 不重算、probe result 不验完整签名、binding record 无 exact keys 且六条 requestId 分支可覆盖既有请求。 | 把 TypeScript 联合类型当作耐久输入校验，缺少恢复、增量和回放共用的单源严格 validator 与统一 request replay 守卫。 | 三类日志 schema、validator/reducer、投影重建、幂等回放、签名结果、corruption vectors 与合同测试；受影响 IR25-02～03、05、14、16～17、19、23、26。 | 为每个记录族建立唯一严格 validator，逐 tag 校验 exact keys、完整嵌套 DTO、规范时间/摘要/签名及由 stream/request 重算的身份反绑；所有 requestId 分支先经过同一“同摘要回放、异摘要冲突”守卫；恢复、增量与回放统一调用，参数化 corruption matrix 逐变体证明 fail-closed。 | 待验证 |
| U25-06 | **P1，工作量：大；来源 P25-13 与执行者 1 号全审，补充开发（D25-F06 未真正完成）。** conformance 现由同一套件驱动真实 in-process/mesh authority 根、mesh service/client/authorize、生产 owner/assignment runtime factory、workscene directory/owner、preflight 与事件流；两台设备分别使用自己的容量根，测试替身只保留确定性模型与外部平台边界。 | 真实双组合根、逐记录生产/恢复点和拒绝/损坏分支的机械验收基础设施原先没有交付；执行与场景 owner 后半链也曾由测试自建替身承载，证据不能反绑生产装配。 | 两种真实 adapter/组合根、S7 完整生产链、记录与 manifest 状态族、恢复 owner、故障/资源矩阵、结构可达性及变异证明；受影响 IR25-05、12～13、22～23、26。 | 保留已完成的双 authority root、真实 mesh service/client/authorize 与状态对账；把 runtime、owner enter/exit 和事件出口改由两侧各自的生产 executor runtime factory 与 workscene directory/owner 组合根创建，测试只注入确定性模型、时钟和外部平台边界。随后以删除 runtime factory、owner 装配、authorize、拒绝或 corruption 分支的变异证明套件有鉴别力。 | 待验证 |
| U25-08 | **P2，工作量：中；来源 NB25-01 与执行者 1 号全审。** probe 终态保留只有手工 compact、生产零调用者，缺全部 executor 拓扑必然创建的维护 owner，现有枚举与退休也是单轮全量扫描。 | 有界保留合同没有生产调度与分页索引承载。 | probe 结果日志、完成时间索引、retire、executor role、storage governor、启动/停机与生命周期测试。 | 由 executor role 持有唯一 27 天保留维护器，以可重建有序索引分页固定批次，经 storage governor 追加 retire 并保存续跑点；启动恢复和停机闭合。 | 待验证 |
| U25-09 | **P2，工作量：小到中；来源 NB25-02 与执行者 1 号全审。** assignment 在 owner 预装配、executor 接收和 worker 启动链重复执行 workspace resolve+probe。 | 同一 assignment 的本地 preflight 没有进程内唯一执行身份和接管点，重复本地 I/O 可能跨 revision 观察不同目录状态。 | owner/executor preflight、ledger 接收、worker 启动、local/mesh、重启与终态清理。 | 在 executor 组合根建立按 assignmentId+manifestDigest 的 preflight single-flight；ledger 接收结果，worker 原子接管；重启重新执行一次，终态清理，绝不持久化真实路径。 | 待验证 |
| U25-10 | **P1，工作量：中；来源 P25-15，功能/架构缺陷。** conversation 执行链按 assignment 创建 executor base runtime，却通过 session adapter 固定触发 `session-dispose`；assignment 完成没有合法 reason，adapter/base 分离时还可能分别释放。 | assignment-scoped runtime 错用 session-scoped 生命周期合同，实例身份、末窗 reason 与唯一 dispose owner 不一致。 | lifecycle 类型与架构文档、runtime-host adapter、conversation runtime 组合根、Hub/abort/cleanup 顺序及钩子次数测试；受影响 IR25-12、17、23～24、26。 | 在权威 lifecycle 合同新增 assignment-scoped executor runtime 专用的 `assignment-dispose`，建立独立 execution adapter并禁止复用 session adapter；正常、abort、业务失败按对象身份只执行一次该末窗，未上位装配失败仍用 `assembly-rollback`，Hub detach 后再释放。验收锁定对象折叠、钩子次数、reason 和清理先后。 | 待验证 |
| U25-11 | **P1，工作量：大；来源执行者 1 号全审，补充开发（D25-F04 的 reset 状态机未真正完成）。** generation 公式多入 requestId 且截断摘要；`catalog-reset` genesis 缺完整准备回执，根 manifest 只留最近 reset；旧请求跨两代无法回放；前滚使用 recovery/background 而非 committed storage-foreground，beginReset 无物理准入，healthy+pendingReset 未拒，首代还复用共享日志。 | reset 的世代身份、可验链、幂等回放与 committed 前滚没有共同事实模型，恢复依赖最近一次 manifest 和碰运气重试。 | binding root/generation 日志、confirmation、准备回执、连续 reset、资源治理、启动 owner、能力撤回/恢复及 IR25-02～03、15、17、23、26～27。 | 严格采用规格唯一 generation/digest 公式；每代使用以 generation 为键的不可变日志，genesis 写可独立验真的完整准备回执，根 manifest 只指向但不替代世代链；同请求从链上回放原代结果。预约前 workload-interactive 准入，预约后统一 committed+storage-foreground owner 重驱；严格拒绝非法 manifest 状态并反绑新 bindingRef 世代。验收覆盖连续 reset、跨代重放、各崩溃点、背压/容量缺口、启动无人调用恢复与世代断链。 | 待验证 |
| U25-12 | **P2，工作量：小；来源执行者 1 号全审。** GlobalState adapter 合并活动投影 `lastActiveAt` 后未重排，registry 仍按恒为 createdAt 的旧值排序。 | “最近场景上浮”在新读链失效，用户看到的顺序长期陈旧。 | GlobalStatePort workscene-list、活动投影、CLI/模型列表与 IR25-08、20。 | 在唯一 adapter 合并投影后按派生 `lastActiveAt` 和稳定次键排序，exact get 不排序；覆盖多会话更新、投影滞后/重建及相同时间稳定顺序。 | 待验证 |
| U25-13 | **P2，工作量：小到中；来源执行者 1 号全审。** 生产选机未传稳定亲和参数，多候选恒退化为 executorId 字典序；语义不足时直接取首项，没有询问分支。 | 多设备下选择结果忽略既有亲和与用户意图，可能静默跑到非预期设备。 | ExecutorSelector、owner 组合根、queued/询问产品面及 IR25-10、20。 | 由 owner 单源提供冻结的稳定亲和键；多候选仅在冻结策略能唯一判定时自动选择，否则返回结构化“需要选择”终态交给 first-party 询问，禁止字典序兜底。验收覆盖重启稳定、候选同分、离线/上线与用户选择回放。 | 待验证 |
| U25-14 | **P1，工作量：小到中；来源执行者 1 号全审，补充开发（D25-01/D25-07 未真正完成）。** `runTurnWithCommit` 的 durable.run 调用未传 `environment`，RPC/session turn 入口也无显式选择载荷；而 durable admission 对 environment 做全等反绑，入口一旦接通就会首调或重放失败。 | first-party 显式环境选择只落了合同和内层运行时，真实输入→admission→assignment 生产链断裂；IR25-09 的既有通过结论失效。 | first-party RPC/session wire、run-turn、durable admission/replay、environment requirement、channel 拒绝与 IR25-01～02、09、16、19、22～23、26。 | 在 first-party 输入 DTO 增加结构化显式选择并严格解析，逐层原样传入 `runTurnWithCommit`、durable.run、ControlEnvelope 和 assignment；channel/非 first-party 零构造。重放逐层反绑同一选择，缺省明确为无 workspace。验收用真实 first-party 入口覆盖有/无选择、异载荷重放、重启/重派及 channel 拒绝。 | 待验证 |
| U25-15 | **P2，工作量：小；来源执行者 1 号全审。** `SessionControlMutation` 的 session-meta patch 类型仍暴露 `sceneId`，`session-activity` 实现字段 `operation:put/tombstone`、`at` 又与冻结的 `upsert/delete`、`lastActiveAt` 不同。 | 类型/耐久声明与冻结语义分裂，调用者可构造运行时必拒载荷，后续兼容与转移实现会按错误 schema 接入。 | core contract/codec、生产者/消费者、兼容 fixture、转移分类及 IR25-02、08、19、23。 | 从 patch 类型移除 sceneId，并将 session-activity 字段统一到冻结合同；若已有落盘样本则增加显式版本化兼容读，禁止静默双语义。同步全部生产者、严格 codec、fixture 与行为矩阵。 | 待验证 |
| U25-16 | **P1，工作量：中；来源 P25-18，本轮专项功能审查再次反证。** 分阶段生命周期、启动逆序回滚、停机排空和继任者清理正式 endpoint/secret 已落地；残留是 `writeSecret` 使用带 pid/随机数的临时文件，硬崩溃发生在写入后、rename 前会留下包含有效 token 的不可枚举孤儿，继任 owner 只删除正式 secret 与 endpoint，无法确定清理该秘密。 | 发布协议的临时身份没有纳入 canonical owner 的稳定资源集合；“原子 rename”只保证正式文件可见性，没有给崩溃前临时秘密定义唯一名称与继任清理责任。 | daemon/access-surface/executor-only/one-shot bootstrap、设备 capacity/mesh 的边界、binding/root/probe/outbox、host/transport、启动竞争、进程崩溃、失败回滚与停机；异常终态增加随机临时 secret 泄漏；受影响 IR25-12、17、28、26。 | 保留既有 `device-ready → owner-held → facilities-ready → bound → published → draining → closed` 生命周期；把 secret 临时发布文件改为 owner 锁保护下的唯一确定路径，开始写、失败回滚、unpublish、正常关闭和继任启动均先/后幂等删除该路径，再以 `open(wx,0600) → write+fsync → close → rename` 发布正式 secret。禁止目录模糊扫描和随机临时名。验收在写前、写后、sync 后、rename 前及 rename 后逐点注入失败/模拟硬崩溃，继任 owner 启动后正式 endpoint、secret 与临时 secret 均零残留且新发布只属于继任者。 | 待验证 |
| U25-17 | **P1，工作量：大；来源 P25-20，本轮专项功能审查再次反证。** descriptor/variant-reason 类型拆分和主入口收窄已落地，但 executable scenario 仍集中在 CLI；core/owner/CLI test-support 只接收中央注入的 `(kind,caseKey)` executor，并各自维护 `FAMILY_WITNESS`、reason 前缀与 recovery-owner 映射。中央执行后仍以请求 caseKey 调 `observeOutcome`，producer 用 constructor name，owner/resource 在对象构造或恢复调用旁手填字符串，最后再统一“提交见证”。删除真实分支、改错实际 owner 或跳过实际写入仍可能被这些映射遮蔽。 | canonical descriptor、可执行场景和实际生产见证仍是三份可独立漂移的声明；所属生产包没有在真实 producer/validator/reopen/recovery handle 的线性化点产出独立 observation，中央 harness 仍同时知道请求答案与观察答案。 | 八个耐久记录族、所属包 test-support、生产 descriptor/类型、typed validator/reducer/reopen、producer/recovery/resource 见证、S7 conformance、core workscene 导出与结构扫描；异常终态为伪见证通过和内部权威被外部直达；受影响 IR25-13、23、32、26。 | 每个所属生产包在非生产 `test-support` 子路径提供由本包 descriptor exact-set 约束的无参逐 case executable scenario；中央组合根只合并这些 scenario key 与执行结果。scenario 的 observation 必须来自真实事实：variant 从落盘后真实解码记录/终态反解；rejection 从真实 typed decision/code 反解并比较写前后权威摘要为零写；corruption 定向变异后必须经新实例 reopen 取得真实 typed corruption code。producer/resource 由实际 append/permit 成功点的 test-support witness handle 产生，recovery owner 由真实恢复入口接管并完成后返回的稳定 owner handle 产生；禁止 constructor name、family/reason/owner 映射、请求 kind/case 回填和“最后统一提交候选”。生产主入口保持零内部 registry/projection 导出。验收增加源码结构门禁和变异：删除真实分支、改错 typed code/owner/resource、跳过 append/reopen/recovery、回填请求元数据或重新引入映射均失败。 | 待验证 |
| U25-18 | **P1，工作量：中；来源 P25-19，本轮专项功能审查再次反证。** host-owned 最低 localSeq drain、retry/degraded 状态与停机安全点已落地；残留在决策代数：`WorkspaceBindingCatalogDegradedError` 与 `WorkspaceBindingCatalogConflictError` 被一律归为 completed 业务失败，而前者明确表示目录不可用，后者又同时承载用户代际冲突和 generation 链断裂/缺 receipt/错 log 等完整性破坏。committed reset 因此可能在基础设施仍损坏时被错误终结。 | catalog 生产层没有把“确定性请求拒绝”和“耐久状态完整性失败”分成不可混写的 typed error；host 只能按类名粗分，重新引入了“一次抛错即终态”的旧语义。 | CRUD/reset 的 live 与 recovery 驱动、localSeq 顺序、资源准入、I/O/维护、catalog generation 链、outbox 终态、启动/停机、重启与响应丢失；异常终态为 degraded/corruption 被伪造 completed；受影响 IR25-16、17、23、29、26。 | 在 catalog 生产层单源拆分 typed decision：确认过期/错 request/expected generation/健康目录禁止 reset 等确定性输入冲突使用 business-conflict；manifest/receipt/generation/log 链不一致、循环或不可验证使用 integrity error；catalog degraded 单独保留。host 仅将明确 business error 写 completed，capacity/I/O/取消走 retry，degraded/integrity/未知走 degraded 并保留原 committed 身份；禁止按 message 或操作种类猜测。验收逐一注入两类 catalog error，证明 business 决定只写一个失败终态，degraded/integrity 零 complete、后项零越过、只读诊断可达，修复底层后同身份由继任 host 重驱。 | 待验证 |
| U25-19 | **P2，工作量：小；来源 NB25-03，本轮专项功能审查再次反证。** 唯一生成器与 manifest 已落地，但路径收集使用默认 rename detection 的 `git diff --name-only`；Git 将 rename 折叠为新路径时，生成器只登记新增路径，不登记旧路径删除，`deletedCount`、路径闭包与指纹均不完整。 | 账本虽已单源化，生成算法仍把 Git 的展示级 rename 推断当成事实输入，没有把交付闭包规范化为相对 base 的逐路径 add/modify/delete 集。 | 正式单元文件头部与派生交付闭包、最终有限路径分组、manifest 指纹、路径集哈希及 IR25-26；不影响业务功能。 | 路径发现固定使用关闭 rename/copy 折叠的 base diff（或等价逐树差集），使 rename 恒展开为旧路径 `D` + 新路径 `A`；继续以 Git 过滤后的 worktree blob 计算内容，删除项绑定 base blob。增加 add/modify/delete/rename/untracked、文件名特殊字符和任一增删导致 `--check` 失败的生成器测试。全部实现落定后再用唯一命令重写最终 manifest，并让头部只引用该账本。 | 待验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V25-01 | core 的 14 个变更测试文件覆盖严格 reducer、binding/reset、probe、workscene authority、结构边界与 storage kind | 以 Vitest 运行 14 个变更测试文件；失败按单例归因后复核合并结果 | `packages/core` 当前变更测试及其直接生产输入 | 集中修复合并直接验证 / 中 | 旧基线 178 / 178 通过；D25-F08/F09 改变直接输入，须按当前闭包重跑 | 旧交付指纹 `42633b6d…87f` | 失效 |
| V25-02 | owner-kernel 的显式环境 admission、重放与 sceneId 静态身份 | `control-admission.test.ts` | `conversation-assignment.ts` 与对应测试 | 集中修复合并直接验证 / 低 | 旧基线 18 / 18 通过；当前输入已变化，须重跑 | 旧交付指纹 `42633b6d…87f` | 失效 |
| V25-03 | orchestrator 的默认 profile、turn 控制累加和 prompt 声明面 | 运行 3 个变更测试文件 | `packages/orchestrator` 当前变更生产/测试闭包 | 集中修复合并直接验证 / 低 | 旧基线 87 / 87 通过；当前输入已变化，须重跑 | 旧交付指纹 `42633b6d…87f` | 失效 |
| V25-04 | server 的 workscene RPC 薄适配和 canonical registry 结构/行为 golden | 运行当前变更测试并从真实 registry 核对 golden | `packages/server` 当前变更生产/测试/golden 闭包 | 集中修复合并直接验证 / 低 | 旧基线 22 / 22 通过；golden 生成链已替换，须重跑 | 旧交付指纹 `42633b6d…87f` | 失效 |
| V25-05 | executor assignment ledger 中本单元改动的环境与回放行为 | 定向运行被修改用例；全文件运行仅作诊断，不作为包测证据 | `assignment-ledger.test.ts` 中本单元改动用例及直接生产输入 | 集中修复合并直接验证 / 中 | 旧基线定向通过；生产 descriptor/scenario 输入已变化，须重跑 | 旧交付指纹 `42633b6d…87f` | 失效 |
| V25-06 | CLI 当前变更测试覆盖唯一管理组合根、耐久 outbox、local-only transport、迁移与 conformance | 按 IO 特征分组运行；失败单例归因并定向复核 | `packages/cli` 当前变更生产/测试闭包 | 集中修复合并直接验证 / 高 | 旧基线分组通过；D25-F08/F09 新增生产链和测试，须按当前闭包重跑 | 旧交付指纹 `42633b6d…87f` | 失效 |
| V25-07 | U25-16 的角色门禁、唯一 workspace host/outbox、稳定消费凭据、下游幂等交付与 reset 同身份确认 | CLI 六文件合并专项集；专项功能审查与所有权/崩溃协议冷启动复核 | bootstrap、host/outbox、workspace command、daemon/access/executor 装配、默认拓扑及对应测试 | 专项直接验证 / 中 / 36.60 秒 | 原 30/30 证据只覆盖身份传播与 ack 反绑；本轮源码反证证明锁取得、transport 发布和失败回滚未进入同一事务，不能继续证明 U25-16 闭合 | `git-delivery-manifest-v1:381b5b9fff9b185bb39e296639d4fa35c6080e309b7e3d3d88b74518e3e61f85` | 失效 |
| V25-08 | U25-17 的真实双拓扑组合根与八族逐 case 耐久见证 | CLI ledger/scenario 专项集；descriptor 分离结构检查；验收真实性冷启动复核 | conformance、生产包 test-support、ledger/scenario、生产 descriptor、真实 host/outbox/recovery owner 及对应测试 | 集中修复直接验证 / 中 / 33.66 秒 | 八族逐 case 12/12 通过；variant 不再声明 reason，中央零 family/case/reason 数组且零请求 kind/case 回填，内部 registry/projection 仅经 test-support 子路径可达；core/owner 类型检查通过，尚待五项冻结指纹与冷启动复核 | 工作区未冻结，待 U25-19 生成最终账本 | 诊断 |
| V25-09 | U25-16/U25-18 的分阶段发布、启动回滚、host 状态、有序 committed drain、三类决策与停机安全点 | `pnpm --filter @zhixing/cli exec vitest run src/runtime/local-workspace-management-host.test.ts src/runtime/local-workspace-owner.test.ts src/runtime/local-workspace-bootstrap.test.ts` | local workspace owner/bootstrap/host/facade/outbox、三条生产装配入口及直接测试 | 集中修复直接验证 / 低 / 16.40 秒 | 3 文件、14 项全部通过；证明瞬时失败保留同身份重试、未知失败进入 degraded 且零伪终态、停机保留 committed 并由继任恢复，尚待五项冻结指纹与合并验证 | 工作区未冻结，待 U25-19 生成最终账本 | 诊断 |
| V25-10 | 五项受影响包合并验证、派生资产与最终交付账本 | 按验证手册串行包测；只隔离全包负载超时和已定位派生资产失败；CLI 构建；最终运行 manifest `--write` 后 `--check` | core、owner-kernel、server、CLI 当前闭包；结构 golden；166 路径最终交付账本 | 专项合并验证 / 高 | core 2650/2654，全包 4 项中结构边界 2 项与 owner 清单 1 项修正后 22/22、耐久 I/O 超时单例 1/1；owner-kernel 209/209；server 748/749，结构 golden 更新后 1/1；CLI 2621/2631、1 跳过，9 个失败项修正或隔离后逐项通过；`pnpm cli:build` 通过；manifest `--check` 通过，零删除、分组和为 166 | `git-delivery-manifest-v1:3a45a6a87cbdd64f3bed7f6cf3cb2537099c5da18c13298102d45eb7be10b471` | 通过 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-25.gen-1 -->
