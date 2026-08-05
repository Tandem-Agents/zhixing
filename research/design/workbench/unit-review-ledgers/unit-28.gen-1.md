# 单元登记:第 28 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:28
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-05
- **登记来源**:用户要求将第 28 单元独立审查及价值裁决后的当前问题、已删除问题分别转入正式问题列表和已排除问题

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U28-01～U28-07 专项收口完成；七项已在同一冻结指纹上通过固定矩阵、四路冷启动对抗与反证差异审计
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是
- **交付物文件集**:第 28 单元起点 HEAD `e0a56fad` 至当前冻结工作区的 126 个非工作台路径，删除 0；CLI 33、core 33、executor 5、orchestrator 11、owner-kernel 14、runtime-host 5、server 7、tools-builtin 9、架构与规格 9
- **当前交付物指纹**:`git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb`；路径集 SHA-256 `fa113e62eea40c5d4c70934f8f9789f58e8bc3c80e3e4c1774dce1b727d22453`
- **架构来源**:分布式运行时总纲、可执行规格、持续在线需求与 S2 安全评审；memory、skill、workscene、work mode、runtime lifecycle、transcript/attention window、Task 子 agent、文件编排及其直接上游合同；第 12～27 单元冻结合同、适用排除项/迟发现教训及第 28 单元定稿开发清单

## 固定边界

- **功能范围**:第 28 单元（S7）编排、memory、skill、workscene、task-list、segment 与 lifecycle 的 staged/commit/publish 接入，以及 Task/DAG 子租约和双拓扑生产装配
- **架构不变量**:run 内写只进入 assignment staged overlay；owner 决策与 CommitEnvelope 是唯一提交事实；锚点 adapter 是 global 唯一物化点；failed/cancelled/uncertain 不外泄；同机与 mesh 只换 transport 不换语义；子租约按子先父后收敛
- **验收条件**:第 28 单元定稿开发清单 D28-01～D28-09 与独立审查清单 IR28-01～IR28-45；P0/P1 清零后按工作台完成冻结终审、独立功能审查和必要验证
- **必要上下游**:core 合同与严格 codec、executor assignment ledger/ResourceGovernor、owner-kernel conversation/job commit 与恢复、runtime-host/orchestrator/tools staged/query 消费、CLI/server/RPC 产品反馈及双拓扑装配
- **明确不属于本单元**:第 29～38 单元能力；通用 outbox/事件总线、监控、诊断、benchmark、性能采集或未来扩展框架；改变 memory、skill、workscene、task-list、segment 的既有产品能力与确认边界

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| publish decision × batch | owner 日志中的不可变 `MutationBatch` 与 `publish-decision` | owner 同一提交决策写入；写入及两 execution 重放前均过公共联合谓词 | 合法 applied、错域/错键/错 revision、响应丢失与重启重放 | conversation/job producer；publisher、delivery participant、surface | outcome 与 batch record 一一对应；恢复进度按 batch 有界，重放幂等 | 通过 |
| 逐项 publish 反馈 | 同一 decision、batch 与 committed assignment | conversation final-outbox / history 和 job notice 与权威决定绑定后派生 | live/补读交错、回调失败、响应重放、部分冲突 | conversation/job owner；server、CLI、channel 与 scheduler notice 消费端 | 每个 global outcome 至多一个稳定身份；surface 去重有界且不重算权威字段 | 通过 |
| memory CAS 与同 run overlay | memory authority 日志 + 当前 assignment staged overlay；共享 logical-entry 投影 | staged receipt 只进 overlay；owner publish CAS 是外部生效点 | 首次/连续写、同 run 多写、并发 winner、delete/不匹配补位 | memory tool/flush；adapter、runtime search 与模型上下文 | search 只扩取 `limit + relevant overlay count`，去重排序后截断 | 通过 |
| skill window 声明 | assignment-bound GlobalQuery 的 catalog revision 与 runtime window generation | 每个新窗口首个 prompt 消费前由 runtime 唯一刷新 | clear/resume、run 内换代、缺查询上下文 | runtime 唯一 producer；skill index 与 prompt | 每窗口一次有界 catalog 读取，无构造期第二权限面 | 通过 |
| GlobalQuery 严格边界 | GlobalStatePort 权威结果 + core `query + result` 公共 validator | local read 前后、mesh server encode 前与 client decode 后 | accessor/隐藏字段、错 kind/id/scope、坏 digest、路径字段、串线响应 | 同机 assignment、anchor mesh server、executor mesh client；各 runtime 读消费者 | 闭合联合逐变体校验；沿用既有查询上界，不新增缓存或队列 | 通过 |
| descendant child 终结 | executor ResourceGovernor 耐久日志与稳定 reservation/usage 身份 | 同一 governor 事务保守 consume open usage，再最深优先终结子树 | provider/abort/timeout、半提交、终结响应不明、重启与并发 child | Task/DAG factory、assignment finalizer；usage intake 与父 run | delegation depth/预算有界；重放零重复计费，父终态前零 active descendant | 通过 |
| 七项直接交界 | 上述六项权威事实的稳定身份与提交顺序 | `U28-01↔02`、`U28-04↔06↔07`、`U28-03↔05` 各自在权威边界交接 | decision 重放、overlay 查询、wire fail-closed、child 查询失败后的资源收敛 | owner、runtime、mesh、governor 生产装配 | 不新增第二事实源、通用 outbox/codec/owner 日志或无界设施 | 通过 |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。整表须覆盖固定边界、全部交付文件、关键原语和九类核查面。
>
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、状态或结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U28-01 | **P1，工作量：中；来源 P28-01。** `PublishRecord` 允许 granted workscene 携 `appliedResult`，公共 `validatePublishDecisionRecord` 却只允许 `t/targetRevision`，合法 owner 记录会在读取或重放时被判坏账；反向放宽字段后，conversation/job 的 batch-bound 重放又没有统一核对 outcome 与对应 mutation 的 kind、对象身份、对象 revision 和 `targetRevision`，畸形结果可延迟到物化时才失败。证据：`packages/core/src/contracts/records.ts:406-423`、`packages/core/src/protocol/contract-validation.ts:49-90`、`packages/owner-kernel/src/conversation-assignment.ts:4392-4550,10422-10521,10564-10629`、`packages/owner-kernel/src/delivery-participant.ts:451-543`。**价值裁决记录：**原结论曾由 P1/中收窄为 P1/小；冷启动事实链证明不仅要接受一个字段，还须闭合 decision×batch 的联合语义，恢复为 P1/中。仅当权威合同撤销联合校验时才重开。 | publish outcome 的结构校验与 batch 语义校验分叉：公共 validator 不认识合法 applied 分支，owner 私有谓词又未成为 producer、conversation replay 与 job replay 共用的单一合同。 | 生产端：conversation/job publish decision；类型组合：granted/conflicted、workscene 四操作、非 workscene、session/global；消费者：owner reducer、delivery participant、commit/replay、workscene publisher；异常终态：合法记录 fail-stop，或错 operation/sceneId/revision/targetRevision 在重启物化时形成永久待办；测试：两 execution 的生产、codec、batch-bound 重放及逐字段错绑负例。受影响审查项：IR28-03、08～10、23、27～28、36、39～40、45。 | 收敛为一个公共联合谓词：先严格校验 decision/outcome 结构，再以对应 `MutationBatch` 逐项校验；workscene granted 必须携完整 `appliedResult`，operation、sceneId、对象 revision 与外层 `targetRevision` 全等，非 workscene 必须省略。conversation producer/reducer 与 job participant 全部复用，删除私有分叉。完成标准：合法两域记录提交/重放通过，任何缺件、错域、错对象、错 revision 或额外字段均在进入投影前 fail-closed。 | 已验证 |
| U28-02 | **P1，工作量：中；来源 P28-03。** owner 已耐久产生逐项 granted/conflicted/applied 结果，但 conversation `FinalFrame` 只保留冲突数量，`publishConflicts()` 无生产调用者，成功 workscene applied 结果也无 surface 消费；job decision 同样没有进入 occurrence 维护投影。证据：`packages/owner-kernel/src/conversation-assignment.ts:4392-4543,4726-4735,4980-5034,10856-10864`、`packages/owner-kernel/src/job-assignment.ts:4292-4347`、`packages/rpc/src/session-events.ts:76-96`、`packages/owner-kernel/src/scheduler-user-notices.ts`。 **反证 C28-02：**专项证据对账发现 job 路径只有源码追踪与 notice-journal 单测，缺真实 job commit producer 的逐项通知断言；已补入真实 job commit producer 用例并验证通过。 | 权威 publish decision 没有派生到既有 conversation 控制事件与 job 维护通知，提交终态和用户可见终态断开。 | 生产端：conversation/job publish decision；类型组合：逐项 granted/conflicted、四类 workscene applied result、部分冲突与重放；消费者：FinalFrame、同会话 control observer、CLI/RPC/channel、job occurrence 维护投影；异常终态：CAS 冲突静默、成功 create 的 sceneId/revision 不可行动、断线补读遗漏或响应丢失后重复反馈；测试：conversation/job、部分冲突、applied、live/补读重放和双拓扑产品文案。受影响审查项：IR28-11、23、25、27、30、37、45。 | 只从 owner decision 派生反馈：conversation 保留 FinalFrame 计数，由 final-outbox live 发布和 `finalHistory` 补读共同从同一 decision 派生 `PublishConflictNotice` 与 workscene applied 结果，再投到既有 `scope:"control"` 通道；job 把同一逐项结果投到既有 occurrence/`SchedulerUserNoticeJournal` 维护链。反馈身份绑定 assignmentId+seq+decision，surface 按该身份去重，不重算 sceneId/revision，不建新通知基础设施。完成标准：live、断线补读和响应重放呈现同一可行动结果且不重复副作用。 | 已验证 |
| U28-03 | **P1，工作量：中；来源 P28-04。** Task/DAG child 在 provider 抛错、abort、timeout 或 `message_end` 前结束时可遗留 open usage，settle/release 失败或响应不明后也可保持 active。ResourceGovernor 日志、稳定 child identity、`flushAssignment` 与 worker 重试已是耐久恢复锚点，但 flush 只保守收敛 usage/report，不终结遗留 descendant child；assignment child 又被通用 expiry reclaim 排除。证据：`packages/orchestrator/src/subagent/factory.ts:213-237,349-470`、`packages/executor/src/resource-governor.ts:439-696,778-789`、`packages/core/src/protocol/resource-governor.ts:915-960,1059-1068`。**价值裁决记录：**原结论为 P1/中大，并因误判“没有耐久 owner”要求新增 assignment owner 义务日志；源码证明现有 governor 与 finalizer 已提供耐久重驱，缺口仅为 finalizer 未扫尾 descendant。新决定为 P1/中，禁止新增 owner 日志。仅当现有日志无法稳定枚举子树或 finalizer 不具备耐久重驱入口时重开。 | governor 已有单租约终结和 assignment usage finalizer，但缺少二者共用的“保守消费 open usage 后按最深优先终结 child 子树”事务；factory 只调用会因 open usage/active child 拒绝的单租约 settle/release。 | 生产端：Task/DAG child acquire、metering、settle/release 与 assignment flush；类型组合：父/子/孙 lease、open usage、active/settled/released、稳定 child identity；消费者：ResourceGovernor、assignment worker、后续 child 预算；异常终态：provider 或 child tool/GlobalQuery fail-closed、abort/timeout、terminal 响应丢失、嵌套/并发 child、重启重放；测试：上述插点、子先父、幂等与父终态零 active child。受影响审查项：IR28-13、15～16、27～28、30、36、45。 | 在现有 ResourceGovernor 内抽取幂等子树终结事务：先按预占上限消费目标子树 open usage，再最深优先 settle/release descendants 并 settle 目标 child；现有 child `settle` 作为 factory 正常快路径调用它，随后 release 目标 child，`flushAssignment` 在生成最终 report/watermark 前对全部遗留 descendant 复用。响应不明继续由现有终态幂等与 worker 重试收敛。完成标准：所有终态和重启插点最终零 active descendant、预算归还且 usage 不漏不重。 | 已验证 |
| U28-04 | **P1，工作量：中；来源 P28-05。** MemoryFlush 对 people/profile 的稳定 ID upsert 未读取当前 authoritative digest，首次落盘后第二次 flush 必被 CAS 拒绝；现有 runtime overlay 的预测 digest 又遗漏 `domain`，且通用 list helper 固定查询 `domain:"memory"`，不能为 people 写取得正确前像，同 run 第二写即使补 `expectedDigest` 仍会错绑。证据：`packages/orchestrator/src/runtime/create-agent-runtime.ts:797-853,1298-1348,2355-2426`、`packages/core/src/memory/global-state-adapter.ts:178-217,376-447,467-492,554-587`。**价值裁决记录：**原结论由 P1/中收窄为 P1/小；冷启动核对发现还须单源化 authority/runtime 的 entry identity 与 digest，恢复为 P1/中。仅当同 run 连续 flush 被产品合同取消时才重开。 | lifecycle flush 未读取 current digest，runtime overlay 又独立重算且不全等于 authority planner；CAS 前像、同 run 预测和域映射存在三套语义。 | 生产端：三域 MemoryFlush staged upsert；类型组合：首次创建、既有 people/profile、同 run 同键多写与真实并发；消费者：memory adapter、overlay 与后续检索；异常终态：持续冲突、预测摘要错绑、重放、并发 CAS winner；测试：首次/连续更新、people/profile 域、同 run 多写、并发冲突和重放。受影响审查项：IR28-19、25、27、29、37、45。 | 从现有 memory authority planner 提取唯一 entry identity/digest 投影供 adapter 与 runtime overlay 共用；flush 按 people→people、profile→memory/profile 查询当前权威+本 assignment overlay，并把全等 digest 写入 `expectedDigest`，journal 保持追加语义。完成标准：首次、跨 run 连续及同 run 连续 flush 均可提交，两个并发 assignment 仍只由 CAS 确定 winner，重放不改变前像。 | 已验证 |
| U28-05 | **P1，工作量：中；来源 P28-08。** mesh `GlobalReadResult` 只检查顶层 `kind` 后强制转换，没有逐变体 exact-keys、嵌套 DTO、摘要、path-free 字段或原 query 反绑。证据：`packages/cli/src/serve/global-query-mesh.ts:35-98,101-190`、`packages/core/src/contracts/state.ts:132-195`、`research/design/modules/distributed-runtime/specification.md:30-55,609-646`。**价值裁决记录：**原结论为 P1/中；曾因“正常 producer 尚未产生畸形结果”错误降为 P2/中。受支持的 wire 故障、对端异常和协议漂移本就是当前分布式场景，且规格冻结递归严格/path-free 合同，新决定恢复 P1/中。只有响应不再跨 wire或权威合同撤销该边界时才重开降级。 **反证 C28-01：**固定矩阵核对发现同机 `createAssignmentGlobalQueryPort` 仍直接透传 query/result，local 与 mesh 尚未共用同一严格合同；已修复并由 local/mesh 直接用例补证通过。 | GlobalQuery 的 local/mesh 入口未共用与请求同等级、且绑定原 query 的公共严格 validator，读取边界不能证明对象图与请求语义满足合同。 | 生产端：同机 assignment GlobalQuery、anchor mesh server 与 executor mesh client；类型组合：memory search/list/stats、trust、schedule、workscene list/get、skill catalog/get、config asset、asset index 及全部嵌套 DTO；消费者：memory/skill/workscene/runtime 管理读；异常终态：未知字段、错 kind/对象、坏摘要/revision、查询串线、路径泄漏与协议漂移；测试：同机 read 前后、服务端 encode 前、客户端 decode 后的全部正负变体及双拓扑。受影响审查项：IR28-35、40～41、43、45。 | 在 core 为现有联合建立一个 `query + result` 公共递归严格 validator，同机 read 前后、服务端 encode 前和客户端 decode 后复用；逐变体 exact-keys/类型/上界/摘要/path-free 校验，并反绑 scope/domain/id/kind 等查询条件，不新增 codec 框架。完成标准：全部合法变体通过，任何嵌套错形、查询串线、坏 digest 或路径字段均在进入 runtime 前 fail-closed。 | 已验证 |
| U28-06 | **P2，工作量：中；来源 NB28-01。** `readMemoryOverlay` 在 memory-search 的 base hits 上追加同 scope 的全部 staged memory，既不反绑请求 domain，也不重跑 query/ranking/limit；base 已先截到 limit，若 overlay 删除或改成不匹配，权威第 `limit+1` 个候选也无法补位。证据：`packages/orchestrator/src/runtime/create-agent-runtime.ts:825-837,2355-2426`、`packages/core/src/memory/global-state-adapter.ts:178-217,582-587`。**价值裁决记录：**原结论为 P2/小；冷启动核对证明精确 top-N 不能靠末端过滤修好，还须先按 overlay 规模扩取 base 并冻结 staged 排序语义，新决定为 P2/中。仅当权威 query 已能返回未截断候选或产品合同撤销精确 top-N read-own-writes 时才重开。 | overlay 只实现键覆盖，没有复用 authoritative search 的域过滤、匹配、排序和候选窗口语义。 | 生产端：同 run staged memory 与 memory-search；类型组合：跨 domain、匹配/不匹配 upsert、delete、重复 ID、排序边界和 limit 补位；消费者：runtime/model context；异常终态：其它域或无关记忆污染、错误 top-N、删除后漏项、超出上限；测试：跨域、无关词、更新覆盖、删除补位、排序去重与上限。受影响审查项：IR28-19、37、45。 | 先读取本 assignment overlay，按相关变更数有界扩取 base 候选，再用 U28-04 单源 entry 身份/投影及 authoritative search 的 domain/query 谓词合并去重；排序把匹配的 staged 写视为晚于 base、同为 staged 时按 recordSeq 降序，其余复用权威 comparator，最后 slice(limit)，不得伪造 durable `updatedAt`。完成标准：同 run read-own-writes 保持，跨域/不匹配记录不出现，删除或更新后正确候选补位且结果严格不超上限。 | 已验证 |
| U28-07 | **P2，工作量：小；来源 NB28-02（原 P28-06）。** 文档及源码旧注释把 skill-index 冻结为构造期 `onWindowOpen` lifecycle subscriber，生产实现由 runtime 在新窗口首 run 和 run 内换代显式刷新；第 28 单元已把 skill 读取权威收窄为 assignment-bound GlobalQuery，构造期没有合法查询上下文。证据：`packages/orchestrator/src/runtime/create-agent-runtime.ts:213-224,1056-1069,1781-1844`、`research/design/specifications/agent-runtime-lifecycle.md`、`research/design/specifications/skill-system.md`。**价值裁决记录：**原结论为 P1/中并要求迁移为 lifecycle consumer；该迁移会扩大构造期权限，而现有时序在 prompt 消费前刷新并保持等价体验。新决定为 P2/小，仅修正文档/注释。若 prompt 可在刷新前消费或出现第二 producer，才重开功能方案与评级。 | skill 读取权威迁移后，架构声明与代码注释未同步；当前 runtime-owned 刷新不是第二 producer。 | 生产端：新窗口首 run、run 内窗口换代与 clear/resume 后首 prompt；类型组合：catalog revision、window generation、缺查询上下文；消费者：skill-index、prompt 与维护者；异常终态：过期 prompt 或重复 producer（当前不可达）；测试：首窗、run 外换代、run 内换代。受影响审查项：IR28-24、37、39、45。 | 将 lifecycle/skill 文档和代码注释统一为 assignment-bound、runtime-owned、window-bound 刷新事实，保留现有三类回归断言；不迁移生产机制、不扩大 GlobalQuery 权限。完成标准：声明与唯一生产调用图一致，现有 prompt 时序测试保持。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| X28-01 | 原 P28-02 主张 global stager/query 的可选 capability、epoch 与 ordinal fallback 会破坏生产重放；核实 conversation/job 生产装配均经 `assignmentGlobalCapability` 取得唯一 capability，conversation ownerEpoch 来自同一 anchor authority，job 使用 envelope anchorEpoch，生产工具调用均携耐久 toolCallId。 | 可选参数和 ordinal fallback 在当前受支持生产调用图不可达；不存在当前用户损失，不为接口纯度扩建修复。本裁决只覆盖当前单一 capability/fence 与耐久 toolCallId 前提。 | `assignment-schedule-stager.ts:28-94,122-151`；`conversation-assignment-worker.ts:328-360`；conversation/job authority 装配；交付指纹 `06da446b...`；IR28-04。 | 生产出现独立 owner/anchor 代际、无 capability 的 global 写，或 staged schedule 可在没有耐久 toolCallId 时执行。 | 已排除 |
| X28-02 | 原 P28-07 主张 run context 缺失时的 segment repository fallback 是 assignment 第二写面；核实该分支只服务 conversation owner 取得 exclusive control 后的 run 外 `/compact`，D28-03 明确保留 `/clear`、`/compact` 等 run 外管理经 owner/control 执行。 | 当前 fallback 不从 active assignment 到达，也不会在 failed/cancelled assignment 后写入；它是明确保留的 control 面，不是 staged 旁路。本裁决只覆盖 owner + exclusive control 的 run 外调用。 | `segment-deps.ts:39-64`；`conversation-manager.ts:1775-1864`；D28-03；交付指纹 `06da446b...`；IR28-31、IR28-38。 | 该分支可从 active assignment、非 owner 主体或未取得 exclusive control 的路径到达。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| M28-01 | publish decision 结构与 MutationBatch 联合合同；conversation/job 生产、重放及错绑均须共用单一谓词 | core 合同定向测试 + owner-kernel conversation/job 定向测试 | U28-01 生产文件、公共导出与直接测试 | 集中修复 / 小 | core 联合合同 6/6、delivery participant 9/9 通过；owner-kernel 类型检查通过 | git-delivery-manifest-v1:229b5eca013b629eb1040e22391a27bea4e899e60992a465bd38d097565bd8d6 | 有效 |
| M28-02 | owner decision 到 conversation control 与 job 维护通知的 live/补读/重放恰一次闭环 | owner-kernel、executor job producer 与 CLI/server 直接消费测试 | U28-02 conversation/job 生产、投影、产品消费与直接测试 | 集中修复 / 中 | owner-kernel 类型检查通过；scheduler notice 4/4、conversation durable conflict/live-history 1/1、真实 job commit producer 1/1、CLI presenter 2/2、server subscribe history 1/1 通过；C28-02 补证通过 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| M28-04 | 三域 MemoryFlush 的 authoritative+overlay CAS 前像与同 run 连续更新 | core memory adapter + orchestrator runtime 定向测试 | U28-04 memory identity/digest、flush 与 overlay | 集中修复 / 中 | core memory 5/5、orchestrator 同 run overlay 1/1 通过；两包类型检查通过 | git-delivery-manifest-v1:229b5eca013b629eb1040e22391a27bea4e899e60992a465bd38d097565bd8d6 | 有效 |
| M28-06 | memory-search 的 domain/query/rank/limit 与删除补位保持 authoritative 等价 | orchestrator memory-search 定向测试 | U28-06 overlay merge 与 U28-04 共享投影 | 集中修复 / 小 | orchestrator 跨域、删除补位与 top-N 定向用例 1/1 通过 | git-delivery-manifest-v1:229b5eca013b629eb1040e22391a27bea4e899e60992a465bd38d097565bd8d6 | 有效 |
| M28-07 | skill-index 声明与 assignment-bound runtime-owned 刷新调用图一致 | 文档差异核对 + 既有窗口刷新定向测试 | U28-07 lifecycle/skill 文档、注释与直接测试 | 集中修复 / 小 | 旧声明扫描无第二 producer；窗口边界刷新定向用例 1/1 通过 | git-delivery-manifest-v1:229b5eca013b629eb1040e22391a27bea4e899e60992a465bd38d097565bd8d6 | 有效 |
| M28-05 | 全部 GlobalQuery/GlobalReadResult 变体在 local/mesh 双端递归严格且反绑原 query | core validator + CLI local/mesh 定向测试 | U28-05 联合类型、local/mesh guard 与直接测试 | 集中修复 / 中 | core 全联合/错绑/accessor 3/3、CLI local/mesh 2/2 通过；core 构建通过；CLI 全量类型检查仅保留 8 个既有 config-editor/startup 错误，改动文件零新错误；C28-01 补证通过 | git-delivery-manifest-v1:50d2d2027dd418877c42b539fe5756af4aba73e1d53dc5705cb2421d83a64977 | 有效 |
| M28-03 | provider/abort/timeout/响应不明/重启下 descendant child 最深优先终结且 usage 不漏不重 | executor governor + orchestrator child 定向测试 | U28-03 governor/finalizer/factory 与直接测试 | 集中修复 / 中 | executor governor 22/22、orchestrator child boundary 2/2 通过；两包类型检查通过 | git-delivery-manifest-v1:229b5eca013b629eb1040e22391a27bea4e899e60992a465bd38d097565bd8d6 | 有效 |
| F28-01 | U28-01 decision×batch 完整事实链 | 冻结源码反向追踪 producer、公共谓词与两 execution replay | core validator；conversation/job producer/reducer；delivery participant | 专项功能审查 / 小 | 合法 decision 可提交/重放；错域、错键、错 revision 与 applied 缺件均在投影前拒绝 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| F28-02 | U28-02 owner decision 到 conversation/job 可行动反馈 | 冻结源码追踪 live、history、重放与稳定身份 | final-outbox、publishResults/finalHistory、scheduler notice、server/CLI 消费 | 专项功能审查 / 小 | feedback 只由权威 decision 派生；部分冲突与 workscene applied 在 live/补读同形且按稳定身份去重；C28-02 真实 job commit producer 补证通过 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| F28-03 | U28-04/U28-06 memory 三域连续写与同 run 精确查询 | 冻结源码追踪 shared projection、CAS 前像、overlay merge 与 top-N | logical-entry、memory adapter、runtime flush/search | 专项功能审查 / 小 | domain 进入 identity/digest；首次、跨 run、同 run 与并发 CAS 收敛；跨域/不匹配/delete 补位均保持 authoritative 等价 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| F28-04 | U28-07 skill 声明与唯一生产调用图 | 冻结文档/源码双向扫描并复用窗口定向证据 | lifecycle/skill 文档、runtime 窗口刷新调用点与测试 | 专项功能审查 / 小 | assignment-bound runtime 是唯一 producer；首窗、run 外/内换代均在 prompt 前刷新，无构造期权限扩张 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| F28-05 | U28-05 local/mesh GlobalQuery 请求与结果严格闭包 | 冻结源码逐变体核对 exact-keys、递归对象、query binding 与三处边界 | core validator、local port、mesh server/client 与直接测试 | 专项功能审查 / 小 | C28-01 修复后 local/mesh 共用单一谓词；accessor、错绑、坏摘要与 path 字段全部 fail-closed | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| F28-06 | U28-03 descendant child 子树终结 | 冻结源码追踪 normal settle、assignment flush、usage/report 与重启幂等 | governor/finalizer/factory 及 22+2 项直接证据 | 专项功能审查 / 小 | open usage 先保守 consume，后代最深优先 settle/release；响应不明与连续恢复不复活、不重计，父终态前零 active descendant | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| F28-07 | 七项直接交界与生产装配 | 按固定矩阵双向核对 owner→surface、authority→overlay→query、mesh fail-closed→child finally | 七项生产入口、消费者、异常终态和直接测试 | 专项功能审查 / 小 | 三组直接交界无第二事实源、无旁路写、无漏反馈或资源泄漏 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| A28-01 | 冷启动角色：publish 严格合同与用户反馈 | 抛开既有结论重造错域/错键/部分冲突/响应丢失/重放 | U28-01↔U28-02 冻结调用图 | 对抗复审 / 小 | 公共联合谓词和 owner-derived feedback 闭合，C28-02 补证后重新复审，未发现新反证 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| A28-02 | 冷启动角色：memory/skill lifecycle 与同 run 语义 | 重造三域连续写、并发 CAS、跨域污染、delete 补位与窗口换代 | U28-04↔U28-06↔U28-07 冻结调用图 | 对抗复审 / 小 | shared projection、overlay 过滤/排序和唯一窗口 producer 闭合，未发现新反证 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| A28-03 | 冷启动角色：GlobalQuery wire 安全与双拓扑 | 重造 accessor、隐藏/额外字段、错 kind/id/scope、坏 digest、路径泄漏与串线响应 | U28-05 local/mesh 冻结边界 | 对抗复审 / 小 | 首轮发现 C28-01；修复后重新冷启动复审，local/mesh 三处边界全部 fail-closed | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| A28-04 | 冷启动角色：ResourceGovernor 子树终结与崩溃恢复 | 重造 open usage、嵌套/并发 child、终结半提交/响应不明、重启与查询失败 | U28-03↔U28-05 frozen governor/factory 边界 | 对抗复审 / 小 | 现有日志、稳定身份和最深优先 finalizer 足以收敛，零第二 owner 日志，未发现新反证 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |
| D28-01 | 历轮反证差异审计 | 机械对账七项原失败链、C28-01～C28-02、专项矩阵与四路记录 | U28-01～U28-07 当前记录及 F28/A28 证据 | 专项收口 / 小 | 原七项均为修复后复核通过；C28-01 已同根合并并修复后复核通过；C28-02 已补齐真实 job producer 证据；无发现消失、无未处置反证 | git-delivery-manifest-v1:ba9cbb456b3a0ebe5ed74f73ad7a6586e6a28961be7fea4aa60a9f265c48feeb | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-28.gen-1 -->
