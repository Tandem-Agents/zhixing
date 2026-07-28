# 单元登记:第 24 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:24
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-07-28
- **登记来源**:用户要求将第 24 单元独立审查问题转入审查与修复工作台

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:问题裁决；U24-01/02/04 已完成稳定功能闭包，U24-07 仍有生产 job 执行链残留，待修复
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
| U24-07 | **P1，工作量：大（约 3～5 小时，不含最终验证）。** 已完成 `createLosslessDataPlaneComposition`、第一方/渠道 conversation 真实链、local/mesh transport、status hub、DeliveryOutbox、故障注入及六正两负场景骨架；但 job 场景仍由测试直接调用 `ledger.requestInteraction`、`writer.appendInteractionRequested`、手写 `deliverGrant`/`resolveNoInteractiveSurface`，并直接 `sealJobBundle`、`submitBundle` 构造终态。远程 job 的 grant 与无应答处理也直接进入本地 ledger/submission，没有经过真实 mesh client/handler。受影响审查项：IR24-01、14、15、22。 | **S6 没有提供从既有 job dispatch envelope 开始的 executor-owned 执行与交互接缝，测试只能绕过生产入口直接操纵 ledger、stream 和 submission。** 缺口属于第 24 单元的 job 数据面闭环；scheduler CRUD、定时触发、旧投递退役及产品切换仍由第 26 单元负责，不得提前实现。 | 已形成的 job dispatch 进入 executor 后的接收/启动、耐久交互 binding、stream、grant/无应答消费、usage、bundle 封装提交与恢复；local/mesh answer adapter、owner relay、JobJournal/status/result/DeliveryOutbox 及故障重驱。conversation 已闭合部分不得重做；scheduler 定义/触发、旧 DeliveryPipeline/queue 和第 26 单元产品装配明确排除。 | 在生产代码建立 executor-owned `JobAssignmentWorker`：只接收冻结的 job `DispatchEnvelope`/`JobExecutionInstruction` 和注入的 job runtime port，自身持有 assignment session，并负责接收/启动、耐久交互 binding、stream、usage、bundle 封装提交及恢复。仅把 `ConversationAssignmentWorker` 中已证明同构的底层生命周期原语抽为共享组件，conversation/job 的输入、终态和提交策略保持领域隔离。建立 job interaction answer port：local adapter 路由到活跃 session，mesh adapter 必须经过真实 client/handler；runtime 尚未恢复时返回类型化可重试 unavailable，禁止 owner 或测试直接操作 executor ledger。S6 组合根只暴露 worker 与 `JobRelayOpening` 的生产注册接缝，供既有 job dispatch/JobJournal 及第 26 单元后续接入，不连接 scheduler CRUD/trigger，也不切换或退役旧投递路径。conformance 从 job dispatch 接收入口与渠道 callback 驱动，fake 仅限外部 job runtime、渠道、时钟和密码学边界。验收：`s6-conformance.test.ts` 零直接调用 `requestInteraction`、`appendInteractionRequested`、`sealJobBundle`、`submitBundle`，零手写 `deliverGrant`/无应答终态；local/mesh 只替换 adapter，同一 worker 自然产生同 assignment/run 的连续 status、唯一 result 与唯一 DeliveryOutbox 项；prepared/cursor/ACK/send 中断重驱零跳失、零重复，跨域凭证与无合法应答者稳定拒绝/收敛；现役 scheduler/DeliveryPipeline 行为和生产路由保持不变。 | 待修复 |
| U24-08 | **P2，工作量：小（约 0.5 小时）。** Feishu `parseChallengeAction` 只检查必填字段，未拒绝 action 和 decision 的未知字段。受影响审查项：IR24-16。 | 渠道共用的 callback payload 没有唯一严格结构校验器，adapter 只能自行实现宽松解析。 | core callback DTO/validator、Feishu 映射、未知字段、decision 规范化与负例测试；token 的密码学与权威状态校验仍归 owner。 | 在 core 定义并导出渠道无关的 callback payload 严格结构校验器，精确限定 `{v,token,decision}` 与 `{allowed,reason?}`；Feishu 只负责把平台事件映射到该 DTO，原始事件留在独立 `raw`，owner 继续验 token 签名和 pending 状态。未知字段拒绝、合法回调及跨 adapter 同形通过即完成。**修复落地**：core 新增 `validateChannelChallengeCallback`（payload/decision/token 三层 exact-keys + reason 8KiB 上界；token 结构校验与 `validateChannelChallengeToken` 共用单一 `validateChallengeTokenStructure`，验签仍归 owner）；Feishu 删除手写解析改调该校验器，`raw` 独立保留。测试：core 校验器 3 用例（合法/未知字段×3/版本与越界 reason）、Feishu 15/15（含规范 token 正例与 payload/decision 未知字段负例）。**功能闭包已确认（2026-07-28）**：后续直接复用，不再重复功能审查；仅 callback DTO、严格校验器、token 结构或 adapter 映射变化时重开。 | 已验证 |

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
