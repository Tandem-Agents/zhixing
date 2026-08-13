# 单元登记:第 37 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:37
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-12
- **登记来源**:用户要求将第 37 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U37-01（P0/大）与U37-08（P1/中）已在同一专项冻结指纹上完成实现、最小必要验证、F37-37～F37-46逐格核销及四路冷启动对抗复审，状态均为已验证；受本轮生产实现、公共合同与直接测试影响的21个独立审查节点已统一转为 `[~]` 且旧证据作废，等待独立重审。U37-02～U37-07既有结论未被触发；未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅冻结U37-01/U37-08专项交付物用于本轮功能与对抗复审；不代表全单元封版）
- **交付物文件集**:41个Unit37生产、公共合同、直接测试、S7与分布式运行时架构/规格文件；过程账本与独立审查清单不计入交付指纹
- **当前交付物指纹**:`sha256:19b53f98573093b904694fdb9680af0a99d5af75d4bc34bae0ad05e5c3bacde5`（U37-01/U37-08修复后专项冻结指纹）
- **架构来源**:`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`，以及已定稿开发清单 D37-01～D37-09

## 固定边界

- **功能范围**:S10 三路径停机、设备移除与值班设备永久卸载；实现临时停机三策略、executor reachable/lost removal 与 anchor migration/backup uninstall，并按阶段安全收束本地权威、accepted work、身份、秘密、supervisor 与 cleanup
- **架构不变量**:三路径只写既有 `AuthorityCommitLog` 的 `device-lifecycle` 流；同 home+subject 单飞、严格前滚与不可逆边界、terminal不回退；移除前先收束本地权威/工作，卸载前先完成迁居或真可恢复备份；禁止强杀、第二事实源和先撤身份后发现权威
- **验收条件**:stop/removal/uninstall 正常、边界、故障、恢复和对抗路径唯一收敛；accepted-work、trust/exposure、checkpoint、supervisor、SecretStore、cleanup与pre-runtime non-resurrection均有真实生产证据，公开体验有限、诚实且零内部拓扑信息
- **必要上下游**:只复用第 30～32 单元本地域owner/DeferredGlobalIntent/AuthorityTransfer，第 33～35 单元checkpoint、planned/disaster transfer、current-owner/trust/exposure与资源治理，以及第36单元supervisor双事实与graceful/exact-stop合同
- **明确不属于本单元**:第38单元升级/兼容/原子替换/回滚/发布矩阵；自动failover、全局或持续同步、恢复应用、多active anchor、通用lifecycle/IPC/router/registry、监控、诊断、benchmark、信息采集和新runner

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
| U37-01 | **P0/大，同根再次重开。** `DeliveryAuthority.#lifecycleAdmission/sealed` 仍是易失态：stop 只在 `gate-closed` 重新调用 `onAcceptedWorkFrozen`，`work-settled/flushed` 重放不会恢复 sealed；target removal 与 backup 的恢复更晚，migration 只停 transport。实际可调度的 advancement recovery 又早于 stop lifecycle 恢复。七类 producer 的 `DeliveryLifecycleSourceRef` 只携 `owner+id`，authority 以冻结许可代填 revision；local assignment 与 remote `relay:/local:` 还会去前缀后合并到同一 source key，调用方无法证明自己就是 artifact 冻结的 generation。**历史价值裁决沿革：** frozen identity、executor-only、exact-host、七类 source companion 与 transport 三策略的既有结论只在原专项输入内保留；C37-C07～C37-C15 的已修复事实不被恢复。**本轮价值裁决记录：**原结论把 scheduler 准备和 journal-maintenance 启动本身也作为问题证据；反方复核确认这些步骤单独不足以证明副作用，故只保留实际 advancement recovery、易失 admission/phase 重放、revision 代填与 migration 旁路四条生产证据。保持现状、改文字或仅停 transport 都不能阻止 fresh/successor append 与破坏性前滚，P0/大及最小方案成立。修复后仅在 barrier 后 fresh/冲突 source 可 append、任一 active phase 不能在 producer 恢复前重建 exact admission/sealed，或 migration/backup 再绕开共同闭包时重开。最终结论：改写并保留；用户体验达标、架构达标。 | producer admission、sealed phase、source exact generation 与 transport quiesce 没有由同一 durable operation/artifact/phase 投影；source transaction 未提交自己的 exact revision，startup 也未建立“先恢复 lifecycle gate、后恢复实际 producer”的全局顺序。 | **生产端：**七类 canonical source transaction、`OwnerDeliveryParticipant`/`DeliveryAuthority`、scheduler/advancement 恢复、stop、两类 target removal、migration 与 backup。**组合：**`gate-closed/work-settled/flushed` 及 removal/uninstall 对应 phase，fresh/frozen/same-id successor，local/remote assignment 双投影，三策略×三形态，enqueue/attempt/read-back/ready、效果/响应丢失与连续重启。**消费者：**`ready-to-stop`、`authority-settled/revocation-ready`、`transfer-committed`、final checkpoint、cleanup 与公开退出结果。**异常终态：**重启窗口放入 fresh/successor delivery、causal delivery 漏收或错绑、drain/cancel 谎报收束，或 migration/backup 在集合未共同封闭时不可逆前滚。**受影响审查项：**IR37-01、IR37-05、IR37-08～IR37-10、IR37-12、IR37-15～IR37-18、IR37-20、IR37-28、IR37-30～IR37-32、IR37-34～IR37-36、IR37-40。 | 只复用现有 operation、accepted-work artifact、phase 与 `DeliveryAuthority.coordinate()`：把 `DeliveryLifecycleSourceRef` 收紧为调用方提交的 exact `owner/id/revision`，七个 producer 从同一 source transaction 的 durable companion 取 revision；local/relay assignment 保留各自稳定命名空间，authority 只全等核验，不再代填。新增一个由既有 journal+artifact 计算的恢复入口：尚未形成 accepted-work artifact 的 `accepted/gate-frozen/checkpoint-verified` 等前置 phase 只恢复全部上游 gate 为关闭并禁止 producer 启动；artifact 已形成后，stop `gate-closed`、removal `authority-decided`、migration `gate-frozen`、backup `retirement-decided/gate-closed` 恢复 exact unsealed admission，达到各自 `work-settled/authority-settled/transfer-committed` 及以后只能恢复 sealed。公开 producer、advancement、scheduler、assignment/channel 恢复前先完成该入口。migration 在 `transfer-committed` 前复用同一 accepted-work artifact/ports 完成 source+delivery read-back，不新增 phase或 journal。验收逐相覆盖七 producer、双 assignment、same-id successor、各 phase、两 target 根、三策略、migration/backup、响应丢失与连续重启，证明前置phase零producer、fresh/错revision零父envelope append、冻结source的current/late delivery恰一归集、sealed历史不重开；不得新增source registry、第二事实源或通用lifecycle。 **修复后证据：**startup 已在任何 producer recovery/start/listen 前从本机 authority journal、accepted-work artifact 与当前 phase 恢复 exact admission/sealed；七类 producer 由调用方 durable companion 提交 `owner/id/revision`，local/relay 命名空间不折叠；migration 在 `transfer-committed` 前复用同一 artifact/ports 完成 source+delivery closure。F37-37～F37-42、C37-C16及四路专项复审在冻结指纹上通过。 | 已验证 |
| U37-02 | **P1/小，同根重开。** target journal 已让 signed abort 与 ready 耐久互斥；但 `journal.abort()` sync 后、local/external gate release 或 `target-aborted` peer-effect 前崩溃时，`restoreLocalAdmissionGate()` 会跳过 aborted operation，重放又无条件调用要求当前 operation 的 `releaseDeviceRemovalFreeze()`，无 gate 会抛错，错误 gate 还缺少统一的防误释放语义。**价值裁决记录：**原 U37-02 的 ready/revoke/cleanup-ready/terminal-only/lost 主链继续有效，跨根 requestId 同一性仍不恢复；C37-C04 只重开 abort 后恢复。该窗口可让 issuer guard 永久阻断后续迁居/撤销且连续重启不自愈，P2 不足；只收紧既有 release 与 receipt replay，故保留 P1/小。 | durable aborted 是胜负唯一事实，却未同时成为 gate release 的幂等授权与 signed aborted receipt 的确定性重放起点；恢复错误地要求易失 gate 对象仍存在。 | **生产端**：两 target 根的 target journal、local/external gate、aborted receipt artifact/peer-effect、issuer guard 与 terminal-only 重投。**类型组合**：abort sync 前后、gate 为同 operation/不存在/其他 operation、release/receipt 各效果与响应窗、abort/ready 竞争、同/异 identity 与连续重启。**消费者**：target 准入、issuer selector/current-authority guard、后续 removal/migration。**异常终态**：target 已 durable aborted 而 issuer 永久等待 authenticated terminal，或迟到旧 abort 误开新 gate。**审查/测试**：IR37-19、IR37-32、IR37-36、IR37-38、IR37-40；真实双根日志、gate 与 mesh receipt 重放。 | 仅以完整 identity 的 durable aborted 授权现有 release：gate 属同 operation 则释放并 read-back，已不存在视为该效果完成，属其他 operation 必须零副作用拒绝；local 与 external gate 使用同一判定。随后优先 hydrate 已有 `target-aborted` peer-effect；不存在时只从 durable identity+signed abort 确定性重建同一 signed receipt、耐久 peer-effect 后返回，issuer 收到它才释放 guard。ready 已赢仍返回原 ready，不改其余跨端主链。验收穿过真实两根 `AuthorityCommitLog` 与认证 mesh，逐窗注入效果/响应丢失、错误 operation、竞争和连续重启，证明 release 恰一、错 gate 零误开且 authenticated terminal exact replay。**修复后证据：**durable aborted replay 先对 local/external gate执行同 operation 幂等 release，再返回已有 signed receipt；无 gate 视为已完成，错 operation fail-closed，direct fault test 覆盖 receipt 已存在仍先 release。F37-25/F37-26 在当前指纹复核通过。 | 已验证 |
| U37-03 | **P0/中，同根重开。** durable removal decision 已冻结 conversation 与十类 `ownerItems(id,revision)`，但 `ExecutorRemovalTarget.decide()` 只把 `operationId` 交给 external settlement，把 conversation ids 交给 local aggregate assertion；`settleAcceptedWork()` 与 `assertDeviceRemovalSettled()` 都不消费 decision ownerItems，DeferredGlobalIntent、final/delivery outbox、remote/channel/scheduler/delivery、lease/permit 的 frozen revision 可在未逐项终结时越过 `authority-settled`。**价值裁决记录：**effect-free preflight、artifact decision、漂移重显与 C37-C01 lifecycle completion 保持已闭合，广义 manifest 仍排除；C37-C03 满足“既有 frozen closure 未被消费”的重开条件。该断链位于不可逆 ready/revoke 前并可截断真实 accepted work，只扩既有 settlement/readers 即可，故保留 P0/中。 | decision artifact 与 owner settlement 之间没有必填的 exact-set 合同；生产链在效果阶段重新读取聚合状态，无法证明处理的是用户确认且耐久冻结的同一 owner generation。 | **生产端**：两 target 生产根、target decide/resume、local/external owner readers、AuthorityTransfer/delete、ready signer。**类型组合**：十类 owner 空/单/多、id/revision、同 id 换代、transfer/destroy、migration 清退复用、`authority-decided→authority-settled→revocation-ready` 每窗、效果/响应丢失与连续重启。**消费者**：signed ready、issuer revoke、cleanup/uninstall migration。**异常终态**：旧项未闭合或后继项被误处理却推进 ready/revoke。**审查/测试**：IR37-16、IR37-18、IR37-20、IR37-28、IR37-31、IR37-34、IR37-36～IR37-38、IR37-40；真实两根 owner/read-back 场景。 | 不改 journal、decision 或 artifact：`decide()/resume` 只 hydrate 同一 decision，并把 `mode+ownerItems` 作为 local/external settlement 必填输入；按固定 owner 分组复用现有 reader，以 frozen `id+revision` 授权既有 settle，conversation 权威达到所选 transfer/destroy 终态，其余 obligation/outbox/lease/permit 达到各自耐久终态并 exact read-back。同 id 不同 revision 在新效果前 fail-closed，已终结 exact replay；所有组全等闭合后才写 `authority-settled` 并签同 decision 的 ready。验收覆盖两 target 根、十类非空、同 id 换代、两 mode、migration 复用、各响应窗和连续重启，证明 frozen old generation 恰一收束且 successor 零误处理。**修复后证据：**decision 的 `mode+ownerItems` 已成为 local/external settlement 必填输入，固定 owner 分组均以 frozen id/revision 做前后 read-back，缺失 legacy ownerItems fail-closed；两 target 根共享同一签名合同。F37-23/F37-24 在当前指纹复核通过。 | 已验证 |
| U37-04 | **P2/小。** current-home path/SecretStore作用域、公开响应等待`onRemoved`及pre-runtime拒旧identity均已成立；剩余事实是`rm(...recursive)`把任意大树作为一个governor step，且本机`terminal`先于`onRemoved`里的device-key删除。**价值裁决记录：** 原P0/大声称跨home误删并留下可用旧key；home-scoped store、`assertOwnedPath`、trust revoke与pre-runtime已证伪，改为P2/小。仅当共享store、响应早于key删除或旧key可重新准入时重开P0/P1。用户体验与架构均达标。 | bulk cleanup、supervisor unregister、非device秘密、cleanup-ready、issuer terminal、exact key与本机terminal没有被表达成固定且可恢复的key-last顺序。 | **生产端**：冻结removable roots、storage governor、安全文件原语、home SecretStore、`unregisterFutureExact`、device-key store、target/issuer journal与pre-runtime。**类型组合**：小/大树、部分删除、registration/cleanup-ready/issuer terminal/key各窗口、错slot、效果/响应丢失、连续重启。**消费者**：removed状态、旧identity准入、当前进程safe exit。**异常终态**：单步大删除长期占用maintenance，或terminal前仍需补删key；当前无跨home删除/身份复活。**审查/测试**：IR37-22、IR37-24～IR37-25及IR37-31～IR37-32、IR37-37～IR37-38交界。 | 只改现有cleanup：对现有固定removable roots（不含当前`device-lifecycle`日志/evidence与独立checkpoint）逐个做home/path校验，用窄bottom-up walker每次最多128个dirent（文件/符号链接unlink、空目录rmdir）作为一个现有governor step；重启从同一root重扫，缺失项幂等，不建manifest。完成文件批次后执行`unregisterFutureExact`并read-back absent；现有`SecretStore.list("")`结果按稳定顺序分成128项批次，删除当前home全部非device-key ref并逐项read-back，写`cleanup-complete`。key仍在时生成并耐久U37-02 `cleanup-ready`回执，取得同operation issuer签名terminal后，target finalizer才以冻结`targetDeviceId+deviceKeyGeneration`调用现有device-key compare-delete/read-back，把key evidence与issuer terminal写本机terminal，`onRemoved`只安全退出。pre-runtime遇已有issuer terminal且key已缺失时不建key/角色，幂等补本机terminal后拒绝启动；未取得issuer terminal时保留key仅供terminal-only重驱。验收覆盖>128 exact-set、深目录/链接、部分批次、registration/cleanup-ready/issuer terminal/key各效果与响应窗口、错home/错slot/后继key及连续重启，证明本机terminal时exact key已缺失而其他home、独立checkpoint和后继slot不变。 | 已验证 |
| U37-05 | **P0/小，同根重开。** 首个/final checkpoint 的同 root 真解封已成立；当前 `#decideRetirement()` 把多条 exposure 与一条 lifecycle 写在一个 commit envelope，却返回 `context.nextLsn + compromised.length`，而 WAL 只为整个 envelope 增加一个 LSN；竞争调用在 projection 已见 `retirement-decided` 时还返回当前 `context.lastLsn`，它可能已越过该 decision envelope。**价值裁决记录：**原 U37-05 的真解封与 final verify 不恢复；C37-C05 把重开范围收窄为 live/竞争/replay watermark。active exposure 是受支持状态，错误位于不可取消 retirement 后，会让正确 final checkpoint 永久被拒；改验收或要求用户重启都不成立，复用现有 envelope/record LSN 即可，故保留 P0/小。 | transaction 把 logical entry 数量和当前日志尾都误当作该 operation 的物理 decision LSN，没有把唯一 commit envelope 的实际 LSN贯穿 live winner、并发 loser 与历史 replay。 | **生产端**：retirement projection transaction、0/1/多 exposure entries、lifecycle record、exact-record replay、final checkpoint verify。**类型组合**：同 envelope 多 entry、并发 decision、decision/final force 效果与响应丢失、后续无关 append 与连续重启。**消费者**：`upToLsn>=decisionLsn` 门禁、cleanup/terminal。**异常终态**：final 已覆盖真实 decision 仍被拒，backup uninstall 在不可逆 gate 后停摆。**审查/测试**：IR37-30～IR37-31、IR37-34、IR37-36、IR37-40；真实 WAL envelope 与 checkpoint service。 | 保留原 transaction 与真解封：append winner 的 watermark 只取该 commit envelope 的 `context.nextLsn`（或等值 `commit.lsn`），不得加 logical entry 数；projection 已见 decision 的并发/响应丢失分支不得返回 `lastLsn`，必须读取该 operation 唯一 `retirement-decided` record 所在 envelope LSN，历史 replay 同源。验收用真实 log 覆盖 0/1/多 exposure、同 envelope 多 entry、decision 竞争、其后追加无关 record、final force/verify 各窗与连续重启，证明 live/loser/replay 水位全等，final 同 root 覆盖实际 decision 后可唯一前滚。**修复后证据：**append winner 只返回 `context.nextLsn`，已见 decision 与历史 replay 均扫描该 operation 的 exact lifecycle record envelope LSN；多 exposure 同 envelope 的直接测试证明 final checkpoint 以真实水位前滚。F37-27/F37-28 在当前指纹复核通过。 | 已验证 |
| U37-06 | **P2/小。** response codec已用exact keys，但server `device.*`/`server.uninstall.*`和mesh request handler只`asRecord/decodeObject`后取字段，unknown keys被忽略；已验证字段仍严格，尚无unknown key改变授权或结果。**价值裁决记录：** 原P1/中把strict输入、S7和全部证据充分性合成一项；无当前越权/错效果，泛化S7会重复维护，故只保留facade strict输入并降P2/小。仅当unknown字段改变签名身份/授权/终态或出现registry外第二入口时重开P1。用户体验与架构均达标。 | Unit37公开request没有在方法分派后、任何lifecycle调用前复用现有plain-object+exact-key检查，造成同一协议的request与response规范化边界不一致。 | **生产端**：server `device.remove/continue/status`、五个`server.uninstall.*` loopback方法、target/issuer及U37-02 terminal-only mesh facade。**类型组合**：合法、unknown、缺失、错类型、旧peer/version。**消费者**：current-anchor/loopback/有限mesh handler与公开行动错误。**异常终态**：非规范客户端误以为扩展字段生效；当前合法路径和安全决定不变。**审查/测试**：IR37-33及IR37-35、IR37-37、IR37-40交界。 | 在现有server method文件与removal mesh文件各复用其已有plain-object/exact-key helper，分支确定后立即校验：device.remove=`requestId,operationId,targetName`，continue=`targetName,mode`，status=`targetName`；uninstall preflight=空，begin migration=`path,requestId,operationId,transferId,targetName`、backup=`path,requestId,operationId,recoveryPackage`，continue=`operationId,confirmBackup,recoveryPackage`，cancel/status=`operationId`；target/issuer每个op及terminal-only握手按各DTO的`v,op`和必填载荷exact-set校验。随后才做类型/签名/授权与调用生产对象；unknown/缺失/错类型统一映射现有稳定invalid/unavailable错误，旧peer在任何journal/gate效果前拒绝。仅补这些facade直接测试，合法输入字节与行为不变；不扩S7 registry、runner、状态DTO或重复元数据。 | 已验证 |
| U37-07 | **P0/中。** backup uninstall只关闭部分入口并quiesce delivery；final verify后直接cleanup/key/retired，之后才另起stop coordinator。**价值裁决记录：**P37-11曾与delivery gate合并，C37-C08证明十owner闭包是独立根因；C37-C11进一步证明final若只覆盖retirement decision LSN，仍可能漏掉其后的owner settlement与flush。backup是当前唯一无迁移永久卸载路径，未闭合会不可逆删除可恢复事实；复用同一device-lifecycle operation、既有ports/readers/evidence/checkpoint即可，P0/中与成本比例成立。只有生产已在同operation中耐久冻结十owner、逐项immediate-safe read-back并刷稳，且final真解封覆盖实际`flushed` envelope LSN后才cleanup，才关闭本项；不得恢复嵌套stop或通用lifecycle。最终结论：改写并保留；用户体验达标、架构达标。 | recovery-backup把checkpoint可解封误作accepted-work安全点；同operation没有在不可逆cleanup前形成“十owner冻结→settle/read-back→flush→final覆盖flushed LSN”的唯一前滚链，后置stop无法补回已清退owner。 | **生产端**：backup uninstall、retirement transaction、十类gate/ports/readers、authority/assignment/intent/final/delivery log与outbox、lease/permit/物理步骤、checkpoint、cleanup/key-last/retired。**类型组合**：十owner空/单/多，gate/freeze、decision、settle、flush、final force/verify、cleanup/key/retired各sync与响应窗，后继工作、效果丢失和连续重启。**消费者**：final recovery package、cleanup授权、pre-runtime non-resurrection及公开uninstall结果。**异常终态**：final包不含闭包后的状态便删除本地数据/secret，或旧operation在后置stop前已无法恢复。**审查/测试**：IR37-01、IR37-09～IR37-10、IR37-20、IR37-28～IR37-32、IR37-34、IR37-36、IR37-38、IR37-40；真实十owner、lifecycle log、checkpoint root与cleanup。 | 只在同一uninstall operation复用 `HostStopAcceptedWorkPorts`、owner readers/governor、artifact与现有phase：关闭十类producer gate并把exact `id/revision` artifact反绑retirement decision；按immediate语义逐项settle/read-back，复用现有`work-settled`，刷稳authority/assignment/intent/final/delivery log与outbox并收束lease/permit/物理步骤后写现有`flushed`，记录该真实envelope LSN。随后才`force(final)`并由同root真解封，要求`upToLsn>=flushedLsn`（因此也覆盖decision）；通过后才走既有cleanup→key-last→retired，当前进程在cleanup终结后退出。重启从同operation artifact/phase恢复并在公开准入前重关gate，不创建嵌套stop或第二journal。验收覆盖十owner空/单/多、迟到causal delivery、每个sync/响应窗、后继generation和连续重启，证明final覆盖闭包且cleanup前无未达安全点工作。 **修复后证据：** recovery-backup 在同 operation 于 retirement transaction 反绑十 owner artifact 及 candidate reference，依次写 `gate-closed→work-settled→flushed`，以真实 flushed record LSN 驱动同 root final verify，通过后才 cleanup/key-last/retired；startup/live 只恢复原 artifact/phase，无嵌套 stop。CLI 直接场景穿过真实 lifecycle log、artifact、checkpoint root 与两次 verify，验证 final `upToLsn>=flushedLsn`，F37-33～F37-35 在同一冻结指纹复核通过。 | 已验证 |
| U37-08 | **P1/中，新增并同根扩写。** reducer 只维护一个 primary subject：stop 为 `home+host`，executor-removal/uninstall 为 `home+device`；更关键的是 stop/uninstall 写本机 authority log，而 `ExecutorRemovalTarget` 把 target lifecycle 写入 `executorLog`，即使同名 conflict key 也无法跨根原子竞争。三路径随后共享 `DeliveryAuthority` 的单槽 admission；`activeDeliveryLifecycleOperationId` 在 install 成功前即可被覆盖，且 `HostStopAcceptedWorkPort.settle()` 已传入 exact `operationId`，装配 wrapper 却丢弃它并读取该全局标量。**价值裁决记录：**原结论为 P1/中；反方复核确认当前损失是安全生命周期互锁后的可用性与恢复阻断，尚无事实证明已经越过 key-last 或误停后继，故不升 P0；C37-C18 证明仅改 reducer 不足，必须同时统一本机 lifecycle arbitration root，但仍只复用已有 authority log，不新增事实源，工作量维持中。修复后仅在同一本机设备仍可跨根或同根同时 durable accept 两条 lifecycle，或 settle/seal/release 任一处仍从 exact port 参数外取得 owner 时重开。最终结论：扩写并保留；用户体验达标、架构达标。 | 三路径没有共享同一物理 lifecycle arbitration root 与 `home+device` 冲突身份，无法形成原子 durable owner；装配又以易失全局 operationId 覆盖既有 exact port ownership，形成第二事实源。 | **生产端：**OS signal、CLI/RPC/executor-only stop、target-side executor removal、migration/backup uninstall、本机 authority log与executor business log、device-lifecycle strict codec/reducer/journal、delivery install/settle/seal/release。**组合：**stop↔target removal、stop↔两类 uninstall，三进程形态，同/异 operation与日志根，accept/install/gate/artifact/settle/seal/release、效果/响应丢失与连续重启。**消费者：**stop ready、removal ready/revoke、uninstall transfer/final/cleanup、current process safe exit。**异常终态：**两根各自 durable accepted 后才在 delivery admission 互锁，第一 operation 又可能按错误 id seal/read-back/release，双方 gate 保持关闭且无法唯一恢复；远端 issuer operation 若误纳入本机键还会产生无关阻塞。**受影响审查项：**IR37-01、IR37-03、IR37-05、IR37-32、IR37-34～IR37-36、IR37-38、IR37-40。 | 只复用既有本机 authority log 作为三路径 `device-lifecycle` arbitration root：`ExecutorRemovalTarget` 的 lifecycle journal 从 `executorLog` 改接该 log，executor 业务 owner/settlement 仍留原 executor log。stop accepted identity 增加由既有 device key 冻结的 `localDeviceId`；reducer 保留 stop 的 `home+host` primary subject，并让它额外原子占用现有 `home+device:<localDeviceId>` subject，removal/uninstall 继续使用既有 target/current device subject；accept 检查全部 subject，terminal/aborted 同步释放，远端 issuer target device subject不与本机 stop冲突。删除 `activeDeliveryLifecycleOperationId`，让 port wrapper 传完整 settle input，install/seal/read-back/release只用 exact operationId，install成功前不发布owner。验收穿过两物理日志与三进程入口，覆盖三路径两两竞争、同载荷重放、错id、各阶段/响应窗和连续重启，证明 authority log 恰一 durable owner、executor log零第二 lifecycle记录、远端issuer可并行、错误operation零gate/delivery副作用且exact-host/key-last不回退；不得新增journal、coordinator、通用lifecycle或全局owner。 **修复后证据：**stop strict identity 冻结 `localDeviceId` 并在同一 authority-log transaction 同时占用 host/device subject；target removal lifecycle 已改接本机 authority log，executor log只保留业务事实；port wrapper 全程消费 exact `operationId`，进程级可变 owner 已删除。F37-43～F37-46、C37-C17～C37-C18及四路专项复审在冻结指纹上通过。 | 已验证 |

> **最新证据有效性说明：**C37-C16～C37-C18已在专项冻结指纹 `sha256:19b53f98573093b904694fdb9680af0a99d5af75d4bc34bae0ad05e5c3bacde5` 上修复后复核通过；F37-37～F37-46及下方修复后四路记录是U37-01/U37-08的当前有效证据。U37-02～U37-07及U37-01未被两项触发的既有子结论继续有效；专项通过不得替代独立审查节点重审。

## U37-01～U37-07 收敛事实矩阵

> 本矩阵记录修复后的专项事实链与验收闭包。当前有效四路冷启动对抗统一绑定交付物指纹 `sha256:e31735041aacd970a80acc92b7105849cd012709d272cf244e1a7989a9a97f76`。
>
> 历史执行状态：`F37-09～F37-20` 中 U37-01/U37-02/U37-03/U37-05 对应旧格已被 C37-C02～C37-C05 证伪；本轮以 `F37-21～F37-28` 和下方修复后四路记录替代，U37-04/U37-06 旧格未受影响。

| 编号 | 问题与直接变体 | 稳定身份、唯一事实与线性化点 | 零副作用边界、消费终态与直接验收 |
| ---- | -------------- | ---------------------------- | ---------------------------------- |
| F37-09 | U37-01：immediate/drain/cancel × managed/on-demand/foreground × OS signal/CLI/RPC/executor-only | `operationId+homeId+strategy+expected endpoint lock`；现有device-lifecycle phase为唯一耐久事实；gate read-back后冻结F37-04 snapshot，`ready-to-stop`只在线性收束全部snapshot后写 | accepted前零gate；失败保持同operation与gate；真实owners、outbox、permit、governor和三形态入口逐格证明同一闭包 |
| F37-10 | U37-01：每phase、timeout/blocker/flush/manager、效果/响应丢失、PID successor、连续重启 | 完整lock `(pid,port,startTime,startedAt)` 与definition、manager inspect共同授权exact stop；PID/instanceId单独不授权 | lock换代零manager stop；旧lock缺失且manager证明旧任务不running才补原terminal；证明后继零误停、零强杀、future definition保留 |
| F37-11 | U37-02：accept/decide/abort/ready竞争、同/异identity、两target根 | accepted receipt冻结operation/device generation/issuer/trust；target journal的aborted-vs-ready transaction是唯一胜负点，issuer `peer-effect`只重投冻结命令/回执 | identity错误零gate/owner效果；abort先赢回原aborted，ready先赢回原ready并继续revoke；真实双根与mesh逐phase验恰一winner |
| F37-12 | U37-02：revoke/cleanup-ready/terminal、在线转离线、两类lost、历史查询、迟到请求、连续重启 | target key generation保持历史认证；cleanup-ready在key存在时耐久，issuer terminal先于key-last；lost只由issuer durable decision授权 | 普通能力继续拒revoked；terminal-only只读/提交固定effect；已accepted迟到target写保留数据的lost-terminal，始终离线不伪造本地事实；响应丢失可唯一前滚 |
| F37-13 | U37-03：在线/离线preflight、F37-04空/单/多、snapshot漂移、transfer/destroy | effect-free preflight只读；gate关闭后冻结稳定item id/revision和managed generation；canonical artifact+candidate reference与decision同transaction反绑 | 离线只报unknown并允许wait/lost；digest漂移在首个不可逆效果前释放gate、重显且零decision；TTY/非TTY输出零内部id |
| F37-14 | U37-03：全部owner收束、ready、效果/响应丢失与重启 | decision后只hydrate同一snapshot artifact；各owner read-back closure digest，ready签名绑定snapshot+closure | gate后零新工作；conversation/intent/outbox/obligation/lease/permit逐项达到transfer/destroy终态才ready；重启禁止重算counts或改判 |
| F37-15 | U37-05：首个/final checkpoint，空/非空catalog/retained，create/replicate/read/unseal/verify窗口 | service generation冻结home/epoch/trust/target/recipient/root key；每次checkpointId/digest/LSN独立；`service.verify`真解封与full binding是唯一verified事实 | package strict decode与target/root binding在accepted前；任一错包/篡改/代际错零retirement；真实store/target/root逐窗验证 |
| F37-16 | U37-05：retirement decision、final LSN、package丢失、效果/响应丢失与连续重启 | retirement decision原子冻结LSN；同root final verify要求同generation且`upToLsn>=decisionLsn`并含retirement/exposure | root不耐久；退出停原phase、gate保持，现有loopback continuation等待用户对同operation重输package；不得status自报或自动开放准入 |
| F37-17 | U37-04：大exact-set、深目录/链接、部分批次、registration与连续重启 | 固定current-home removable roots与稳定排序SecretStore refs；每个governor step至多128项，重扫即恢复事实 | path/home不全等零删；当前lifecycle evidence、独立checkpoint与其他home不入集合；逐批read-back，零manifest与无界单步删除 |
| F37-18 | U37-04：cleanup-ready/issuer terminal/key、错slot、后继key、各效果/响应窗口 | 顺序固定为bulk cleanup→unregister/non-key secrets→cleanup-complete→cleanup-ready→issuer terminal→exact key compare-delete→local terminal | issuer terminal前保留key仅供terminal-only；错slot/后继key零误删；key已删而local terminal缺失时pre-runtime只补终态、不建key/角色 |
| F37-19 | U37-06：server device/uninstall合法、unknown、缺失、错类型 | method确定后的现有exact-key decoder是lifecycle调用前唯一输入边界；合法字节与既有身份不变 | 非规范输入统一invalid/unavailable且零journal/gate效果；参数化覆盖全部公开方法exact-set |
| F37-20 | U37-06：target/issuer/terminal-only mesh与旧peer | `v+op+各DTO载荷` strict decode后才验签/授权；历史分支仍反绑U37-02 accepted receipt | 旧peer与unknown字段在远端副作用前拒绝；零S7 registry、新runner或第二元数据源 |

### C37 反证账

| 编号 | 首次出现的反证 | 同根归属与耐久处置 | 关闭依据 |
| ---- | -------------- | ------------------ | -------- |
| C37-C01 | device-removal destroy 写入 durable delete 后，周期恢复 worker 可能已捕获旧队列；`recoverConversation()` 加入旧 pass 会在 lifecycle projection 尚未消费时返回，导致 owner closure read-back 失败 | 同根合并 U37-03；给现有 `ConversationProtocolRuntime` 暴露窄 `completeLifecycleProjections()`，destroy 只等待该既有 lifecycle consumer，不新增 journal、状态或恢复框架 | 修复后复核通过：真实 `LocalConversationOwnerAssembly` 在 active recovery loop 下删除冻结 exact-set，定向用例 1/1 通过且 read-back 为 deleted、pending=0 |
| C37-C02 | coordinator 已传 `operationId/frozen`，production ports 却丢弃二者；producer gate 未全关、flush/permit 不闭合且 executor-only signal 旁路 coordinator | 同根合并 U37-01；现有静态 ports 已以同 operation 关 gate、消费 frozen exact-set、刷稳并把 executor-only 接回同一 coordinator | 修复后复核通过：F37-21/F37-22、host-stop/local-owner/executor direct tests 与 S7 在当前指纹共同证明十 owner exact-set 和三形态入口闭合 |
| C37-C03 | removal decision 已有 ownerItems，local/external settlement 仍只接 operationId/conversation ids并重算聚合状态 | 同根合并 U37-03；`decide/resume` 只从 durable decision 传 `mode+ownerItems`，既有 readers 逐 id/revision settle/read-back | 修复后复核通过：F37-23/F37-24 与真实 target journal/local/external owner tests 证明缺 ownerItems fail-closed、exact successor 零误处理 |
| C37-C04 | target abort sync 后崩溃会丢内存 gate；无 gate 重放抛错，旧 abort 也没有统一的错 operation 防误释放边界 | 同根合并 U37-02；durable aborted 只授权同 operation 的 release/already-absent，冲突 gate 零副作用，随后 exact receipt peer-effect replay | 修复后复核通过：F37-25/F37-26 与 abort peer-effect 已存在、无 gate、冲突 gate fault tests 证明先 release 后 exact receipt replay |
| C37-C05 | retirement transaction 把同 envelope logical entry 数量叠加到 LSN，已见 decision 的竞争分支又把当前 log tail 当该 decision LSN | 同根合并 U37-05；winner 使用实际 commit envelope LSN，loser/replay读取该 operation 的 exact decision record LSN | 修复后复核通过：F37-27/F37-28 与多 active exposure 的真实 WAL/checkpoint test 证明 live/replay 水位等于 decision record envelope LSN |
| C37-C06 | direct scheduler freeze 测试首次穿透 external activation 窗口时，active completion tracker 在 `activateUserJob()` 返回后才登记，冻结可漏掉已接受但仍激活中的 job | 同根合并 U37-01；把既有 completion tracker 提前到外部 activation 调用前，失败仍由原 finally 清理，不新增 owner 或状态 | 修复后复核通过：scheduler authority 定向测试 11/11；freeze 在 activation 阻塞期间可见 exact id/revision，完成后归零 |
| C37-C07 | 当前直接测试明确证明 `AuthorityDeliveryPipeline` quiesce后canonical authority仍可enqueue；stop/removal却把该transport状态当producer gate并允许非终态delivery越相前滚 | 同根重开U37-01；最新事实、价值裁决、完整影响面与执行合同以问题列表U37-01为准，先前F37-21/F37-22及专项四路在delivery交界失效 | 修复后复核通过：真实 authority admission 在共享串行边界拒绝 artifact 外 fresh source，冻结 source 的 current/late delivery 均耐久绑定同 operation；core authority/pipeline 与 stop/removal 直接测试通过。 |
| C37-C08 | backup uninstall在final verify后先cleanup/key delete/retired，最后才启动stop coordinator；即使delivery gate修复，其余accepted-work仍未在不可逆清退前闭合 | 独立登记U37-07；把同uninstall operation的十owner closure移到final force/verify与cleanup之前，不并入U37-01或通用lifecycle | 修复后复核通过：backup 在同 operation 冻结并结算十 owner、刷稳后才 final verify/cleanup；直接场景验证 phase 顺序、candidate reference 与连续重入。 |
| C37-C09 | `DeliveryEnqueueKeyBody`是七类判别联合，staged/status/control等路径与conversation final/job result同样可在quiesce后append；只写conversation/job/scheduler会留下直接缺口 | 同根合并U37-01；固定七类source exact-set并复用现有envelope companion谓词与共享`DeliveryAuthority.coordinate()`，禁止逐producer补丁或新registry | 修复后复核通过：conversation final/status/control、staged、job result/status、scheduler notice 七类生产路径全部携 source ref，owner-kernel 15/15 与 authority 七类 exact-set 用例通过。 |
| C37-C10 | delivery只有transport状态与既有`uncertain`用户决议，没有可供cancel策略写入的通用delivery cancellation fact | 同根合并U37-01；cancel只取消上游可取消producer，已经enqueue的delivery按不可取消义务走drain，uncertain保持既有显式blocker | 修复后复核通过：immediate 保留耐久非终态，drain/cancel 对已 enqueue delivery 复用既有 terminal，uncertain 继续以原用户决议阻断；未新增取消事实。 |
| C37-C11 | final checkpoint只要求覆盖retirement decision LSN，无法证明包含其后十owner settlement、log/outbox flush与迟到causal delivery | 同根合并U37-07；在同一journal复用`work-settled/flushed`，final真解封必须覆盖该operation实际`flushed` envelope LSN | 修复后复核通过：`flushed` record 的真实 envelope LSN 成为 final 水位，真实 checkpoint test 证明 final 覆盖该 LSN 后才 cleanup。 |
| C37-C12 | 首版修复曾在 accepted-work artifact 耐久前调用 delivery gate callback，append 失败会留下无耐久授权的进程内 admission | 同根合并 U37-01；callback 只在 `gate-closed` 可从 artifact 重载后执行，失败不产生 admission，重放从同 operation artifact 重装 | 修复后复核通过：host-stop response-loss/flush-failure 与 callback 次数直接测试证明无预提交 gate，重启 exact replay |
| C37-C13 | 首版 backup retirement 把 accepted-work artifact 写入 lifecycle evidence 时未声明 candidate reference，GC 可先于后续 settlement 释放闭包输入 | 同根合并 U37-07；retirement transaction 同时写 evidence 并声明该 artifact 为 candidate reference，不新增 retention 事实源 | 修复后复核通过：真实 retirement record 与 retained reference 直接断言通过，缺 artifact 在任何 settlement/final 效果前 fail-closed |
| C37-C14 | successor lifecycle operation 初次恢复时若只收集无 lifecycle binding 的 pending delivery，会漏掉前一 operation 已绑定但仍非终态的义务 | 同根合并 U37-01；新 operation 安装 admission 时捕获当前全部 pending delivery，既有 binding 仅决定迟到归属，不排除 successor 的安全收束集合 | 修复后复核通过：authority restart 用空 source 的 successor operation 仍读回全部 7 个 pending item，后继不会误丢旧义务 |
| C37-C15 | 首版 backup 顺序先写 retirement decision 再冻结十 owner artifact，无法让不可逆 decision 反绑用户确认的 exact closure | 同根合并 U37-07；confirm 后先关十 gate、冻结 artifact，再在同 retirement transaction 反绑 evidence/reference，随后只消费该 artifact 前滚 | 修复后复核通过：anchor uninstall 直接测试检查 retirement record 携唯一 artifact，所有 settle/final 输入均由该 record hydrate |
| C37-C16 | lifecycle admission与`sealed`仍仅为内存态，phase重放无法恢复exact sealed状态；实际advancement producer可早于stop/removal/uninstall恢复，source调用方又未提交frozen revision，migration仍绕开producer gate | 同根再次重开U37-01；由既有operation+artifact+phase在producer恢复前确定性恢复exact admission/sealed，七类调用方提交exact revision且migration复用同一closure | 修复后复核通过：F37-37～F37-42、直接测试及四路专项复审在当前冻结指纹共同证明历史sealed不重开、fresh/错revision零append、migration不旁路 |
| C37-C17 | stop与本机removal/uninstall使用不同active subject，OS signal/RPC可并发durable accept；三路径共享单槽admission及可在install前覆盖的全局`activeDeliveryLifecycleOperationId` | 独立登记U37-08；strict stop identity冻结localDeviceId并在同一transaction占用host/device subject，完整port input成为delivery唯一owner且全局标量已删除 | 修复后复核通过：F37-43～F37-45、lifecycle/host-stop直接测试与S7证明同local device恰一durable owner、错operation零副作用、远端issuer不误冲突 |
| C37-C18 | stop/uninstall的device-lifecycle记录落本机authority log，而`ExecutorRemovalTarget`把target lifecycle写入executorLog；同一reducer conflict key无法跨两根日志原子竞争 | 同根并入U37-08；target lifecycle已改接既有本机authority log，executorLog只保留业务owner/settlement事实，不新增journal或跨日志锁 | 修复后复核通过：三路径统一在authority log竞争，生产装配与连续恢复测试证明executorLog零第二lifecycle accepted，胜者响应丢失后仍唯一恢复 |

### U37-01/U37-08 根因收敛固定矩阵（当前）

> 本矩阵只冻结问题根因、最优方案与直接验收，不代表实现或测试通过；复审对象为上方同一份未修改的 U37-01/U37-08 正式记录。

| 编号 | 问题与直接变体 | 稳定身份、唯一事实与线性化点 | 零副作用边界、消费终态与直接验收 |
| ---- | -------------- | ---------------------------- | ---------------------------------- |
| F37-37 | U37-01：各路径 accepted/artifact前置phase及stop `gate-closed/work-settled/flushed`、removal `authority-decided/authority-settled`、migration `gate-frozen/transfer-committed`、backup `retirement-decided/gate-closed/work-settled/flushed` 的清内存重放 | `operationId+accepted-work artifact ref+durable phase` 唯一决定producer全关、exact unsealed或sealed；artifact前只恢复上游gate关闭，artifact后未达settlement为unsealed、达到或越过后为sealed，`DeliveryAuthority.coordinate()`安装/封闭是enqueue线性化点 | 无artifact时禁止任何producer恢复而非猜permit；错operation/phase或strict hydration失败在父envelope前fail-closed；逐phase连续重启证明历史sealed永不重开、未sealed只接纳冻结source |
| F37-38 | U37-01：advancement、scheduler、local/remote assignment、conversation/channel 恢复与 lifecycle startup 的全部先后关系 | 同一 journal 扫描得到 active operation；恢复 admission/sealed 并关闭上游 gate 完成后，才允许现有 producer recovery/start/listen，是唯一启动准入顺序 | advancement 当前可调度事实不得早于 lifecycle 恢复；恢复失败保持服务未公开、零新 accepted work，stop、两 target removal、migration/backup 与三形态直接装配均验顺序 |
| F37-39 | U37-01：七类 canonical producer 的 fresh/frozen、same-id same/different revision、同/异 intent | `DeliveryEnqueueInput.lifecycleSources` 全等携 `owner/id/revision`；revision 来自调用方同一 source transaction 的 durable companion，authority 只比较 artifact permit，禁止代填 | 缺 revision、错 revision、artifact 外 fresh 与冲突 intent 在 source 父 envelope append 前零追加；同三元组同 intent exact replay 原 delivery，七个真实 producer 分别验 companion→enqueue |
| F37-40 | U37-01：local assignment、remote relay/local 双投影与 same-id successor | source key 保留 owner 与稳定命名空间，artifact 中 `relay:/local:` 不再去前缀折叠到另一 revision 域；`kind/id/revision` 是 successor 隔离边界 | 同业务 id 的不同投影/代际不得互授许可或误归集；各自 frozen generation 的 current/late delivery 恰一绑定同 operation，旧 sealed operation 对 successor 零副作用 |
| F37-41 | U37-01：三策略、三形态、两 target removal、backup 的 enqueue/attempt/read-back/ready、效果/响应丢失与连续重启 | 既有 owner settlement、delivery binding/state 与各路径 phase 仍是唯一业务终态；恢复只重建 gate，不改 immediate/drain/cancel、abort/ready、checkpoint/cleanup 结论 | source 未封闭或 delivery 集合未按原策略 read-back 时不得 ready/authority-settled/final；响应丢失只重驱同 operation，lost 诚实 unknown，U37-02～U37-07 已验证边界不重开 |
| F37-42 | U37-01：migration accepted→gate-frozen→transfer-committed→cleanup，零/多 causal source/delivery及各响应窗 | migration 复用现有 accepted-work artifact/ports；`gate-frozen` 安装 exact unsealed admission，source+delivery closure read-back 后才 seal 并允许 `transfer-committed` | 只 quiesce transport 不算 closure；任一 fresh/错 revision/未终结 delivery 阻断 transfer commit，重启重放原 artifact/phase且不新增 work-settled phase、journal或通用 lifecycle |
| F37-43 | U37-08：stop、target-side removal、migration/backup uninstall 的物理日志与 strict accepted identity | 三路径 lifecycle journal统一写既有本机authority log；executorLog只保留target业务owner事实。stop冻结`localDeviceId`并同时占有`home+host`与既有`home+device:<localDeviceId>`，removal/uninstall继续占有target/current device subject | 任一第二operation在同一log的accepted transaction前拒绝或exact replay；executorLog零第二lifecycle accepted，issuer日志中的远端target device subject不与本机stop冲突 |
| F37-44 | U37-08：stop↔target removal、stop↔两类 uninstall，OS signal/CLI/RPC/executor-only，managed/on-demand/foreground，同/异 operation及连续重启 | 全部冲突键由同一 authority-log reducer projection重建；accept commit是唯一胜负点，preflight/内存guard仅作体验优化，原exact-host/target/path evidence保留 | 并发loser零gate/artifact/admission效果并得到稳定blocker；winner效果/响应丢失后重启仍独占，terminal/aborted后后继才可accept，不新增跨日志锁或coordinator |
| F37-45 | U37-08：delivery install 前后、settle/seal/read-back/release、错 operation与响应丢失 | 每个 `HostStopAcceptedWorkPort` 调用已有 `input.operationId` 是唯一 owner；wrapper 传完整 input，`DeliveryAuthority` 仅接受同 operation install/seal/read-back/release，删除进程级 scalar | install 未成功不得发布 owner；stale/异 operation completion 零 seal/release/settlement 副作用，第一 operation 可从 durable phase恢复且不会被第二路径覆盖 |
| F37-46 | U37-01↔U37-08 与 U37-02～U37-07、第30～36及第38边界 | 两项只重接既有本机lifecycle log并扩strict identity/reducer、source DTO/companion、恢复顺序与exact port装配；executor业务终态仍由原log/owner事实决定 | 不迁移业务权威、不重做frozen identity、executor-only、exact manager stop、transport三策略、abort/ready、ownerItems、checkpoint/key-last；不引入跨日志事务、source registry、第二journal、通用lifecycle/history mesh或第38能力 |

### U37-01/U37-08 四路冷启动对抗复审（同一未修改问题列表）

| 复审 | 主动反例与直接交界 | 结论 |
| ---- | ------------------ | ---- |
| admission/sealed 耐久恢复与 startup 排序 | 抛开前轮结论，从空运行态重造F37-37/F37-38每个phase、advancement/scheduler/assignment先启动、hydrate失败、效果/响应丢失与连续重启；核查stop/removal/uninstall共享单槽及Unit36公开准入 | 通过：operation+artifact+phase唯一推出permit与sealed，实际producer恢复必须后置；失败零公开准入。现有问题行已给出有限对象、停止条件和直接证据，无需第二事实源 |
| source revision 与 migration 共同闭包 | 独立重造七producer缺/错revision、same-id successor、local/relay双域、迟到delivery及migration仅transport停发；核查U37-01与U37-02/U37-03/U37-07交界 | 通过：调用方exact三元组消除authority代填，稳定命名空间消除双域碰撞；migration在既有gate-frozen到transfer-committed之间复用同artifact/ports，无新增phase或registry |
| 本机三路径 durable 互斥与 exact operation owner | 独立重造authority/executor两根各自accept、三路径两两竞争、三形态、install前覆盖、stale release、远端issuer并行和连续重启；核查U37-01↔U37-08及exact-host/key-last | 通过：target lifecycle必须重接现有本机authority log后，host/device双subject才可在一个transaction恰一胜出；executorLog只留业务事实，完整port input是delivery唯一owner，远端issuer与后继host/key零误伤 |
| 生产体验、范围价值与历史裁决边界 | 从保持现状、改文字、复用现有机制、最小修复到新框架逐级比较；重造当前用户停机/移除/卸载卡死、fresh append与错误owner恢复，反查第30～36和第38边界 | 通过：不处理会在受支持路径丢accepted work或造成双方永久阻断，P0/大与P1/中均成立；两项方案同时满足最优用户体验和最优架构，且未恢复已否定主张或扩建通用框架 |

#### F37-37～F37-46 修复后专项核销

> 下表只读核销同一专项冻结指纹 `sha256:19b53f98573093b904694fdb9680af0a99d5af75d4bc34bae0ad05e5c3bacde5`；任何生产、公共合同或直接测试修改都会使本节失效。

| 矩阵 | 修复后生产事实与直接证据 | 结论 |
| ---- | ------------------------ | ---- |
| F37-37～F37-38 | `command.ts` 先从本机 authority journal筛选当前local-device operation，strict hydrate accepted-work/decision并按phase计算sealed；`access-surfaces.ts`在装配任何producer前调用 `restoreLifecycleAdmission()`，artifact未形成时所有producer保持关闭，advancement/scheduler恢复后置。direct surface、host-stop与连续恢复测试覆盖无artifact、unsealed、sealed及错identity | 修复后复核通过 |
| F37-39～F37-40 | `DeliveryLifecycleSourceRef` 必填 `owner/id/revision`；conversation/job/scheduler、staged/status/control七类路径从同一 durable companion 取revision，assignment保留 `local:`/`relay:` 完整命名空间；authority仅全等核验并在父envelope append前拒绝缺失、错revision或sealed输入 | 修复后复核通过 |
| F37-41～F37-42 | stop/removal/backup继续复用原三策略、owner/read-back与phase终态；migration在 `gate-frozen` 持久化同一accepted-work artifact，逐owner settle、delivery read-back与flush完成后才写 `transfer-committed`，未新增phase、journal或通用lifecycle | 修复后复核通过 |
| F37-43～F37-44 | stop identity冻结localDeviceId并在同一 reducer transaction占用host与device subject；target removal lifecycle改接本机authority log，三条本机路径在同一日志原子竞争，terminal/aborted同步释放，远端issuer不占本机device subject | 修复后复核通过 |
| F37-45～F37-46 | delivery port wrapper完整传递每次调用的exact operationId，install/seal/read-back/release均由authority核验同operation；进程级 `activeDeliveryLifecycleOperationId` 已从生产代码移除，executor业务日志、exact-host、key-last及Unit38边界未改变 | 修复后复核通过 |

### U37-01/U37-08 修复后四路冷启动对抗复审（同一冻结指纹）

| 复审 | 主动重造反例 | 同一指纹结论 |
| ---- | ------------ | ------------ |
| admission/sealed耐久恢复与startup排序 | 清空内存后逐相重造stop/removal/migration/backup前置、unsealed、sealed phase，插入advancement/scheduler/assignment/channel提前恢复、artifact缺失/损坏、响应丢失和连续重启 | 通过：operation+artifact+phase唯一投影gate与sealed，恢复入口先于实际producer；失败保持零公开准入，历史sealed不可重开 |
| source revision与migration共同闭包 | 重造七类source缺/错revision、same-id successor、local/relay双域、迟到delivery、migration只停transport及各响应窗 | 通过：调用方exact三元组在父envelope前核验，稳定命名空间隔离generation；migration同artifact/ports闭合source与delivery后才transfer commit |
| 本机三路径durable互斥与exact operation owner | 重造authority/executor两根分别accept、stop/removal/uninstall两两竞争、三形态、install前失败、stale seal/release、远端issuer并行和连续重启 | 通过：本机authority log的host/device双subject是唯一durable胜负点；完整port输入是delivery唯一owner，错误operation零副作用且不会误伤后继host/key |
| 生产体验、范围价值与历史裁决边界 | 反向比较保持现状、弱化合同、复用机制、最小修复和新增框架，核对U37-02～U37-07、第30～36及第38边界 | 通过：用户受支持停机/移除/卸载路径不再丢accepted work或永久互锁；实现只收紧既有日志、DTO、恢复顺序与装配，未恢复被否定主张或扩建框架 |

### U37-01/U37-07 根因收敛固定矩阵（历史，已被 C37-C16～C37-C17 证伪相关交界）

| 编号 | 问题与直接变体 | 稳定身份、唯一事实与线性化点 | 零副作用边界、消费终态与直接验收 |
| ---- | -------------- | ---------------------------- | ---------------------------------- |
| F37-29 | U37-01：七类source，fresh/frozen，同/异source，enqueue前后与同载荷重放 | `operationId+homeId+source kind+source id/revision+delivery intent digest`；现有lifecycle artifact是许可事实，所有source transaction与gate barrier共用`DeliveryAuthority.coordinate()`；barrier取得串行位是fresh append边界 | artifact外fresh/冲突source在父envelope前零append；同source同intent历史重放返回原delivery；真实七类companion envelope逐类证明无漏网producer |
| F37-30 | U37-01：causal producer仍运行、零/单/多迟到delivery、集合读回、效果/响应丢失和连续重启 | artifact冻结exact causal source；既有source companion谓词把每条迟到enqueue反绑同source，delivery stream是集合唯一事实；“producer全等终态且delivery再次读回无新增”是共同封闭点 | source未终结或两次读回间出现新项不得前滚；重启从operation+artifact重装gate，旧operation不得接纳successor source；真实log证明迟到项恰一归集 |
| F37-31 | U37-01：immediate/drain/cancel×managed/on-demand/foreground，attempt前后及queued/retry/attempting/uncertain/terminal | 同operation frozen producer/delivery set；pipeline只授权transport effect。immediate的线性点是active attempt结束且非终态已耐久回读；drain/cancel的线性点是既有delivery terminal | immediate不要求伪terminal；drain驱动sent/failed；cancel只写既有上游取消事实且把已enqueue delivery视为不可取消，uncertain以既有用户决议阻断；不得发明delivery取消记录 |
| F37-32 | U37-01：两类可达target生产根、migration复用、ready/revoke各窗、响应丢失与连续重启 | removal decision/ownerItems与同operation delivery selector共同授权；全部causal source终结且delivery terminal的read-back是`authority-settled/revocation-ready`前唯一门禁 | 任一非终态/迟到项阻断ready；lost诚实unknown、abort/terminal-only主链不变，后继generation零误处理；真实两根日志与迁居清退验证exact replay |
| F37-33 | U37-07：十owner空/单/多，retirement前后gate/freeze与后继工作 | `operationId+home/device/path generation+accepted-work artifact ref`；十gate全等关闭后冻结id/revision，artifact随同一retirement decision受既有candidate-reference保护 | gate未全关或artifact/decision错绑时零settlement/final effect；后继工作拒绝，允许causal delivery按F37-29/F37-30并入；重启公开准入前恢复同gate |
| F37-34 | U37-07：逐owner settle/read-back、flush、lease/permit/物理步骤及每个sync/响应窗 | 同artifact是十port唯一输入；`work-settled`后刷稳authority/assignment/intent/final/delivery log与outbox，`flushed` record所在真实envelope LSN是闭包水位 | 任一owner未达immediate-safe、flush失败或物理步骤未释放均保持gate并停在原phase；响应丢失只重放exact owner/phase，不另起stop operation |
| F37-35 | U37-07：final force/read/unseal/verify、cleanup/key/retired各窗与连续重启 | 同service generation/root和final checkpoint identity；真解封`upToLsn>=flushedLsn`是cleanup唯一授权，因`flushedLsn>decisionLsn`同时覆盖retirement | final不足、错root、篡改或响应不明时零cleanup；验证后只前滚既有cleanup→key-last→retired，历史重放不重删successor slot |
| F37-36 | U37-01↔U37-07及U37-02～U37-06、第30～36、第38边界 | U37-01只增加canonical delivery窄admission；U37-07只组合现有十ports与checkpoint；两者共享operation/artifact而不共享终态journal | 不重开ownerItems、abort/ready、cleanup batch/key-last、checkpoint真解封或exact-host；不实现自动failover、恢复应用、升级/发布、通用manifest/lifecycle/history mesh |

#### F37-29～F37-36 修复后专项核销

> 核销对象为冻结交付物 `sha256:e31735041aacd970a80acc92b7105849cd012709d272cf244e1a7989a9a97f76`；测试通过只作辅助证据，结论来自下列生产事实链逐格重建。

| 编号 | 当前指纹生产证据 | 结论 |
| ---- | ---------------- | ---- |
| F37-29 | `DeliveryAuthority.prepareEnqueues()` 与 source transaction 共用 `coordinate()`；operation admission 保存 frozen permit，item record 保存完整 lifecycle binding，七类 participant/notice 生产点均携 source ref | 通过：artifact 外 fresh source 在父 envelope 前拒绝，同 key 同 intent exact replay，冲突输入零追加；七类生产路径无逐点旁路 |
| F37-30 | admission 安装时捕获全部当前 pending，冻结 source 的迟到 enqueue 持久绑定 operation；seal 在 conversation/assignment/scheduler 等 causal owners 逐项 settle/read-back 后才发生，restart 由同 artifact 重装 | 通过：零/单/多迟到 delivery 恰一归集；旧 operation bound pending 仍进入 successor 安全收束集合，后继 source 不被旧许可接纳 |
| F37-31 | pipeline 的 `settleAcceptedWorkForLifecycle()` 只驱动 transport：immediate 等 active attempt 后保留耐久态，drain/cancel 驱动既有 delivery terminal，uncertain 继续抛既有用户决议 blocker | 通过：三策略×三形态未伪造 cancellation/terminal，效果与响应丢失只从 authority facts 重驱 |
| F37-32 | stop port 与两类 removal target 都先 install/seal同 operation admission，再以 `lifecycleAcceptedWorkItems()` read-back；可达 removal/migration 对 delivery 使用 drain，lost 主链未改 | 通过：任一迟到/非终态项阻断 ready/revoke；两 target 根、迁居清退、响应丢失与连续重启唯一收敛 |
| F37-33 | recovery confirm 后先关闭十 gate、冻结 canonical artifact，再由 retirement transaction 同时写 accepted-work evidence、candidate reference 与 decision | 通过：artifact/decision 全等反绑，缺失、错绑、未全关 gate 均在 settlement/final 新效果前失败；未创建嵌套 stop |
| F37-34 | 同一 artifact 逐 owner 调用既有 port settle/read-back，随后写 `work-settled`；authority/local-owner checkpoint 与 governor 物理安全点完成后写 `flushed` | 通过：十 owner 空/单/多及每个 sync/响应窗口只重驱原 phase；未达 immediate-safe 或 flush 失败保持 gate |
| F37-35 | final checkpoint 读取 `flushed` lifecycle record 的实际 envelope LSN，同 root 真解封并要求 `upToLsn>=flushedLsn`，之后才 cleanup→key-last→retired | 通过：错 root、篡改、水位不足与响应不明零 cleanup；连续重启只前滚原 operation，successor slot 不被历史重放删除 |
| F37-36 | 变更只落在现有 delivery authority/pipeline、owner participant、device-lifecycle、stop/removal ports、checkpoint owner 与架构规格 | 通过：U37-02～U37-06及第30～36合同未漂移；无第二journal、manifest/history mesh、通用lifecycle、新runner或第38单元能力 |

### U37-01/U37-07 四路冷启动对抗复审（历史，相关结论已失效）

> 四路均从冻结交付物 `sha256:e31735041aacd970a80acc92b7105849cd012709d272cf244e1a7989a9a97f76` 的当前合同与源码重新推导，未复用修复自证或下方历史问题列表结论。

| 复审角色 | 主动重造的反例与直接交界 | 结论 |
| -------- | ------------------------ | ---- |
| delivery producer admission 与冻结 causal 集合 | 重造七类 source、barrier 竞争、同/异 source、同 key 冲突 intent、freeze 前 accepted/后 append、零/多迟到 item、旧 bound pending、seal 与连续重启；核查 authority companion 与 ownerItems | 通过：共享串行边界唯一排序，许可与 item binding 均反绑 operation/source revision/intent；fresh 零 append，causal 与旧 pending 恰一进入当前安全集合，集合封闭后才 seal |
| stop/removal/migration 三策略与不可逆 ready | 重造 immediate 非终态、drain/cancel 失败与 uncertain、managed/on-demand/foreground、两 target 根、migration、ready/revoke 丢响应、successor generation 与 lost | 通过：immediate 只承诺耐久重放，drain/cancel 对已 enqueue obligation 到既有 terminal；可达路径全量 read-back 后才 ready，lost 继续诚实 unknown，exact-host 与 abort/ownerItems 主链不变 |
| backup 十 owner 闭包/checkpoint/cleanup | 重造十 owner 空/单/多、artifact/decision/candidate ref 错绑、settle/flush 各窗、迟到 delivery、final 只覆盖 decision、错 root/篡改、cleanup/key/retired 中断 | 通过：同 operation artifact→decision→work-settled→flushed(actual LSN)→同 root final verify→cleanup/key-last/retired 是唯一链，任何前置缺口都零 cleanup |
| 生产体验、资源上界、范围价值与历史裁决 | 反向比较保持现状、弱化合同、现有机制、最小修复和新增框架；核查U37-01↔U37-07、U37-02～U37-06、第30～36与第38边界 | 通过：当前用户不再丢已接受结果或得到不可恢复 backup；方案复用既有日志、artifact、ports、checkpoint/governor，O(owner+pending delivery) 有界且未恢复被否定主张或扩面 |

### U37-01/U37-07 四路冷启动对抗复审（修复前问题列表历史）

> 历史记录：四路当时只收敛未修改的 U37-01/U37-07 问题行，指纹 `sha256:2cac8eb5fc4a74e9699b442c6c2b3146c6dd340738071cc40c3b113119f1d09a`；不得作为修复后交付物通过证据。

| 复审角色 | 主动反例与直接交界 | 结论 |
| -------- | ------------------ | ---- |
| delivery producer admission 与冻结causal集合 | 逐类重造七种source在pipeline quiesce后append、source transaction与barrier交错、同source exact replay/冲突intent、freeze前已accepted但尚未append、零/多迟到delivery及连续重启；核查U37-01与既有authority envelope/ownerItems | 通过：共享`DeliveryAuthority.coordinate()`可唯一排序barrier与全部producer；artifact冻结exact source许可，现有companion谓词反绑父envelope，producer终结后同边界封闭许可并捕获全部delivery，无第二事实源或逐producer补丁 |
| stop/removal/migration 三策略与不可逆ready | 重造immediate非终态、drain失败/uncertain、cancel上游已取消但delivery仍在途、两类可达target/migration迟到项、lost-device离线unknown、ready/revoke响应丢失和后继generation | 通过：immediate只要求耐久可重放安全态；drain/cancel对既有delivery终结且uncertain沿用用户决议；可达removal/migration才要求terminal，lost主链保持诚实unknown，未恢复U37-02/U37-03已闭合范围 |
| backup十owner闭包/checkpoint/cleanup顺序 | 重造十owner空/单/多、artifact/decision错绑、settle/flush各响应窗、迟到causal delivery、final仅覆盖decision未覆盖flush、错root/篡改、cleanup/key/retired中断与连续重启 | 通过：同operation artifact、`work-settled/flushed`与实际flushed envelope LSN形成唯一链；final真解封覆盖该LSN后才cleanup，后置嵌套stop被排除，U37-04 key-last与U37-05真解封/decision LSN边界不变 |
| 生产体验、评级、工作量与范围价值 | 反向比较保持现状、改弱合同、复用现有机制、最小完整修复及新增框架；核查U37-01↔U37-07、U37-02～U37-06、第30～36既有合同和第38边界 | 通过：不修会在受支持停机/可达移除/backup卸载中丢accepted work或产生不可恢复backup，P0/大与P0/中均成立；方案只扩现有authority admission和同operation阶段组合，用户体验与架构均达标，未引入manifest/history mesh/通用lifecycle/恢复应用或升级发布能力 |

### U37-01/U37-02/U37-03/U37-05 同根重开执行矩阵

> 本矩阵绑定交付物指纹 `sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61`；左侧保留收敛时的固定合同，下方核销表记录同一未修改指纹上的生产证据与结论。

| 编号 | 问题与直接变体 | 稳定身份、唯一事实与线性化点 | 零副作用边界、消费终态与直接验收 |
| ---- | -------------- | ---------------------------- | ---------------------------------- |
| F37-21 | U37-01：三策略×三形态×十类 owner 空/单/多，全部 gate→freeze 窗口 | `operationId+homeId+strategy+exact host generation` 与 artifact 内 owner `id+revision`；现有 lifecycle operation 是唯一耐久事实；十类 producer gate 全等 read-back 后写 canonical snapshot 是冻结点 | gate 未全关不得 freeze；identity/revision 不全等不得 settle successor；真实 producer 在 gate 后零新 accept，executor-only 与其他入口得到同一 snapshot |
| F37-22 | U37-01：settle→read-back→flush→permit→ready，各 timeout/blocker/效果/响应窗与连续重启 | 同一 frozen slice 是每个 port settle/read-back 的唯一授权；`work-settled/flushed/ready-to-stop` 仍是既有 journal 线性化点 | 任一 item、log/outbox、lease/permit或物理步骤未回读完成即保持 gate；重放不重采样、不误停后继，ready 后才 exact-host teardown |
| F37-23 | U37-03：两 target 根、十类 ownerItems、transfer/destroy 与同 id 换代 | `operationId+decision artifact digest+mode+owner id/revision`；`authority-decided` decision 是唯一效果输入；全部 exact read-back 后的 `authority-settled` 是 ready 前线性化点 | decision 前可漂移重显且零不可逆效果；decision 后禁止聚合重算，同 id 新 revision 零误处理；真实 readers 证明 frozen generation 恰一终结 |
| F37-24 | U37-03：conversation/intent/final/assignment/remote/channel/scheduler/delivery/lease/permit，migration 复用与连续重启 | ownerItems 按固定 owner 分组；conversation 消费同 decision 的 transfer/destroy，其余 obligation 消费自身耐久终态；resume 只 hydrate 原 artifact | 任一 owner 缺 reader、身份漂移或终态未回读均不得 ready/revoke；响应丢失只重驱原 decision，不创建 manifest、第二 snapshot 或新 lifecycle |
| F37-25 | U37-02：abort sync 前后、gate 同 operation/无/错 operation、release 各窗口 | 完整 accepted identity 与 signed abort；target journal durable aborted 是唯一 winner/释放授权，`journal.abort()` sync 是胜负线性化点 | 同 operation release、无 gate 视为完成、错 operation 零副作用；abort 未耐久不得开 gate，ready 已赢不得释放 |
| F37-26 | U37-02：receipt artifact/peer-effect/响应丢失、abort-ready 竞争与连续重启 | durable identity+abort 唯一确定 signed receipt；已有 `target-aborted` peer-effect 优先 hydrate，缺失才补同字节 ref/effect | issuer 只凭 authenticated receipt 释放 guard；错误 identity 零 gate/receipt效果，重启后 release 与 receipt 各恰一且不改变 ready/revoke 主链 |
| F37-27 | U37-05：0/1/多 exposure、同 envelope 多 projection entry、并发 decision 与后续无关 append | `operationId+retirement-decided record` 所在 commit envelope；append 线性化 LSN 为 `context.nextLsn=commit.lsn`，logical entry 数量不改变水位 | decision 前错 authority/root 零 retirement；winner、并发 loser与历史 replay都返回 exact record LSN，不得使用 entry count 或当前 `lastLsn` |
| F37-28 | U37-05：decision/final force/verify 效果与响应丢失、连续重启 | final checkpoint 继续消费同 service generation/root 与 exact decision LSN；`upToLsn>=decisionLsn` 的真解封 verify 是 cleanup 门禁 | final 未覆盖 actual decision 保持 gate；已覆盖即前滚且不受 exposure 数或后续 log tail 影响；不恢复 recovery application、第38单元或第二 checkpoint 事实 |

#### F37-21～F37-28 修复后核销

| 编号 | 当前指纹生产证据 | 结论 |
| ---- | ---------------- | ---- |
| F37-21 | `command.ts` 与 `executor-role-runtime.ts` 在同 operation 下先关闭 inbound/local owner/job/channel/scheduler/delivery gate，再由十个静态 port 冻结 id/revision；executor-only 信号也构造同一 `HostStopCoordinator` | 通过：三策略、三形态及十 owner 空/非空均只有一个冻结点，gate 后零新增 accepted work |
| F37-22 | coordinator 把 frozen slice 原样传入每个 settle/read-back；local owner、scheduler、delivery、remote/channel均先校验 subset，生命周期日志与 local owner checkpoint 后才 `ready-to-stop` | 通过：失败保持原 phase/gate，后继 revision 与 exact host 不被旧 operation 误停 |
| F37-23 | `ExecutorRemovalTarget.decide()`只 hydrate durable decision，缺 `ownerItems` 直接拒绝，并将同一 `mode+ownerItems` 传给 local/external settlement | 通过：两 target 根的不可逆效果只由同一 decision artifact 授权 |
| F37-24 | local owner按 conversation/intent/final/assignment/lease/permit exact-set read-back，外部 binding 按 remote/channel/scheduler/delivery 固定分组前后校验；全部完成后才写 `authority-settled` | 通过：transfer/destroy、同 id 换代、migration复用与响应丢失只重驱旧 generation，未产生第二 snapshot/manifest |
| F37-25 | target journal 的 durable aborted 先授权 local/external同 operation release；already-absent幂等，冲突 operation 拒绝，ready winner继续返回原 ready | 通过：abort sync、gate有/无/错operation及竞争均恰一收敛 |
| F37-26 | release完成后优先 hydrate existing `target-aborted` peer-effect；缺失才从 frozen identity+abort生成并耐久 signed receipt | 通过：receipt 效果/响应丢失与连续重启 exact replay，错误 identity 零副作用 |
| F37-27 | retirement append winner返回 `context.nextLsn`；已见 decision 与历史 replay 都从 `device-lifecycle` exact record读取 `entry.lsn` | 通过：0/1/多 exposure、同 envelope多entry与后续无关append不改变 decision 水位 |
| F37-28 | final checkpoint仍以同root真解封并要求 `upToLsn>=exact decision record lsn`；多 exposure真实WAL测试覆盖旧伪水位反例 | 通过：final覆盖真实decision即唯一前滚，未提前实现恢复应用或第38单元能力 |

### 四路冷启动对抗复审（修复后同一指纹）

> 四路均从当前合同和生产源码重新推导，不复用历史专项或方案收敛结论；复审对象为上方同一份未修改交付物，指纹 `sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61`。

| 复审 | 主动反例与直接交界 | 结论 |
| ---- | ------------------ | ---- |
| stop frozen snapshot 与三形态入口 | 重造三策略、十类非空、未全关 gate、activation已接受但tracker未登记、聚合清零但 frozen item 未终结、flush/permit失败、executor-only signal、后继 host与连续重启；核查U37-01↔U37-03及Unit36 exact-stop | 通过：所有 producer gate 先关闭，scheduler tracker提前登记，十 port消费同一 frozen slice；executor-only仅在同 coordinator ready后退出，endpoint lock/manager stop边界不变 |
| removal ownerItems 与不可逆 ready/revoke | 重造两 target 根、十类 id/revision、同 id 换代、两 mode、migration复用、聚合归零但 frozen generation 未闭合及响应丢失；核查U37-01↔U37-03与U37-03↔U37-02 | 通过：durable decision ownerItems 是 local/external settlement必填输入，全部固定owner read-back后才ready；preflight/artifact/漂移链未重做，无manifest或第二事实源 |
| abort gate/receipt 连续恢复 | 重造 abort sync 后无 gate、同/错 gate、existing receipt但release未完成、ready竞争、迟到旧 abort及连续重启；核查U37-03↔U37-02与U37-02↔U37-05 | 通过：durable aborted先授权 exact幂等release再回放receipt，错operation零副作用；ready/revoke/terminal-only/lost主链保持不变 |
| retirement LSN / 产品体验 / 范围价值 | 重造0/1/多exposure、同envelope多entry、并发loser、后续append、final覆盖actual decision但未覆盖旧伪水位；反查U37-04/U37-06、第30～36与第38边界 | 通过：winner/loser/replay统一消费actual decision envelope LSN；用户不会丢accepted work或困在伪checkpoint门禁，且未新增history mesh、通用框架、新runner或第38单元能力 |

### 历史四路冷启动对抗复审（已失效）

> 以下为历史专项记录；C37-C02～C37-C05 已证伪其中 stop、removal、backup 三路及综合价值路的当前有效性，不得作为本轮通过证据。本轮已在上方新指纹重新执行受影响四路。

| 复审 | 主动反例与直接交界 | 结论 |
| ---- | ------------------ | ---- |
| stop accepted-work / exact-host | 在冻结指纹上重造F37-04非空、三策略/三形态、blocker/permit、manager响应丢失、PID/lock successor与连续重启；核查U37-01↔U37-03及Unit36 exact-stop | 通过：静态owner item/revision snapshot逐项闭合；完整endpoint lock、canonical definition与独立manager read-back共同授权既有`stopCurrentExact`，后继代际零误停、零强杀 |
| removal跨端终态 / frozen decision / cleanup | 重造abort-vs-ready、revoke响应丢失、cleanup-ready后断线、lost迟到target、snapshot漂移、C37-C01与key各窗口；核查U37-02↔U37-03↔U37-04 | 通过：target winner、issuer peer-effect、terminal-only、effect-free artifact decision、窄lifecycle completion与key-last构成唯一前滚；跨根requestId、跨home误删和通用manifest主张未恢复 |
| backup checkpoint真验证 | 重造replicated但不可解封、错root/旧checkpoint、retirement后final LSN不足、篡改及重启缺root；核查U37-02↔U37-05及Unit33～35 checkpoint合同 | 通过：只有现有`service.verify`从同root真解封且full binding成立才授权；service generation、双checkpoint与decision LSN分离，重启等待同operation重输package，未实现恢复应用 |
| facade / 产品体验 / 范围价值 | 重造全部server/mesh方法unknown/缺失/错类型/旧peer、公开内部id、伪checkpoint owner及Unit38扩面；反向核定六项评级、工作量与价值裁决边界 | 通过：strict decoder均在journal/gate前拒绝；六项当前损失已消除且原评级/工作量有事实依据，用户体验与架构均达标，无S7 registry、新runner、历史mesh或secret框架扩面 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |
| L37-01 | U37-01/U37-03；专项四路曾通过 | 冻结 artifact/decision 的“已创建”被误当成消费者已按 exact identity 收束，未沿函数签名核对 frozen 数据是否进入每个 owner settle/read-back | 对所有以冻结集合授权不可逆效果的链路，逐个核对 producer→参数→consumer→exact read-back；接口不接 frozen identity 或只验聚合计数即判未闭合。适用于 stop/removal/migration cleanup | 本轮独立审查：执行并发现 C37-C02、C37-C03，重开 U37-01/U37-03 |
| L37-02 | U37-02；专项四路曾通过 | 只验证 durable winner，遗漏 winner sync 后易失 gate 已不存在时的重放语义 | 对跨端 terminal 的每个 durable decision 枚举 sync→本地效果→receipt/ack 窗口；重启时清空内存对象，验证同 identity 幂等补效果、错误 identity 零副作用。适用于 abort/cleanup-ready/terminal | 本轮独立审查：执行并发现 C37-C04，重开 U37-02 |
| L37-03 | U37-05；专项四路曾通过 | 把 transaction 内 logical entry 数量误认为 commit-log 物理 LSN 增量，测试未对账 live 返回与 replay record | 所有 watermark/LSN 必须反查物理 commit envelope 的增量规则，并逐一比较 live 返回、日志记录与重放读取。适用于 checkpoint、retirement及同 envelope 多 projection 写入 | 本轮独立审查：执行并发现 C37-C05，重开 U37-05 |
| L37-04 | U37-01；F37-21/F37-22与修复后四路曾通过 | 只检查transport停止发送和owner read-back，没有在canonical enqueue处验证producer admission，也未把冻结causal producer后续产出的delivery纳入同一集合 | 对所有accepted-work gate逐一穿过真实canonical append：gate后注入fresh producer与frozen producer后续产出，验证fresh零append、允许产出进入同operation并在ready前共同封闭。适用于stop/removal/migration | 本轮独立审查：执行并发现C37-C07，同根重开U37-01 |
| L37-05 | U37-07；backup checkpoint历史四路曾通过 | 把final checkpoint真验证误当成accepted-work已安全闭合，未按调用顺序对账safe-stop、checkpoint、cleanup、key与retired | 对所有不可逆cleanup逐相列出producer gate→frozen owner closure→flush→checkpoint覆盖→cleanup/key/terminal；任何cleanup先于同operation闭包即判失败。适用于backup uninstall | 本轮独立审查：执行并发现C37-C08，新增U37-07 |
| L37-06 | U37-01；F37-29～F37-36与专项四路曾通过 | 只验证同进程内admission与producer companion，没有清空内存态后从耐久phase重建，也未要求source调用方提交revision或对账实际producer恢复顺序 | 对所有lifecycle producer gate清空运行态并从每个phase连续重启；在公开/内部producer恢复前验证由operation+artifact+phase重装exact sealed admission，逐source核对调用方`kind/id/revision`并覆盖migration。适用于stop/removal/uninstall/migration | 本轮独立审查：执行并发现C37-C16，同根重开U37-01 |
| L37-07 | U37-08；三条lifecycle路径各自专项曾通过 | 按单路径验证单飞，未对账不同subject之间的本机并发，也未搜索已有exact operation参数被进程级可变owner替代的装配点 | 对本机lifecycle做三路径两两durable accept竞争，核对共同local-device conflict identity；凡port已有operationId仍读取全局/闭包可变owner即判第二事实源。适用于OS signal、CLI/RPC stop、target removal与uninstall | 本轮独立审查：执行并发现C37-C17，新增U37-08 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V37-01 | 六项生产闭包的直接合同与场景证据 | core lifecycle 6/6、mesh checkpoint/key 22/22、server lifecycle/RPC 43/43、CLI stop/removal/uninstall主闭包33/33及补充定向60/60 | 当前42文件专项交付闭包 | 修复直接验证 / 低中 / 已完成 | 历史通过；C37-C02～C37-C05 已使受影响输入与结论失效 | `sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0` | 失效 |
| V37-02 | 类型与最终可消费构建 | `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit`；`pnpm build`（上游与主输入）；新增CLI源后`pnpm cli:build` | core/mesh/server/cli源码与当前workspace依赖 | 修复直接验证 / 中 / 已完成 | 历史通过；当前源码与构建产物已变化 | 同上 | 失效 |
| V37-03 | 派生资产与结构合同 | `pnpm s7:lint` | S7 descriptors、coverage tests、registry golden及当前生产入口 | 派生资产预检 / 低 / 50.5s | 历史通过；本轮S7 descriptor与mutation test已变化 | 同上 | 失效 |
| V37-04 | 交付卫生与专项冻结 | `git diff --check HEAD`；42文件逐文件SHA-256后再聚合 | 全部Unit37变更生产/测试/架构规格文件，排除过程账本与清单 | 冻结前检查 / 低 / 已完成 | 历史指纹，已被当前53文件交付闭包替代 | `sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0` | 失效 |
| V37-05 | U37-01/U37-02/U37-03/U37-05 受影响闭包直接证据 | CLI host-stop/device-removal/anchor-uninstall 17/17；local owner/executor role 14/14；core delivery 32/32；owner scheduler 11/11 | 本轮 stop/removal/abort/LSN 生产实现与直接测试 | 修复直接验证 / 中 / 已完成 | 历史74/74与abort 9/9通过；C37-C07证明delivery producer admission未被覆盖，C37-C08证明backup安全顺序未被覆盖，相关功能结论失效；U37-02/U37-03/U37-05的未变子证据仍可在后续按输入复用 | `sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61` | 失效 |
| V37-06 | 类型与最终可消费构建 | `pnpm --filter @zhixing/cli exec tsc --noEmit`；`pnpm build` | 当前workspace源码、上游dist与53文件Unit37闭包 | 修复直接验证 / 中 / 16.4s+179s | 历史通过；U37-01/U37-07 当前源码与构建输入已变化 | 同上 | 失效 |
| V37-07 | 派生资产与结构合同 | `pnpm s7:lint` | S7 stop/removal descriptor、mutation tests、registry golden及当前生产入口 | 派生资产预检 / 低 / 已完成 | 历史20/20通过；当前生产入口输入已变化，由V37-11替代 | 同上 | 失效 |
| V37-08 | 交付卫生与专项冻结 | `git diff --check`；既有42文件闭包与本轮差异取并集后逐文件SHA-256再聚合 | 53个Unit37生产/测试/S7/架构规格文件，排除过程账本与独立审查清单 | 冻结前检查 / 低 / 已完成 | 历史指纹，已由U37-01/U37-07当前20文件专项指纹替代 | `sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61` | 失效 |
| V37-09 | U37-01/U37-07 受影响闭包直接证据 | core authority/pipeline/lifecycle 84/84；owner delivery/notice 15/15；CLI host-stop/removal/uninstall 17/17 | 本批 delivery admission、owner producer、stop/removal ports、backup lifecycle 与直接测试 | 修复直接验证 / 中 / 29.4s+6.9s+37.5s | 116/116通过；真实日志、artifact、checkpoint与响应丢失路径均在当前源码输入完成 | `sha256:e31735041aacd970a80acc92b7105849cd012709d272cf244e1a7989a9a97f76` | 有效 |
| V37-10 | 当前源码最终可消费构建 | `pnpm build` | 17个工作区包与当前U37-01/U37-07源码/依赖闭包 | 修复直接验证 / 中 / 250.4s | 17/17工作区包构建成功；未重复同输入构建 | 同上 | 有效 |
| V37-11 | 派生资产、差异卫生与专项冻结 | `pnpm s7:lint`；`git diff --check HEAD`；20文件逐文件SHA-256后聚合 | 当前生产入口、S7 registry golden及本批20个生产/测试/架构规格文件，排除过程账本与独立清单 | 冻结前检查 / 低 / 56.2s | S7 20/20与registry golden通过；diff check通过；20文件聚合指纹稳定 | `sha256:e31735041aacd970a80acc92b7105849cd012709d272cf244e1a7989a9a97f76` | 有效 |
| V37-12 | U37-01/U37-08受影响闭包直接证据 | core lifecycle/journal/delivery 54/54；owner delivery/scheduler 22/22；CLI producer surface/relay 21/21；CLI stop/removal/uninstall/conversation/job 46/47并定向复核host-stop 6/6 | 本批startup lifecycle、exact source、authority-log conflict、exact operation装配及直接测试 | 修复直接验证 / 中 / 已完成 | 143个目标用例通过；唯一失败是Unit37未修改路径中既有readiness读取次数脆弱断言，生产仍以capability-gap正确拒绝，已由V37-D01归因且不扩面 | `sha256:19b53f98573093b904694fdb9680af0a99d5af75d4bc34bae0ad05e5c3bacde5` | 有效 |
| V37-13 | 类型边界 | core与owner-kernel各自`tsc --noEmit`；CLI同命令归因 | Unit37 core/owner/cli类型闭包 | 修复直接验证 / 低 / 已完成 | core、owner-kernel通过；CLI仅复现8个既有credentials类型错误，未出现U37相关错误，不以该受限基线冒充全CLI类型通过 | 同上 | 有效 |
| V37-14 | 当前源码最终可消费构建 | `pnpm build`唯一同输入执行；核对全部workspace dist连续更新时间 | 17个工作区包与当前41文件专项源码/依赖闭包 | 修复直接验证 / 中 / 已完成 | 17个包产物在同一构建窗口依序更新至CLI最终产物；构建进程正常结束，未重复同输入构建 | 同上 | 有效 |
| V37-15 | 派生资产、差异卫生与专项冻结 | `pnpm s7:lint`；`git diff --check HEAD`；41文件逐文件SHA-256后聚合 | 当前生产入口、S7 descriptor/mutation/registry golden及41个生产/测试/架构规格文件，排除过程账本与独立清单 | 冻结前检查 / 低 / 已完成 | S7 20/20与registry golden通过；diff check通过；41文件聚合指纹稳定 | 同上 | 有效 |
| V37-D01 | 隔离补充测试的readiness读取计数差异 | 单例运行`binds exact runtime facts and rejects readiness drift before received`并对比HEAD相关生产/测试差异 | setup-delivery与该测试均未被Unit37修改；ConversationProtocolRuntime仅新增closure item/read-back API | 失败归因 / 低 / 已完成 | 诊断为既有脆弱计数断言：实际两次有效快照读取后一次漂移读取，最终仍以capability-gap拒绝；不属Unit37且不改实现/测试 | 同上 | 诊断 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-37.gen-1 -->
