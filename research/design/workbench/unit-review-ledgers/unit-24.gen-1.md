# 单元登记:第 24 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:24
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-07-28
- **登记来源**:用户要求将第 24 单元独立审查问题转入审查与修复工作台

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:独立审查完成，问题清单已收敛；7 个 P0/P1 与 1 个 P2 问题待修复
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否
- **交付物文件集**:68 个单元功能文件（Feishu 6、CLI 27、core 16、executor 4、owner-kernel 10、server 4、规格 1）；待集中修复后重新锁定
- **当前交付物指纹**:待集中修复完成后计算
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
| U24-01 | **P0，工作量：中。** `lossless-data-plane-runtime.ts` 的 direct/relay connector 均返回同一 local/mesh client；连接阶段不触碰传输，后续网络异常也不会转换为路径不可用错误。受影响审查项：IR24-01、05、14、17、19。 | 把架构要求的两条数据面拓扑（surface→executor 直连、surface→owner/anchor→executor 中继）误建模为锚点进程内同一 mesh client 的两个标签；mesh 的 direct/blind-relay 只是下层连接传输，不能替代数据面拓扑，第一方 surface 因而没有真实路径所有者。 | 第一方 RPC/surface 会话、executor 数据面入口、owner/anchor 中继、渠道与 job owner-relay 的固定路径、mesh 信任与连接复用、subscribe/ACK/ref read、断线/旧 epoch/路径切换及故障测试。 | 保留单一 stream 合同，仅在第一方 surface 会话设置路径管理器：direct adapter 以既有配对信任直连 executor，relay adapter 经当前 owner/anchor 中继到同一 executor；两者复用 assignment、consumer、checkpoint、seq、digest 与 ACK 水位。渠道宿主和 job owner-relay 固定走 owner/anchor 路径，不伪造双路径；mesh 控制面只负责各 adapter 下层连接的 direct/blind-relay 建连与重连。以真实直连、直连失败转中继、恢复后回直连、跨代迟到帧拒绝、授权不变及零丢零重验收。 | 待修复 |
| U24-02 | **P0，工作量：大。** `createJobOwnerRelay` 无生产调用；job 无 outbox、callback 与关闭 owner，conversation 义务依附临时内存 session，重启不重建；callback 以 fire-and-forget 进入仅含活跃 session 的 map。受影响审查项：IR24-01、03、07～10、14、16～19、21、24。 | 缺少以耐久 prepared/cursor/granted/closed 为事实源、跨会话和重启长期存在的 relay/challenge 义务所有者；共享生命周期机制与 conversation/job 领域授权也未分层。 | job/conversation relay、prepared→delivered→closed、callback/grant、cursor/ACK、owner 重启、重复回调、失败重驱、全局扫描与退避上界及生产组合测试；耐久义务当前可能无人消费。 | 在 owner 作用域建立唯一长期生产所有者，以共享生命周期内核承载调度和恢复，以 conversation/job 两个 adapter 保持各自记录、授权与终态；启动时从权威日志分页恢复开放义务，退避/游标仅作可重建投影。callback 改为可等待，平台只在耐久裁决完成后成功响应，同键回放原结果。以重启、重复 callback、发送/ACK 丢失、两域凭证隔离及全链最终收敛验收。 | 待修复 |
| U24-03 | **P0，工作量：小。** Feishu adapter 新增 `verificationToken`、`encryptKey` 启动必填项，但唯一配置 registry、编辑器校验和既有凭据迁移仍只声明 `appId`、`appSecret`。受影响审查项：IR24-09、14、16、20。 | 渠道配置 schema、UI 字段与 adapter 凭据要求存在多个来源，且缺少“基础消息可用/互动确认可用”的能力就绪状态。 | CLI 配置 schema/editor/check、凭据存储、adapter setup、能力声明、既有 Feishu 用户升级及回归测试；当前正常入口无法补齐必需凭据并导致整个 adapter 失效。 | 建立 Feishu 配置与能力声明单源，由 registry、编辑器、校验和 adapter 共用；callback 凭据只进 SecretStore。缺少无法自动迁移的凭据时保留基础消息能力，明确标记互动确认 degraded，禁止发送 challenge 并给出补录指引；凭据齐全后原子启用 callback。以新配置闭环、旧配置消息不回归、degraded fail-closed、秘密零回显验收。 | 待修复 |
| U24-04 | **P1，工作量：中。** `ExecutionFinalityProjection` 只有测试消费者；`JobStatusDirectory` 没有生产 source，`statusHistory()` 固定返回空 `next`。受影响审查项：IR24-01、12、14、21、24。 | 状态/最终性只交付了内存算法和目录外壳，没有定义权威 source、第一方消费会话生命周期及 live↔history 游标交接的生产所有权；第一方状态合并与渠道投递边界也未分层。 | conversation/job/delivery 权威 source，第一方 RPC/surface 的 live/history/final 合并与游标，渠道 DeliveryAuthority/DeliveryOutbox 的来源白名单和唯一投递，CLI/server 装配、乱序/断线/重启及 adapter 测试。 | 在组合根登记 conversation/job/delivery 的权威 live/history source；每个已认证第一方 RPC/surface 会话按调用方 last-seen cursor 建立 finality projection：先恢复 live 订阅并缓冲通知，再按权威 revision 水位分页补读历史，最后按 revision 合并缓冲事件并转入实时消费，持续返回三域真实 next cursor，断线后从游标重建。渠道不创建该投影，状态与结果仍只由 DeliveryAuthority/DeliveryOutbox 按原来源白名单投递；projection 只缓存合并状态，不写权威事实。以补读与订阅交界零遗漏、实时/补读等价、乱序去重、断线续读、conversation 转正、job result 唯一投递及零跨渠道广播验收。 | 待修复 |
| U24-05 | **P1，工作量：小。** job grant 使用 `D("ChannelInteractionDecision",1,{interactionRequestId,decision})`，冻结合同唯一口径为 `D("ConfirmationDecision",1,{requestId,decision})`。受影响审查项：IR24-02、16。 | 同一确认决定被引入第二套摘要域和字段命名。 | grant/token builders、validators、签名与审计消费者、wire codec、手写夹具和兼容测试；协议规范字节发生分叉。 | 删除第二套摘要语义，所有生产者和消费者复用冻结的 confirmation decision digest；需要字段适配时只在边界显式映射，不改变摘要对象。以规范向量、跨 adapter 全等及错域拒绝验收。 | 待修复 |
| U24-06 | **P1，工作量：中。** `ExecutorDataPlaneRuntime.maintain()` 直接枚举 spool 并执行 ticket 维护、回收和物理删除，未接入 storage maintenance/capacity governor。受影响审查项：IR24-18、20、24。 | 新维护入口绕过第 23 单元冻结的设备容量准入与有界任务所有权。 | ticket/spool 扫描、退休与删除、前台执行竞争、取消/背压/重启、X23-11 重开条件及资源测试。 | 为维护义务建立稳定 workKey 和唯一 owner，分页选择有界批次；每个叶级物理步骤在锁内副作用前独立准入，禁止持 permit 等锁或网络，背压在段外续跑。以零旁路、固定单轮上界、取消重驱及前台不被后台拖垮验收。 | 待修复 |
| U24-07 | **P1，工作量：中。** D24-10 要求的共享 conformance、六条生产组合、两条负组合及 prepared/cursor/ACK/send 故障矩阵不存在，现有新增测试均为分散组件用例。受影响审查项：IR24-01、14、15、22。 | 测试只验证局部组件，没有以同一套件证明真实 adapter 与完整生产组合同构。 | in-process/mesh、direct/relay、conversation/job、第一方/渠道、状态/最终性及其拒绝与故障恢复证据。 | 建立单一参数化 conformance harness，分别驱动真实 in-process 和 mesh client/handler，并覆盖冻结的六正两负组合及故障矩阵；共同 fake 仅作依赖，不得替代生产入口。全部组合给出可比较状态与外部事件并通过变异验证。 | 待修复 |
| U24-08 | **P2，工作量：小（约 0.5 小时）。** Feishu `parseChallengeAction` 只检查必填字段，未拒绝 action 和 decision 的未知字段。受影响审查项：IR24-16。 | 渠道共用的 callback payload 没有唯一严格结构校验器，adapter 只能自行实现宽松解析。 | core callback DTO/validator、Feishu 映射、未知字段、decision 规范化与负例测试；token 的密码学与权威状态校验仍归 owner。 | 在 core 定义并导出渠道无关的 callback payload 严格结构校验器，精确限定 `{v,token,decision}` 与 `{allowed,reason?}`；Feishu 只负责把平台事件映射到该 DTO，原始事件留在独立 `raw`，owner 继续验 token 签名和 pending 状态。未知字段拒绝、合法回调及跨 adapter 同形通过即完成。 | 待修复 |

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
