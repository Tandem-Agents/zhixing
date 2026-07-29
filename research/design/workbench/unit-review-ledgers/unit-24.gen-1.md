# 单元登记:第 24 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:24
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-07-28
- **登记来源**:用户要求将第 24 单元独立审查问题转入审查与修复工作台

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:集中修复（U24-07、U24-09）
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否
- **交付物文件集**:待冻结终审前按当前工作区重新锁定
- **当前交付物指纹**:待冻结终审前按正式口径计算
- **架构来源**:`research/design/architecture/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/remote-confirmation-execution.md`、`research/design/modules/distributed-runtime/remote-interruption-execution.md`、第 24 单元开发清单及其上下游合同

## 固定边界

- **功能范围**:第 24 单元 S6 中继、渠道确认与最终性整合的生产实现、直接相关测试与规格补充
- **架构不变量**:直连/中继无损同构；确认与 grant 权威唯一且耐久幂等；状态、最终性及 outbox 可恢复；生产装配、资源治理、安全与兼容合同不弱化
- **验收条件**:独立审查 24 项全部通过；P0/P1 清零；同一冻结交付物完成两轮终审、独立功能审查及必要验证
- **必要上下游**:第 21～23 单元 stream/spool、ticket、surface asset、WAL/索引与容量治理；现役 Feishu、第一方确认、远程确认/中断及 DeliveryPipeline
- **明确不属于本单元**:第 25 单元 Environment/workscene；第 26 单元 scheduler CRUD、定时触发产品闭环及旧投递退役；第 27 单元及以后模块接入、本地域 owner、收编、迁居、备份、服务与发布

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |

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

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U24-01 | **P0，工作量：中。** 原实现把 direct/relay 都映射为锚点进程内同一 client，且流中网络错误不能触发路径切换。当前残留：远程 executor 的 direct 被固定判为不可用；本地 direct 与 relay 仍落到同一个 `ownerStreamClient`，owner-forward 只增加包装层，没有形成可独立失败的真实链路。受影响审查项：IR24-01、05、14、17、19。 | 路径选择和连接生命周期被错误放在 owner 进程；第一方 surface 没有成为 direct/relay 的唯一拨号与切换所有者，owner 只能给同一连接贴两个路径标签，无法产生真实独立故障面。 | 第一方 RPC/surface、executor 数据面端点、owner relay 端点、ticket/consumer/checkpoint/ACK、路径切换与断线恢复；渠道和 job 固定 owner 路径不参与双路径。 | 将 `AssignmentStreamPathManager` 下沉到已认证第一方 surface adapter：owner 经现有认证控制连接只下发 ticket、稳定 executor 身份和 relay 能力；surface 从既有受信 `MeshEndpointDescriptor`/设备目录解析 executor 端点，禁止另建地址事实源。direct 为 `surface→executor`，relay 为当前认证控制连接上的 `surface→owner→executor`；二者只共享 assignment、consumer、checkpoint、seq/digest 与 ACK。无 direct 能力返回类型化 unavailable，不得在 owner 内伪造。以两条真实连接的建连/流中故障、切换续订、授权不变及协议拒绝不降级验收。**修复落地**：已认证 surface session 独占路径管理器；本地 direct 使用 surface-principal 端点，relay 使用 owner-forward 端点，建连及流中传输失败统一映射为可降级错误并复用同一消费身份与水位；当前拓扑不具备远程 surface→executor 直连时明确返回 unavailable，禁止伪造。principal 与 ticket 在接收票据前反绑。定向路径用例 7/7，S6 双 adapter 路径与故障矩阵 4/4。**稳定功能闭包已确认（2026-07-29）**：后续直接复用，不再重复功能审查；仅 surface 路径所有权、direct/relay 端点、ticket/consumer 身份、切换水位或失败分类变化时重开。 | 已验证 |
| U24-02 | **P0，工作量：大。** 原实现没有 owner 作用域的 relay/challenge 长期所有者；job relay 无生产登记入口，callback 依赖活跃内存会话且以 fire-and-forget 处理。当前残留：`ChannelInteractionCoordinator.recover()` 只枚举 job opening；conversation 会话只在新请求执行时打开，重启后 pending challenge 不会重建路由；opening 还携带 executor 运行实例的进程内 `confirmationBroker`，该对象无法由 owner 耐久日志恢复。受影响审查项：IR24-01、03、07～10、14、16～19、21、24。 | conversation 的耐久义务、owner 调度投影与 executor 运行时所有权仍混在同一 session：owner 既缺可重建 opening，又错误持有 executor 私有 broker，导致 local/mesh callback 执行边界不一致且恢复结构上不可成立。 | conversation/job relay、challenge outbox、callback/grant、cursor/ACK、executor interaction broker、local/mesh adapter、重复回调、发送失败、owner/channel/executor 重启、状态 source 和跨域凭证。 | 冻结 executor-owned interaction answer port，由 local/mesh adapter 共同实现，`ConversationAssignmentWorker` 只是生产实现而非 owner 依赖；owner opening 仅保存可由 journal 重建的 assignment、ticket、ref 与 pending challenge 身份，callback 持 ticket 调该端口，由 executor 查找 broker。协议恢复先登记 opening，渠道就绪后协调器幂等重开路由/outbox；executor runtime 暂未恢复返回类型化可重试 unavailable，不得关闭耐久 challenge；仅 durable closed 或 assignment 终态注销。以 local/mesh 全等、prepared/send/callback/closed 各崩溃点、渠道晚就绪、runtime 重建与重复恢复验收。**修复落地**：已冻结 executor-owned answer port，并由本地 observer/远程 mesh client-handler 共用；owner opening 只含 journal 可重建身份，conversation 从 pending challenge 与活跃 ticket facts 幂等恢复，job 由稳定义务目录登记并恢复。answer 与无应答面解决在 runtime 未恢复时均返回类型化可重试 unavailable，pending challenge 不关闭；仅耐久终态释放。协调器、mesh 与恢复定向用例 11/11，S6 conversation/job 双 adapter 与负组合 6/6。**稳定功能闭包已确认（2026-07-29）**：后续直接复用，不再重复功能审查；仅 answer port、opening 耐久身份、challenge 恢复/关闭条件、local/mesh adapter 或义务目录变化时重开。 | 已验证 |
| U24-03 | **P0，工作量：小。** Feishu adapter 新增 `verificationToken`、`encryptKey` 启动必填项，但唯一配置 registry、编辑器校验和既有凭据迁移仍只声明 `appId`、`appSecret`。受影响审查项：IR24-09、14、16、20。 | 渠道配置 schema、UI 字段与 adapter 凭据要求存在多个来源，且缺少“基础消息可用/互动确认可用”的能力就绪状态。 | CLI 配置 schema/editor/check、凭据存储、adapter setup、能力声明、既有 Feishu 用户升级及回归测试；当前正常入口无法补齐必需凭据并导致整个 adapter 失效。 | 建立 Feishu 配置与能力声明单源，由 registry、编辑器、校验和 adapter 共用；callback 凭据只进 SecretStore。缺少无法自动迁移的凭据时保留基础消息能力，明确标记互动确认 degraded，禁止发送 challenge 并给出补录指引；凭据齐全后原子启用 callback。以新配置闭环、旧配置消息不回归、degraded fail-closed、秘密零回显验收。**修复落地**：`SUPPORTED_CHANNELS` 加 verificationToken/encryptKey（sensitive+`capabilityGroup:"interactive-confirmation"`），checkMessaging 按能力组裁决（全空=合法 degraded、半填=报缺失字段），编辑器行显示"选填·能力未启"；feishu `resolveConfig` 改成对可选 `interactiveConfirmation`（半配置显式抛错），adapter 的 `sendChallenge` 改按凭据挂载的实例能力——degraded 时 `isChallengeChannel` 如实为 false、不注册 callback 路由、warn 补录指引，宿主侧经既有 NonInteractiveChannelError fail-closed。测试：feishu 72/72（含 degraded 保消息、半配置拒）、CLI checks 18/18（含能力组半填/全填）。**功能闭包已确认（2026-07-28）**：后续直接复用，不再重复功能审查；仅配置字段、能力组裁决、SecretStore 边界或 adapter 能力挂载变化时重开。 | 已验证 |
| U24-04 | **P1，工作量：中。** 原实现的 `ExecutionFinalityProjection` 没有生产消费者，`JobStatusDirectory` 没有真实 source 且返回虚假空游标。当前残留：live notice 以 fire-and-forget 并发进入投影，projection 在异步 `onStatus` 成功前已删除 pending 并推进 revision，回调失败会留下不可补读的假水位；`ExecutionStatusHub` 按域重排 `next`，session 却按数组位置判断推进。受影响审查项：IR24-01、12、14、17、21、24。 | 三域权威 source 已接入，但 live/history/消费者确认没有统一的按 subject 串行交付事务；游标身份仍部分依赖位置而非稳定 subject key，零跳失合同尚未机械成立。 | conversation/job/delivery 权威 source，RPC/surface 历史补读与实时通知，异步/失败消费者、乱序并发、断线游标，conversation final、job result 及渠道投递隔离。 | 在 `FirstPartyFinalitySession` 建立覆盖 history/live 的单一串行入口；projection 仅在消费者成功后提交 revision 并删除 pending。失败时保持旧游标并向所属认证 RPC/surface 连接传播类型化 `resync-required`，终止该订阅或连接，强制携客户端 last-seen 重连；不得只静默关闭内部 session，也不得建立第二重试队列。服务端 session cursor 只代表成功入队，客户端 last-seen 才是恢复水位。cursor/next 全部按 `subjectKey` 对账并校验集合全等。以并发、拒绝回调、跨域乱序、补读/live 交界及失败重连验收。**修复落地**：history/live/status/final 全部进入一个 session 串行入口；projection 先等待消费者成功再推进 revision、删除 pending 或确认 final。失败保留旧水位并触发类型化 resync，RPC 所属连接以 1012 关闭；cursor 按稳定 subject key 对账并要求集合全等。移除架构外的 job-result 第二终态路径，job committed result 仍唯一进入冻结 DeliveryOutbox。core 投影 4/4；跨包会话用例待最终验证前先重建 core 产物再执行。**稳定功能闭包已确认（2026-07-29）**：后续直接复用，不再重复功能审查；仅 history/live 串行入口、消费者确认线性化点、subject-key 游标、resync 传播或终态所有权变化时重开。 | 已验证 |
| U24-05 | **P1，工作量：小。** job grant 使用 `D("ChannelInteractionDecision",1,{interactionRequestId,decision})`，冻结合同唯一口径为 `D("ConfirmationDecision",1,{requestId,decision})`。受影响审查项：IR24-02、16。 | 同一确认决定被引入第二套摘要域和字段命名。 | grant/token builders、validators、签名与审计消费者、wire codec、手写夹具和兼容测试；协议规范字节发生分叉。 | 删除第二套摘要语义，所有生产者和消费者复用冻结的 confirmation decision digest；需要字段适配时只在边界显式映射，不改变摘要对象。以规范向量、跨 adapter 全等及错域拒绝验收。**修复落地**：删除 `channelInteractionDecisionDigest`，新建唯一边界映射 `channelInteractionConfirmationDecision`（{allowed}→{kind:"allow-once"}、{allowed:false,reason?}→{kind:"deny",reason?}），executor ledger 与 core validator 统一改走 `confirmationDecisionDigest`；grep 全仓零残留。测试：channel-interaction 8/8（含摘要域全等向量）、executor job-assignment channel grant 定向 1/1。**功能闭包已确认（2026-07-28）**：后续直接复用，不再重复功能审查；仅确认决定结构、摘要域、边界映射或其生产/校验入口变化时重开。 | 已验证 |
| U24-06 | **P1，工作量：中。** 原 `ExecutorDataPlaneRuntime.maintain()` 在治理外全量枚举 spool 并执行退休、回收和物理删除。受影响审查项：IR24-18、20、24。 | 新维护入口没有稳定义务身份、唯一 owner、物理 I/O 分页游标和叶级容量准入。 | ticket/spool 发现、退休与删除，前台竞争、取消/背压/重启、遗留目录迁移和资源上界。 | `executor-data-plane` 以稳定 workKey 持有 ticket-retirement 与 stream-spool-reclaim；spool 为每个 assignment 耐久保存可校验 `identity.json`，遗留目录从日志身份一次回填。生产扫描复用持久 `opendir` 游标，每轮最多检查 32 个目录，发现页和每个 assignment 回收均经 storage runner；物理读写删在 assignment 串行段内、执行副作用前独立准入，不持 permit 等锁或网络，关闭时释放游标和 runner。分页、遗留回填、零旁路、40 项 32+8 续扫和关闭测试代码已补。**功能闭包已确认（2026-07-28）**：后续直接复用，不再重复功能审查；仅 spool 格式/扫描、维护 owner/workKey、storage runner 或物理副作用边界变化时重开。 | 已验证 |
| U24-07 | **P1，工作量：大。** 原问题为 S6 缺少从 job dispatch 开始的 executor-owned 生产执行链，测试绕过生产入口直操 ledger、stream 与 submission；主体接缝虽已落地，2026-07-29 独立功能核查仍确认七条确定失败时序：① `interaction-finished` 已耐久后，owner mirror 或 stream 投影失败会使 broker 回到等待态；grant 的 `replayed` 分支和无应答的既有 outcome 分支随后直接返回，不再推进 broker、mirror 与投影，job 必然卡死；若 broker 先到 expiry，还会用另一终态冲击已耐久结果并拒绝运行。② 存在 pending interaction 时，首次 owner cancel 只能写 abort 与 interaction-finished，因未 mirror 不能生成 cancel proof；若 owner 的两次即时尝试早于 mirror 完成，worker 完成清理后只轮询不存在的 proof，没有任何所有者继续重驱原 fence。③ job 无合法互动面时，owner 先取得 executor 的耐久终态再以“已有 mirror”接管 requested 帧，但随后接管 finished 帧却无条件要求存在 prepared challenge；合法的“无 challenge 终态”因此无法推进 relay cursor。④ executor 的数据面 ticket 服务固定把所有 execution 域交给 `ConversationAssignmentWorker`；手动 job 的 ticket 答复及 abort-ticket 因此会走 conversation envelope/interaction 路径并确定失败。⑤ `JobAssignmentWorker` 只由可选的 `MeshRuntimeAssembly.options.executor.job` 创建；默认 access-surface 与 executor-only 生产装配均未提供 `JobRuntimePort`，job worker、恢复与答复端口因此恒不创建。⑥ owner 已耐久写入 `channel-challenge-granted` 后若进程崩溃或转交 executor 失败，没有任何恢复枚举或 dispatcher 重驱该 grant；现有代码只依赖平台重投 callback，合法授权可能永久停在 owner 日志。⑦ owner-fence 的 `executor.cancel` 在通知 live worker 中止前便可能等待 usage intake 与 proof 生成；worker 正常收尾也先无限等待 usage final，再检查取消，而取消任务反向等待正常任务，导致停止信号、本地 mirror/stream 清理和 proof 前置义务被串在远端可用性之后。另有结构性反证：mirror 摘要链、mirror 水位与 stream 次序均为 assignment 级，按 `(assignmentId,requestId)` 分别串行仍会让并发交互提交相互冲突；started assignment 又被业务恢复枚举明确排除，崩溃后未完成的交互派生义务没有恢复入口。受影响审查项：IR24-01、14、15、21、22。 | 原始根因为缺少 executor-owned job 执行接缝；更深同根是**没有按 execution 域和耐久线性化点定义唯一收敛 owner，而把收敛义务实现成一次调用栈的后续步骤**：`interaction-finished` 只是业务裁决，不等于 assignment 级 mirror、stream、可选 broker 与 owner relay 投影均已完成；`channel-challenge-granted` 只是授权事实，不等于 executor 已消费；cancel-fence 只是取消义务事实，也不等于 runtime 已停止、usage 已收束、proof 已生成并被 owner 接受。当前既缺从耐久事实派生未完成步骤的唯一 reconciler，又把 request 级幂等身份误作 assignment 级有序投影的串行边界，并将 job ticket 操作误投 conversation worker、将 fence 重驱拆给 owner 与无 fence 的 worker，还把权威必需的 job 执行与恢复 owner 挂在可选 mesh 组件和可选配置上，正常路径之外便出现错域、短路、双 owner、无人 owner 或 owner 根本未创建。 | job dispatch 后的接收/启动；定时 job 的 challenge/grant 外发与 executor 转交、无应答和手动 job 的 surface-ticket 答复/abort；七类失败时序、竞态终态与 broker 完成；assignment 级 interaction mirror、stream 投影、relay cursor 与有/无 prepared challenge 两种消费；usage 终结与 bundle 提交；owner-fence、abort-ticket、runtime 中止、pending interaction/effect 清理、cancel proof 生成/提交/接受；executor-only、single-machine 与 anchor+executor 装配，local/mesh adapter、数据面操作路由、owner relay、executor/owner 重启及相关 conformance。conversation 已闭合部分、scheduler CRUD/trigger、旧 DeliveryPipeline/queue 与第 26 单元产品装配继续排除。 | 保留 executor-owned `JobAssignmentWorker` 与既有领域隔离，以**execution 域路由 + 耐久事实派生义务 + 每步唯一 owner**收口。① **终态裁决与 executor 收敛**：所有 ticket/grant 答复、无应答、expiry、cancel、backpressure 先经 assignment ledger 的单一 `settleInteraction` 事务“写入或读取”唯一 winner；按 `(assignmentId,requestId)` 只判终态幂等，按 `assignmentId` 单飞并依 recordSeq 推进 mirror/stream。任何凭证在读取或返回既有终态前都先完成对应票据或 grant 的验真与全反绑；只有无终态的 fresh 凭证再检查当前时效和 job 活跃性。已有 answered 终态与原凭证全等时即使现已过期也回放，异凭证稳定冲突；已有非 answered 终态是合法竞态 winner，不再授权。尚无终态且 deadline 已过时由 ledger reconciler 幂等写 expired；owner 已写 grant 但到达 executor 时已过期不得延长授权。终态写入即完成业务裁决，broker 通过不回调耐久写的投影口按 winner 收束；mirror/stream 由 worker 从 ledger 恢复的 must-complete 义务继续，暂时失败不得反馈成 broker“未决”或第二终态。退避间隔有上界但义务无尝试上限；稳定合同冲突 fail-stop、保留可诊断义务，禁止静默丢弃。`bundle_sealed`、`execution-failed`、`halted`、stream final 与 cancel proof 均须先确认该 assignment 的 interaction reconciler 无欠账；暂时或稳定收敛失败只能保持未终结并上报，禁止失败分支越过欠账写终态。live accept、答复重放与 run-end/cancel 只唤醒同一 assignment reconciler；另增独立于业务重执行的 ledger 派生恢复枚举，覆盖所有尚未退休且存在 interaction 事实或 mirror/stream 落后证据的 job assignment（包括 started），但不得复用当前 `readAll()` 全历史扫描。assignment 日志提交是唯一线性化点；欠账索引只是可丢弃加速器，增量批次先应用再推进绑定 `{logId,lsn,prefixDigest}` 的源 checkpoint，崩溃在日志/索引/checkpoint 任意两步之间时分别以有界尾部重放或幂等重放补齐，checkpoint 禁止领先日志。索引缺失、落后、超前或校验失配时必须从 assignment 日志完整重建且与增量结果全等，重建完成前 fail-closed、不得把“空索引”解释为零欠账；正常启动按页读取未完成 assignment 并只追有界尾部。从耐久 envelope 重建仅含 submission/stream 的投影 binding，以 ledger mirror 水位和 spool 的稳定 `interaction:<recordSeq>` sourceId 集合/无孔前缀判缺，幂等补齐后从索引移除，绝不重跑 started runtime、不得形成第二事实；无 runtime 时不得新授权。② **owner relay 与 grant outbox**：owner 渠道协调器唯一持有 relay 投影；mirror 投影从已验签 batch 保存 `requestId → 规范终态种类/finished outcome`，不得用 requestId 集合冒充终态证明，该映射只由耐久 mirror 重建。prepared challenge 的 finished 原子写 closed+cursor；无 prepared 时，仅当映射证明同 request 的 winner 为 auto-resolved/expired/cancelled 等非 answered 终态且与 finished frame 全等，requested 与 finished 才可只推进 cursor，answered 仍必须绑定 prepared。`channel-challenge-granted` 本身同时是 owner→executor 转交 outbox 的唯一耐久源；按 challenge/assignment 单飞枚举“已有 grant、尚无同 request 终态 mirror”的义务并重驱 `deliverGrant`，平台 callback 返回不算完成。只有 matching answered mirror 或合法竞态 winner 的 mirror 才关闭该义务；错 grant/错终态 fail-stop。进程在 grant fsync、转交请求/响应任一侧崩溃均从 owner 日志恢复。③ **取消收敛分源定主**：`executor.cancel`/abort-ticket 入口只需耐久写取消前缀并立即唤醒 live worker，不得在发出停止信号前等待 mirror、usage intake 或 proof；executor assignment reconciler 先中止 runtime，再从 ledger 独立推进 interaction/effect 清理、mirror/stream、耐久 usage report/final 与 proof。usage 是 proof 的显式前置义务，但远端 intake 不得阻止本地停止和可独立完成的清理。owner-fence 控制面由 owner dispatcher 以 JobJournal pending fence 为耐久 outbox，按 assignment/fence 单飞、封顶退避执行同 fence `executor.cancel → 查询/提交已生成 proof → owner 接受`，每轮重读 journal直至接受或另一合法 owner 终态关闭；worker 不轮询/提交 owner-fence。abort-ticket 则由 Job worker 独占 proof 生成、提交与恢复；两个来源竞争时复用账本最先耐久的唯一 proof，不生成第二终态。④ **生产装配**：在所有启用 job execution 的生产拓扑，由必然创建的 executor role 组合根提供产品 `JobRuntimePort` 并持有 `JobAssignmentWorker`、interaction/cancellation reconciler 与恢复生命周期；mesh/access-surface 只注册 adapter，禁止成为唯一 owner。唯一数据面 operations router 按已验证 ticket 或耐久 assignment binding 的 `execution` 判别路由：conversation 只进 Conversation worker，job 只进 Job worker，禁止按当前活跃对象试探；能力闭环前不得注册或宣告 job execution，incoming job 必须在耐久 accept 前类型化拒绝。Job worker 实现 surface-ticket 答复与 abort-ticket，复用同一 ledger 鉴权、reconciler 和取消半边；定时 job 只接受 channel grant。机械验收：覆盖七条失败时序；在 grant fsync/转交、terminal、mirror、stream、relay cursor、usage final、proof、owner accept 及索引批次/checkpoint 各边界前后注错并重启；grant 无平台重投仍会转交或由合法竞态 winner 关闭，过期 grant 不越权；索引全量重建与增量结果全等，缺失/损坏期间零漏枚举，十万历史 assignment 下正常恢复只读 checkpoint 与有界尾部；started 在 terminal 后、mirror/stream 前崩溃零业务重执行；取消前缀耐久后立即停止 runtime，usage intake 不可用时本地可完成义务仍推进且 proof 保持待办；收敛失败不得写 stream final/execution-failed；ticket/grant/无应答与 expiry/cancel 竞态只产生一个 winner，非法凭证即使已有非 answered 终态也拒；broker 不回第二终态；并发 request 保持 assignment 级顺序；无 challenge 的非 answered 帧只推进 cursor，answered 缺 prepared 必拒；mirror 延迟跨任意次 owner-fence 尝试后仍接受同一 proof；executor-only、single-machine、anchor+executor 均存在唯一 job owner，手动 job 的 ticket 答复/abort local 与 mesh 全等且错域拒绝，定时 job grant 路径不回归；零第二事实、零永久等待。 | 修复中 |
| U24-08 | **P2，工作量：小（约 0.5 小时）。** Feishu `parseChallengeAction` 只检查必填字段，未拒绝 action 和 decision 的未知字段。受影响审查项：IR24-16。 | 渠道共用的 callback payload 没有唯一严格结构校验器，adapter 只能自行实现宽松解析。 | core callback DTO/validator、Feishu 映射、未知字段、decision 规范化与负例测试；token 的密码学与权威状态校验仍归 owner。 | 在 core 定义并导出渠道无关的 callback payload 严格结构校验器，精确限定 `{v,token,decision}` 与 `{allowed,reason?}`；Feishu 只负责把平台事件映射到该 DTO，原始事件留在独立 `raw`，owner 继续验 token 签名和 pending 状态。未知字段拒绝、合法回调及跨 adapter 同形通过即完成。**修复落地**：core 新增 `validateChannelChallengeCallback`（payload/decision/token 三层 exact-keys + reason 8KiB 上界；token 结构校验与 `validateChannelChallengeToken` 共用单一 `validateChallengeTokenStructure`，验签仍归 owner）；Feishu 删除手写解析改调该校验器，`raw` 独立保留。测试：core 校验器 3 用例（合法/未知字段×3/版本与越界 reason）、Feishu 15/15（含规范 token 正例与 payload/decision 未知字段负例）。**功能闭包已确认（2026-07-28）**：后续直接复用，不再重复功能审查；仅 callback DTO、严格校验器、token 结构或 adapter 映射变化时重开。 | 已验证 |
| U24-09 | **P1，工作量：中。** executor 结构性包测确认行为矩阵未覆盖新增渠道生命周期记录：conversation 缺 `channel-challenge-prepared/delivered/closed`，job 缺上述三类及 `channel-relay-cursor`、`channel-challenge-granted`；运行时全量键集合对账因此确定失败。进一步反查发现，前四类都有现成真实生产者与恢复消费者，而 `channel-challenge-granted` 无法给出“不适用”依据：它在 owner 日志耐久后仍有必须完成的 executor 转交，现有实现没有恢复 owner，此功能缺口归 U24-07。受影响审查项：IR24-22、24。 | 冻结记录 schema 新增类型时，没有同步维护“记录类型→真实产生场景→实际 full/guard 消费者→恢复行为→对抗向量”的穷举矩阵；测试文件又不在包类型检查输入中，构建无法替代该结构门禁。矩阵缺格不仅丢失结构证据，还掩盖了 `channel-challenge-granted` 的真实恢复义务。 | conversation/job journal 的八个缺失矩阵项、真实生产场景、full/guard replay、challenge outbox、job relay cursor 与 grant 转交恢复、损坏向量拒绝及 executor 包门禁；U24-02 的既有功能结论不重开，grant 恢复功能由 U24-07 承载，本问题负责把它纳入不可遗漏的结构门禁。 | 在两个既有 behavior matrix 中补齐八类：conversation 与 job 的 prepared/delivered/closed 均由真实 challenge 生命周期场景产生，并以重启后的 `pendingChannelChallenges`/`ChannelChallengeOutbox` 状态迁移作恢复 probe；job cursor 由真实 relay adoption 产生，以重启后的 `channelRelayCheckpoint`/续订水位作恢复 probe；job granted 由真实 callback grant 产生，并绑定 U24-07 新增的 grant-delivery outbox 恢复 probe，禁止标 N/A。每类同时经实际 full/guard replay，并提供改变身份绑定、顺序、水位或签名摘要的有效 corruption vector；禁止直接 append 伪造生产覆盖、只改期望或放宽全集断言。运行时 schema 键集合全等、真实生产、合法重放、恢复消费与对抗拒绝全部通过，executor 包门禁恢复全绿即完成。 | 修复中 |

> **U24-07 取消分支补充约束（属于该问题的解决方案与验收条件）**：executor reconciler 只可为 runtime/observer 已提供可验证结果的 effect 写入 `side-effect-completed`；崩溃后结果未知的开放外部 effect 必须原样保留为账本证据，禁止推定为 `aborted`，也禁止据此生成 `halted` 或 cancel proof。owner 恢复发现已验真的 abort-ticket 取消前缀而尚无可接受 proof 时，以 `assignmentId + ticketDigest` 为稳定幂等键，在写入 `uncertain(cause:"job-cancel-unknown")` 的同一耐久事务中建立唯一 `interaction-settlement-fence`，绑定已验证 ledger 前缀及其目标 mirror 水位；该记录是 audit-only 收敛义务，不进入 cancellation dispatcher，不作为 `CancelProof(owner-fence)` 的来源，也不产生第二取消结果或 proof。统一 mirror 授权谓词只接受两类耐久依据：正常 owner cancel-fence，或本记录；后二者都只开放绑定 assignment 的连续 mirror/stream 推进，禁止恢复 started、bundle、session、resource 或其他活动写权。用户裁决可以关闭业务 uncertainty，但不得删除该义务或使旧 assignment 失去 audit-only 提交资格；executor reconciler 继续补齐确定的 mirror/stream 欠账，owner mirror 达到记录水位且 executor 本地连续前缀均已耐久后写唯一 `interaction-settlement-completed` 并退休义务。未知 effect 继续保留证据并沿既有用户裁决流程终结。“零永久等待”仅指可确定义务最终完成或进入明确的 `uncertain`，不允许以伪造成功换取收敛。验收须覆盖：abort-ticket 前缀与 `interaction-finished` 已耐久、mirror 未提交且存在开放 effect 时 owner 重启；open 与 uncertain 原子且重启/重放只产生一个义务；该义务不出现在取消 outbox、不能生成 proof；用户裁决发生在 mirror 前后及旧 assignment 被新 assignment 取代后，audit-only mirror 仍按同一水位幂等完成而所有活动写稳定拒绝；水位完成只关闭一次；开放 effect 零伪造 completed/proof，迟到可验证结果与用户裁决按既有状态机幂等收束。

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |
| L24-01 | U24-07；根因与方案闭合复核 2/2 后发现 | 只核对 owner 的业务职责与 adapter 全等，未逐拓扑证明该 owner 在所有适用生产组合根中必然创建。 | 对每个权威或 must-complete owner，枚举 executor-only、single-machine、anchor+executor 及可选组件关闭形态；从组合根反查实例创建、启动、恢复、关闭和能力宣告，owner 仅由可选 mesh/channel/surface 持有即判未闭合。 | 补充复核：`JobAssignmentWorker` 仅由可选 `MeshRuntimeAssembly.options.executor.job` 创建，已重开并归入 U24-07。 |
| L24-02 | U24-07；根因与方案闭合复核 2/2 后发现 | 把“可重建派生索引”当作充分结论，未逐崩溃点定义权威日志、索引与 source checkpoint 的写序及落后自愈。 | 凡方案新增耐久派生索引，必须明确唯一事实源、source checkpoint 身份、日志/索引/checkpoint 三步崩溃矩阵、落后/超前/损坏判定、全量重建等价及重建期间 fail-closed；否则方案不得闭合。 | 补充复核：U24-07 欠账索引已加入写序、checkpoint、尾部重放、全量重建与零漏枚举验收。 |
| L24-03 | U24-09；U24-02 已标稳定闭包后发现 | 新增冻结记录类型时只审生产与 reducer，遗漏执行点行为矩阵，且包类型检查不包含测试文件，导致红色结构门禁未被构建暴露。 | 任何 record/schema 枚举变化都必须机械对账其行为矩阵、真实生产场景、full/guard 消费、恢复分类和 corruption vector；执行对应结构测试，不以类型检查或构建代替。 | 补充核查：conversation 差三类、job 差五类记录，已登记 U24-09。 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-24.gen-1 -->
