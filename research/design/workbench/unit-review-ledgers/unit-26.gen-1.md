# 单元登记:第 26 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:26
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-02
- **登记来源**:用户要求将第 26 单元独立审查及价值裁决后的全部问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U26-01～U26-05 专项修复、受影响包验证与四路对抗审查已通过；U26-06 重开条件未触发，保持非阻断后置；尚未进入全单元终审或最终验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否（本次专项审查输入已固定；全单元尚未进入冻结终审）
- **交付物文件集**:以第 26 单元起点 `4ec98cf` 计算的当前完整交付闭包共 104 个非工作台路径，其中删除 6 个；路径集 SHA-256 `eacd516d4465e8cc07a61c3ff8a8468f1123fb581bda61694543ceb83735410f`
- **当前交付物指纹**:`git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a`
- **架构来源**:分布式运行时总纲与可执行规格；第 26 单元定稿开发清单；scheduler、job、Delivery、surface、恢复与生产组合根适用合同；第 26 单元独立审查清单及价值裁决记录

## 固定边界

- **功能范围**:S7 第 26 单元 scheduler 与 job 产品闭环：任务 CRUD/run、手动与定时 job、调度与恢复、交互/取消、状态与结果投递、旧投递排空及生产装配
- **架构不变量**:锚点 scheduler/job owner 与权威日志唯一；用户操作具稳定幂等身份与 CAS；手动交互只回原接入面；ready 前零真实执行和外发；调度策略、通知、恢复与投递均耐久、有界且可重驱
- **验收条件**:正式 P0/P1 清零；独立审查清单全部通过；同一冻结交付物完成两轮终审、独立功能审查及必要最终验证
- **必要上下游**:GlobalState/CAS、AuthorityCommitLog、JobJournal、owner/executor assignment、surface ticket/channel grant、Delivery/Outbox、resource/storage governor、server/CLI/runtime 组合根
- **明确不属于本单元**:第 27～38 单元；benchmark、性能采集、通用诊断和非必要重构；没有当前可复现损失且尚未进入已定稿单元的通用权威日志压缩能力

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| 第 26 单元当前 104 路径完整闭包 | scheduler/job 合同、codec、生产组合根、结构验收与交付路径须在后续全单元冻结前统一反向归项 | 唯一 manifest 生成器以 `4ec98cf` 为基线计算：104 路径、6 删除，分组和为 104；本次专项只证明 U26-01～U26-06 闭包，不替代后续 IR26-01～IR26-30 全量反向对账 | 通过 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| scheduler CRUD/run 与任务定义 | AuthorityCommitLog / TaskDefinition | GlobalState/CAS 与 JobControl 提交 | 响应丢失、旧 revision、并发写 | CLI/RPC/facade、scheduler owner、目录投影 | 外层稳定 operationId、耐久 receipt、严格 CAS、有界投影 | 通过 |
| 手动 job 原接入面回程 | ingress turnOrigin 与 assignment stream | 当前 surface 代际定向投帧 | 多连接、断线、重连、错绑 | manual surface、surface router、ticket/answer guard | 单一发起 surface、稳定重连身份与游标补续 | 通过 |
| 启动恢复与 ready 门禁 | 权威日志中的未完成义务 | ready 前 prepare、ready 后 activate | 慢 handler/transport、单项失败、大量欠账 | runtime 组合根、recovery loop、legacy drainer | 固定并发、逐义务失败隔离、ready 前零外部副作用 | 通过 |
| 调度策略耐久结果 | JobJournal / TaskDefinition | 策略结果与相关终态的原子提交 | 迁移、离线 missed、failure threshold 半提交 | scheduler owner、timer、恢复与投影 | 首个未来时刻、有限 missed、停用义务提交后零新触发 | 通过 |
| 状态与缺口通知 | scheduler notice / JobJournal 与 Delivery | 稳定通知 key 同 envelope 提交 | 重复 poll、断线、重启、能力恢复 | scheduler/job owner、Delivery、用户接入面 | 不重不漏、同一 revision 支持 live/history、无通用诊断扩面 | 通过 |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。整表须覆盖固定边界、全部交付文件、关键原语和九类核查面。
>
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |
| R26-01 | U26-01 scheduler 操作权威、幂等与 CAS 完整链 | schedule 工具、Local/RPC/Execution facade、schedule RPC、AnchorSchedulerProductPort/GlobalState adapter、TaskDefinition/receipt、run/cancel JobControl 及直接测试 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 任一 operationId/source/revision/digest、GlobalState adapter、receipt 或 JobControl 路径变化 | 通过 | 0/2 | 专项审查从工具调用身份反推至权威提交：缺稳定 id 或身份即拒绝，同键同载荷先于 CAS 回放、同键异载荷与旧 revision 拒绝；测试与生产扫描通过。专项审查不计正式终审深审次数 |
| R26-02 | U26-02 第一方 surface 身份与 manual job 回程 | CoreHost 持久 instance id、auth/RpcSurfaceRegistry、connection generation、schedule ingress、manual surface/stream、delivery.resolve 与对应测试 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | client id、auth binding、连接代际、manual surface 游标或任何相邻控制入口身份变化 | 通过 | 0/2 | 双客户端、同身份重连、旧代迟到、缺身份与错绑反例均由稳定 principal + 当前代际 fence 收口；无广播回退，delivery.resolve 同样复用唯一身份函数 |
| R26-03 | U26-03 ready 边界与恢复拓扑 | scheduler prepare/activate、command runServer 顺序、user/system/manual 恢复、authority/legacy delivery 生命周期、停止恢复点及测试 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | prepare/activate、ready 顺序、恢复并发/隔离、transport 或 handler 生命周期变化 | 通过 | 0/2 | ready 前只 prepare；runServer 后才 activate。timer 立即接管，恢复固定并发且每条 assignment 单独隔离，慢项/坏项不阻断 ready 或同任务后续义务，停止后未完成事实仍可重建 |
| R26-04 | U26-04 调度策略耐久并发与崩溃恢复 | scheduler-policy 判别联合、legacy import、missed ready boundary、failure terminal/backoff、auto-disable obligation/settlement、timer/投影及测试 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | policy codec/reducer、时钟算法、failure threshold、触发 fence 或恢复投影变化 | 通过 | 0/2 | 三类策略结果与输入事实原子提交，恢复只读冻结结果；pending auto-disable 在 settlement 前同时阻断定时与手动新触发，稳定 requestId 只产生唯一 disabled revision |
| R26-05 | U26-05 missed/capability-gap 用户通知闭环 | SchedulerUserNotice 合同/日志、missed 分组、水位去重、capability gap open/update/close、Delivery、JobStatusDirectory/server.info/live 及测试 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | notice schema/key/revision、missed 水位、gap round、Delivery 或 live/history 投影变化 | 通过 | 0/2 | missed 批次与 gap 轮次均使用稳定耐久事实；重复 ready/poll 不重发，恢复/终态关闭后可新开一轮；成功提交统一触发 live，server.info 由同一 LSN 标量补读 |
| R26-06 | 五项交界组合与 U26-06 后置边界 | R26-01～R26-05 当前输入；CRUD↔surface、ready↔policy、policy↔notice 交界；AuthorityCommitLog 当前容量/启动事实 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 任一 R26-01～05 输入/结论变化；出现可复现容量或启动损失，或通用 compaction owner 进入定稿单元 | 通过 | 0/2 | 四路冷启动对抗与差异审计无未处置反证；U26-06 两项重开事实均不存在，未新增通用压缩、benchmark 或信息采集设施 |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U26-01 | **P1，工作量：中；来源 P26-01。** schedule RPC、RpcSchedulerFacade、LocalSchedulerFacade 及 ExecutionSchedulerFacade 的非 staged 回退把两类不同权威都压到 `SchedulerBackend` 直调：CRUD 绕过既有 GlobalState/CAS，run/cancel 绕过或丢失 JobControl 的稳定入口上下文；facade 丢弃工具层 operationId、每次自造 requestId，update/delete 不携当前 taskRevision。**价值裁决记录（2026-08-02）：**原结论将工作量评为“大”，并要求清退旧 Scheduler、RunRegistry 与 Backend 公开面；对立复核确认当前损失只要求生产入口复用既有权威 adapter，故撤销全局清退与整体重构，把工作量改为“中”。本轮根因复核进一步确认 run/cancel 不是 GlobalState 写，不能用一个含糊“统一写面”处理；只有既有两个 adapter 无法承载当前入口，或仍存在第二个生产写 owner 的新事实时才可重开更大方案。 | 产品 facade 缺少按权威域分型的唯一端口，并在层间丢失调用者分配的稳定 operationId，导致 CRUD 没有 GlobalState 的 epoch/revision/digest CAS，run/cancel 没有 JobJournal/ControlAdmission 的幂等控制身份。 | 生产端为模型工具、CLI、RPC 与三类 facade；CRUD 组合含 operationId/requestId、anchorEpoch、taskRevision、payloadDigest 与 GlobalState guard，run/cancel 组合含同一 operationId、已认证 control source、耐久 ingress、jobRunId 与 JobControl guard；消费者为 scheduler owner、任务目录、手动 job 与恢复路径；异常终态含响应丢失、同键异载荷、旧 revision、并发覆盖和回退路径换键。受影响 IR26-03、04、19、22、24、27、30。 | 在 server/CLI 组合根注入唯一的 scheduler 产品端口：list/create/update/set-state/delete 只经现有 AnchorSchedulerGlobalStateAdapter/GlobalStatePort，run/cancel 只经现有 ControlAdmission/JobJournal；operationId 由最外层客户端或工具分配一次并由 Local/RPC/Execution facade 连同已认证 control source 原样透传，facade 禁止重造随机键；update/delete 必须携调用方从读投影观察到的 taskRevision，缺失即拒绝，不得在写前偷偷读取“当前值”伪造 CAS。保留测试专用 backend，不重构整个 scheduler。验收要求响应丢失回放原 task/job、同键异载荷与旧 revision 稳定拒绝、staged 与非 staged 路径身份一致，生产结构扫描零 backend 直达。**修复证据：**R26-01 与 V26-01～V26-02；反证 C26-01（facade 临时造键/CRUD 缺稳定来源）已同根修复并复核通过。 | 已验证 |
| U26-02 | **P1，工作量：中；来源 P26-02。** 手动 job 的 ingress 目前只保存共享 `surfacePrincipal="rpc:owner"` 与进程内自增 connectionId；后者被写入 `turnOrigin.triggeredBy`，断线后不可重建。openManualJobSurface 又丢弃该路由并把含任务输出与 interaction display 的 assignment stream 广播给全部已认证连接；未发现 ticket 本体泄漏。**价值裁决记录（2026-08-02）：**原复核只看到广播，曾把方案收窄为“按旧 connectionId 定向”、工作量改小；本轮从重连合同反查确认该 id 不是稳定身份且公共 principal 无法区分客户端，旧方案不能完成“原 surface 重认证后续连”，故以新生产事实重开并改为“中”。仍不扩展 ticket/grant 密码协议；只有出现跨 surface 凭证验收反证时才重开凭证层。 | 第一方认证没有生成可跨连接重建的稳定 surface 身份，manual surface router 又未以该身份绑定唯一当前连接；因此“原 surface”既不能隔离多客户端，也不能在重连后恢复。 | 生产端为 RPC auth、schedule.run ingress、manual surface 与 assignment stream；类型组合含稳定 client/surface identity、当前 connection binding、IngressContext.surfacePrincipal、ticket guard 与续读游标；消费者为同宿主多个客户端；异常终态含同 principal 双连接、断线、重连、旧连接迟到帧和身份碰撞。受影响 IR26-08、19、24、27、28。 | 收敛为所有第一方 RPC 共用的单一身份函数：复用 auth `clientInfo.id` 接缝，要求客户端持久化高熵 instance id，认证时校验并派生稳定 RPC surfacePrincipal；将它而非临时 connectionId 耐久写入 ingress。server 维护该 principal 到唯一当前已认证连接的带代际绑定，重连提升代际并关闭旧连接。manual surface session 在 assignment pending 期间持续注册，连接缺席只暂停消费、不关闭义务；只向 ticket.surfacePrincipal 与当前代际均匹配的连接投帧，重连从原游标补续。缺少稳定 instance id 的调用不得获得交互票据。验收覆盖双客户端隔离、同身份重连、旧代迟到、身份碰撞、断线补续、pending session 不丢及 ticket/answer guard 不退化。**修复证据：**R26-02 与 V26-01～V26-02；反证 C26-02（相邻 `delivery.resolve` 仍硬编码公共 principal）已并入唯一身份函数并复核通过。 | 已验证 |
| U26-03 | **P1，工作量：中；来源 P26-03。** scheduler runtime.start 在 runServer 之前执行：user 恢复会 dispatch，system 恢复会逐项运行 handler；delivery setup 中 LegacyDeliveryDrainer.start 与 AuthorityDeliveryPipeline.start 也会在 server 监听前同步 flush 外部 transport。 | scheduler 与两条 delivery 生命周期都把“打开日志/接管耐久义务”和“执行真实副作用”放入 ready 前同一调用栈，任一慢 handler、慢 transport、单项失败或大量欠账都能阻塞整个产品可用。 | 生产端为 runtime 组合根、user/system recovery、AuthorityDeliveryPipeline 与 legacy drainer；类型组合含 prepared/ready/active 阶段、恢复义务水位和失败分类；消费者为 RPC/CLI 服务、handler、manual surface 与 transport；异常终态含慢调用、单项失败、大量欠账、外发失败及启动中止。受影响 IR26-15～17、20～21、23、27。 | 将 scheduler 与两条 delivery owner 都拆成 `prepare → activate`：prepare 只打开并校验日志、重建目录/投影、有限分页登记未完成义务，损坏或无法取得权威才阻断 ready；runServer 建立并回填接入面后再 activate，启动现有有界 worker 分页重驱 user/system/manual-surface/authority-delivery/legacy-delivery，逐项单飞、失败隔离且不等待清空欠账。scheduler 产品入口在 prepare 完成前明确 unavailable，activate 后才接受新触发。验收要求 ready 前零 handler/dispatch/transport 副作用，慢项、坏单项和大量欠账不阻塞有界 ready，其余义务在 ready 后持续收敛，停止时未完成项仍有耐久恢复点。**修复证据：**R26-03 与 V26-01、V26-03；反证 C26-03（timer 未先接管、同任务坏 assignment 截断后续恢复）已按每条义务隔离并复核通过。 | 已验证 |
| U26-04 | **P1，工作量：大；来源 P26-04。** 调度决定没有可重建的耐久落点：legacy nextRunAt 导入后仅写内存；离线 recurring missed 落 occurrence 后只从旧 scheduledFor 推一步，可能仍在过去；失败后的 Full Jitter next-fire 又以每次刷新时的 `now` 重算，重启会漂移；failure terminal 与阈值停用分两次写，二者之间崩溃会继续触发。 | JobJournal 已保存输入事实，却没有由 scheduler owner 独占、与输入反绑的耐久策略结果；恢复因此会按新的墙钟重新解释旧状态或遗漏未完成停用，而不是重放同一决定。 | 生产端为 legacy import、timer/missed、failure backoff 与 threshold disable；类型组合含 TaskDefinition revision、JobOccurrence、schedule/旧记录摘要、ready boundary、terminal statusRevision、冻结 next-fire、failureThreshold 与 auto-disable obligation；消费者为 scheduler 目录、timer、恢复和通知；异常终态含每个提交边界崩溃、长离线、多次 tick、墙钟推进/回拨、响应丢失和重复恢复。受影响 IR26-03、06、20、22、23、29。 | 只在现有每任务 JobJournal 增加窄的、判别联合式 scheduler-policy 事实，不建设通用 workflow：①导入 definition 时同 envelope 写 `legacy-next-fire`，反绑旧记录与 schedule 摘要；②写 user `missed` occurrence 时同 envelope 冻结严格晚于本次 ready boundary 的首个 future next-fire，once 写无后继；③每个失败终态同 envelope 写 `failure-policy`，反绑 taskRevision、statusRevision、失败计数和阈值，并一次冻结 Full Jitter next-fire；达到阈值时该记录同时携 `auto-disable-required`，一经提交立即阻止新触发，再以稳定 requestId 幂等追加唯一 disabled TaskDefinition revision 并写 settled。恢复只投影已冻结 next-fire、只重驱未 settled 停用，不得按当前 `now` 重算。验收逐一注入三类决定各提交前后、响应丢失、重复恢复与墙钟变化，证明 next-fire 字节一致、离线只产生有限 missed、阈值后零新触发且最终唯一 disabled。**修复证据：**R26-04 与 V26-01、V26-04；反证 C26-04（auto-disable-required 提交后 settlement 前仍可触发）已由定时/手动共同 fence 修复并复核通过。 | 已验证 |
| U26-05 | **P1，工作量：中；来源 P26-05。** missed 只有逐 occurrence 状态，渠道明确禁止逐条外发却没有稳定批次 producer；无兼容 executor 时 prepareJobAssignment 只抛内部错误，queued occurrence 被反复重试而没有耐久、去重、可补读的缺口通知。 | scheduler 对“未发生状态迁移但必须告知用户”的两类产品事实没有窄的耐久通知义务；普通 JobStatusNotice 只对应单 job 状态 revision，既不能表达跨任务 missed 批次，也不能安全承载同一 queued 状态的持续能力缺口。 | 生产端为 scheduler ready 汇总和 selector capability-gap；类型组合含 missed occurrence 水位、origin 分组、capability snapshot revision/reason digest、`noticeId/kind/revision/ref/reason/actions/at`、补读游标与 Delivery key；消费者为原渠道、当前已认证维护 surface 和断线补读；异常终态含重复 poll、断线、重启、部分投递及能力缺口关闭/重开。受影响 IR26-13、20、26。 | 在锚点 AuthorityCommitLog 增加仅覆盖这两类状态的 `SchedulerUserNotice` 耐久 producer 与标量续读游标，不改写 JobStatusNotice 语义、不建通用诊断系统：①ready 时按已验 missed 水位和 origin 分组，一次写 summary-prepared 与同批 Delivery enqueued，稳定键反绑批次上界与成员摘要；无渠道 origin 的同批事实进入可由 server.info 补读的第一方 notice。②首次发现无候选时在对应 JobJournal 写 capability-gap-opened，反绑首次 capability revision/reason，并在同 envelope 生成原渠道 Delivery 或第一方 notice；同一 occurrence 的连续 queued-gap 无论 poll 或 capability revision 如何变化都只更新耐久详情、不重复通知，只有成功 assigned 或进入终态才写 closed，之后再次回到 queued-gap 才是新一轮通知。live 与 server.info 必须从同一记录投影并按 revision 去重。验收覆盖批量 missed、重复 ready/poll、提交各边界崩溃、断线补读、能力反复刷新、成功恢复后再次缺口，通知不重不漏且文案只说明任务状态和可行动步骤。**修复证据：**R26-05 与 V26-01、V26-05～V26-06；反证 C26-05（关闭事实只进历史、live 发布落在不可达分支）已移至成功提交后的统一发布点并复核通过。 | 已验证 |
| U26-06 | **P2，工作量：大；来源 NB26-01，非阻断后置事项。** AuthorityCommitLog 目前只有 artifact GC，没有 TaskDefinition/JobJournal/Delivery 权威记录的 27 天物理压缩 owner；未发现当前交付规模下的空间耗尽、启动阻断或可感知性能损失，现状 append-only 安全且不造成数据错误。**价值裁决记录（2026-08-02）：**原结论仅因规格写有 27 天保留便将其判为 P1；对立复核未找到当前容量、启动或功能损失，且解决需新增通用日志代际、检查点与崩溃恢复基础设施，故撤销 P1 和本单元立即处理要求，改为 P2 后置。只有出现当前可复现的容量或启动损失，或通用 compaction owner 进入已定稿单元时才可重开；否则不得恢复为第 26 单元提交门禁。 | 27 天物理压缩属于跨权威日志的通用存储生命周期能力，不是第 26 单元 scheduler 核心闭包独有能力；当前没有事实证明立即实现的价值足以覆盖基础设施成本。 | 影响 TaskDefinition、JobJournal、Delivery 权威日志及未来磁盘/冷启动成本；当前生产功能、正确性与用户体验无已知损失。重开后才核对 generation/checkpoint、pending/uncertain 保留、崩溃恢复和有界维护；当前不新增 benchmark 或采集设施。相关 IR26-25、28、30 均按非阻断结论处理。 | 当前不修改实现；将“27 天物理压缩”后置为通用存储生命周期目标，继续保留 pending/uncertain 永不误删的安全现状。仅在通用 compaction owner 进入已定稿单元，或出现可复现的容量/启动损失时重开并重新定稿方案。 | 已验证 |

> **专项证据索引**：U26-01→R26-01/V26-01～02；U26-02→R26-02/V26-01～02；U26-03→R26-03/V26-01、V26-03；U26-04→R26-04/V26-01、V26-04；U26-05→R26-05/V26-01、V26-05～06；U26-06→R26-06/V26-05～06。本索引是本次专项收口的准确映射。

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
| V26-01 | 五项修复可构建，直接合同、权威状态、surface、ready、policy 与 notice 回归成立 | `pnpm build`；core facade、owner scheduler 四文件、server schedule/surface/server、CLI facade/setup-delivery、executor policy fence、tools schedule 定向 Vitest；Biome 变更文件 | 当前 104 路径闭包中的五项生产实现、直接测试与上游构建产物 | 专项受影响验证 / 中 / 构建 238.6 秒，定向测试约 120 秒 | 17/17 包构建通过；core 4、owner 108、server 46、CLI 26、executor 2、tools 4，合计 190/190；Biome 零问题。CLI 测试有一次工作区外临时目录清理警告，功能断言与退出码均通过 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 有效 |
| V26-02 | 专项矩阵与角色一：操作权威、surface 隔离及两者交界 | 从权威合同冷启动反推 tool/facade/RPC→GlobalState/JobControl 与 client id→surface generation→manual stream；构造缺 id、同键异载荷、旧 revision、双客户端、重连旧代、错绑反例 | R26-01、R26-02 全部登记输入与直接交界 | 专项功能审查 / 低 | C26-01、C26-02 同根残留修复后逐格通过；无第二生产写 owner、广播回退或公共 principal | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 有效 |
| V26-03 | 角色二：启动、恢复与停机拓扑 | 冷启动核对 prepare/runServer/activate 顺序，构造慢 handler/transport、坏单项、大量欠账、同任务多 assignment 与停机反例 | R26-03 全部登记输入及 R26-03↔R26-04 交界 | 专项功能审查 / 低 | C26-03 修复后，ready 前零执行/外发，activate 后 timer 与固定并发恢复独立推进，坏 assignment 不截断同任务后续义务 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 有效 |
| V26-04 | 角色三：调度策略的耐久并发与崩溃恢复 | 冷启动核对三类 policy 事实与 reducer/投影，构造提交前后崩溃、墙钟变化、重复恢复、auto-disable 半提交及手动/定时竞争 | R26-04 全部登记输入及 R26-04↔R26-05 交界 | 专项功能审查 / 低 | C26-04 修复后，冻结 next-fire 不重算、missed 有界、pending disable 阻断所有新触发并最终唯一 settled | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 有效 |
| V26-05 | 角色四：用户通知闭环与 U26-06 生命周期价值边界 | 冷启动核对 missed/gap 耐久 producer、Delivery、live/history；构造重复 ready/poll、断线、提交半途、关闭重开，并核对 U26-06 两项重开条件 | R26-05、U26-06 及 policy↔notice 交界 | 专项功能审查 / 低 | C26-05 修复后 notice 同源、不重不漏且可补读；U26-06 无当前容量/启动损失、无定稿 compaction owner，后置成立 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 有效 |
| V26-06 | 历轮反证差异审计 | 机械取专项矩阵与四路记录并集，逐项核对 C26-01～C26-05 | R26-01～R26-06 与 V26-02～V26-05 | 专项收口 / 低 | C26-01→U26-01、C26-02→U26-02、C26-03→U26-03、C26-04→U26-04、C26-05→U26-05，均为同根合并且已由当前源码与定向测试复核通过；零未处置发现 | `git-delivery-manifest-v1:65d8919906dce250a6769732b39f0adfa587b5d14625e08d2b470545b2e2ea6a` | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —          | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —          | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-26.gen-1 -->
