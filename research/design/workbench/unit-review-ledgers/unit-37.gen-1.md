# 单元登记:第 37 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:37
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-12
- **登记来源**:用户要求将第 37 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U37-01、U37-02、U37-03、U37-05 已在同一专项冻结指纹上完成实现、最小必要验证、F37-21～F37-28 事实链复核与四路冷启动对抗，四项均为已验证；U37-04/U37-06 及既有排除继续复用，受影响独立审查节点已转为待复核，尚未进入全单元终审或提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否（仅冻结本批专项交付物指纹；未进入全单元冻结准备）
- **交付物文件集**:53 个 Unit37 生产、直接测试、派生结构检查及分布式运行时架构/规格文件；过程账本与独立审查清单不计入交付指纹
- **当前交付物指纹**:`sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61`（U37-01/U37-02/U37-03/U37-05 同根重开专项冻结）
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
| U37-01 | **P0/大，同根重开。** `HostStopCoordinator` 已把 `operationId/strategy/frozen` 传给静态 port，但 production `stopPort()` 主动丢弃 `operationId` 与 `frozen`，read-back 只查当前聚合计数；`closeAdmission()` 只拒 inbound 并停 conversation recovery，随后仍顺序采样十类 producer；`flushDurableState()` 只 checkpoint lifecycle log，lease/permit 是空 governor step；executor-only 的 SIGINT/SIGTERM 直接 resolve 并拆 runtime，完全旁路 journal/coordinator。**价值裁决记录：**原 U37-01 曾按专项指纹判为已验证；C37-C02 的当前生产源码满足重开条件。保持现状会在受支持三形态丢失冻结后新进或未刷稳的工作，修规则不能删除规范已明确的三形态 stop 合同；复用现有 coordinator、静态 ports、owner readers/outbox 与 governor 即可根治，无需通用 lifecycle，故保留 P0/大。 | operation-scoped frozen artifact 只被 coordinator 保存，未成为 producer gate、owner settlement/read-back、flush/permit 与 executor-only 退出的共同授权输入；因此 `ready-to-stop` 证明的是“某时刻聚合为空”，不是同一 accepted-work exact-set 已闭合。 | **生产端**：OS signal、CLI/RPC、executor-only、`HostStopCoordinator`、十类 owner 与各自 producer gate、authority/intent/final/delivery log/outbox、governor、supervisor。**类型组合**：immediate/drain/cancel，managed/on-demand/foreground，十类 owner 空/单/多，`accepted→gate-closed→work-settled→flushed→ready-to-stop` 每窗，timeout/blocker/permit、效果/响应丢失、同 PID 后继与连续重启。**消费者**：准入、公开 stop 状态、exact-host physical stop/terminal。**异常终态**：冻结后漏收束或误收束后继、伪 ready/terminal、gate 长期关闭。**审查/测试**：IR37-07～IR37-12、IR37-32、IR37-34～IR37-38、IR37-40；production ports、executor role 与真实 owner/outbox 的直接场景证据。 | 保留一个 `device-lifecycle` coordinator：在现有十个静态 port 上补齐 operation-scoped producer close/read-back，全部 gate 全等关闭后才一次冻结；`settle/readBack` 必须消费该 owner 的 frozen `id+revision`，同 id 换代不得代替旧项或被误停，空集零效果。按原 strategy 收束后刷稳同一 frozen set 涉及的 authority/assignment/intent/final/delivery 日志与 outbox，拒新 permit 并回读 frozen lease/permit/物理步骤为零，才推进 `work-settled→flushed→ready-to-stop`。OS signal、CLI/RPC 与 executor-only 都生成/重放同一 exact-host operation，executor-only 仅在 ready 后走既有 teardown；不改已验证 endpoint lock/manager stop。验收以真实三形态生产装配覆盖三策略、十类非空与每个故障窗，证明 frozen item 恰一终结、后继 revision/exact host 零误停、无强杀且连续重启唯一前滚。**修复后证据：**十个 production port 已接收并回读同一 `operationId+frozen id/revision`，全部 producer gate 在冻结前关闭，scheduler tracker 在外部 activation 前登记，executor-only signal 接入同一 coordinator；直接测试、S7 与完整构建通过，F37-21/F37-22 在当前指纹复核通过。 | 已验证 |
| U37-02 | **P1/小，同根重开。** target journal 已让 signed abort 与 ready 耐久互斥；但 `journal.abort()` sync 后、local/external gate release 或 `target-aborted` peer-effect 前崩溃时，`restoreLocalAdmissionGate()` 会跳过 aborted operation，重放又无条件调用要求当前 operation 的 `releaseDeviceRemovalFreeze()`，无 gate 会抛错，错误 gate 还缺少统一的防误释放语义。**价值裁决记录：**原 U37-02 的 ready/revoke/cleanup-ready/terminal-only/lost 主链继续有效，跨根 requestId 同一性仍不恢复；C37-C04 只重开 abort 后恢复。该窗口可让 issuer guard 永久阻断后续迁居/撤销且连续重启不自愈，P2 不足；只收紧既有 release 与 receipt replay，故保留 P1/小。 | durable aborted 是胜负唯一事实，却未同时成为 gate release 的幂等授权与 signed aborted receipt 的确定性重放起点；恢复错误地要求易失 gate 对象仍存在。 | **生产端**：两 target 根的 target journal、local/external gate、aborted receipt artifact/peer-effect、issuer guard 与 terminal-only 重投。**类型组合**：abort sync 前后、gate 为同 operation/不存在/其他 operation、release/receipt 各效果与响应窗、abort/ready 竞争、同/异 identity 与连续重启。**消费者**：target 准入、issuer selector/current-authority guard、后续 removal/migration。**异常终态**：target 已 durable aborted 而 issuer 永久等待 authenticated terminal，或迟到旧 abort 误开新 gate。**审查/测试**：IR37-19、IR37-32、IR37-36、IR37-38、IR37-40；真实双根日志、gate 与 mesh receipt 重放。 | 仅以完整 identity 的 durable aborted 授权现有 release：gate 属同 operation 则释放并 read-back，已不存在视为该效果完成，属其他 operation 必须零副作用拒绝；local 与 external gate 使用同一判定。随后优先 hydrate 已有 `target-aborted` peer-effect；不存在时只从 durable identity+signed abort 确定性重建同一 signed receipt、耐久 peer-effect 后返回，issuer 收到它才释放 guard。ready 已赢仍返回原 ready，不改其余跨端主链。验收穿过真实两根 `AuthorityCommitLog` 与认证 mesh，逐窗注入效果/响应丢失、错误 operation、竞争和连续重启，证明 release 恰一、错 gate 零误开且 authenticated terminal exact replay。**修复后证据：**durable aborted replay 先对 local/external gate执行同 operation 幂等 release，再返回已有 signed receipt；无 gate 视为已完成，错 operation fail-closed，direct fault test 覆盖 receipt 已存在仍先 release。F37-25/F37-26 在当前指纹复核通过。 | 已验证 |
| U37-03 | **P0/中，同根重开。** durable removal decision 已冻结 conversation 与十类 `ownerItems(id,revision)`，但 `ExecutorRemovalTarget.decide()` 只把 `operationId` 交给 external settlement，把 conversation ids 交给 local aggregate assertion；`settleAcceptedWork()` 与 `assertDeviceRemovalSettled()` 都不消费 decision ownerItems，DeferredGlobalIntent、final/delivery outbox、remote/channel/scheduler/delivery、lease/permit 的 frozen revision 可在未逐项终结时越过 `authority-settled`。**价值裁决记录：**effect-free preflight、artifact decision、漂移重显与 C37-C01 lifecycle completion 保持已闭合，广义 manifest 仍排除；C37-C03 满足“既有 frozen closure 未被消费”的重开条件。该断链位于不可逆 ready/revoke 前并可截断真实 accepted work，只扩既有 settlement/readers 即可，故保留 P0/中。 | decision artifact 与 owner settlement 之间没有必填的 exact-set 合同；生产链在效果阶段重新读取聚合状态，无法证明处理的是用户确认且耐久冻结的同一 owner generation。 | **生产端**：两 target 生产根、target decide/resume、local/external owner readers、AuthorityTransfer/delete、ready signer。**类型组合**：十类 owner 空/单/多、id/revision、同 id 换代、transfer/destroy、migration 清退复用、`authority-decided→authority-settled→revocation-ready` 每窗、效果/响应丢失与连续重启。**消费者**：signed ready、issuer revoke、cleanup/uninstall migration。**异常终态**：旧项未闭合或后继项被误处理却推进 ready/revoke。**审查/测试**：IR37-16、IR37-18、IR37-20、IR37-28、IR37-31、IR37-34、IR37-36～IR37-38、IR37-40；真实两根 owner/read-back 场景。 | 不改 journal、decision 或 artifact：`decide()/resume` 只 hydrate 同一 decision，并把 `mode+ownerItems` 作为 local/external settlement 必填输入；按固定 owner 分组复用现有 reader，以 frozen `id+revision` 授权既有 settle，conversation 权威达到所选 transfer/destroy 终态，其余 obligation/outbox/lease/permit 达到各自耐久终态并 exact read-back。同 id 不同 revision 在新效果前 fail-closed，已终结 exact replay；所有组全等闭合后才写 `authority-settled` 并签同 decision 的 ready。验收覆盖两 target 根、十类非空、同 id 换代、两 mode、migration 复用、各响应窗和连续重启，证明 frozen old generation 恰一收束且 successor 零误处理。**修复后证据：**decision 的 `mode+ownerItems` 已成为 local/external settlement 必填输入，固定 owner 分组均以 frozen id/revision 做前后 read-back，缺失 legacy ownerItems fail-closed；两 target 根共享同一签名合同。F37-23/F37-24 在当前指纹复核通过。 | 已验证 |
| U37-04 | **P2/小。** current-home path/SecretStore作用域、公开响应等待`onRemoved`及pre-runtime拒旧identity均已成立；剩余事实是`rm(...recursive)`把任意大树作为一个governor step，且本机`terminal`先于`onRemoved`里的device-key删除。**价值裁决记录：** 原P0/大声称跨home误删并留下可用旧key；home-scoped store、`assertOwnedPath`、trust revoke与pre-runtime已证伪，改为P2/小。仅当共享store、响应早于key删除或旧key可重新准入时重开P0/P1。用户体验与架构均达标。 | bulk cleanup、supervisor unregister、非device秘密、cleanup-ready、issuer terminal、exact key与本机terminal没有被表达成固定且可恢复的key-last顺序。 | **生产端**：冻结removable roots、storage governor、安全文件原语、home SecretStore、`unregisterFutureExact`、device-key store、target/issuer journal与pre-runtime。**类型组合**：小/大树、部分删除、registration/cleanup-ready/issuer terminal/key各窗口、错slot、效果/响应丢失、连续重启。**消费者**：removed状态、旧identity准入、当前进程safe exit。**异常终态**：单步大删除长期占用maintenance，或terminal前仍需补删key；当前无跨home删除/身份复活。**审查/测试**：IR37-22、IR37-24～IR37-25及IR37-31～IR37-32、IR37-37～IR37-38交界。 | 只改现有cleanup：对现有固定removable roots（不含当前`device-lifecycle`日志/evidence与独立checkpoint）逐个做home/path校验，用窄bottom-up walker每次最多128个dirent（文件/符号链接unlink、空目录rmdir）作为一个现有governor step；重启从同一root重扫，缺失项幂等，不建manifest。完成文件批次后执行`unregisterFutureExact`并read-back absent；现有`SecretStore.list("")`结果按稳定顺序分成128项批次，删除当前home全部非device-key ref并逐项read-back，写`cleanup-complete`。key仍在时生成并耐久U37-02 `cleanup-ready`回执，取得同operation issuer签名terminal后，target finalizer才以冻结`targetDeviceId+deviceKeyGeneration`调用现有device-key compare-delete/read-back，把key evidence与issuer terminal写本机terminal，`onRemoved`只安全退出。pre-runtime遇已有issuer terminal且key已缺失时不建key/角色，幂等补本机terminal后拒绝启动；未取得issuer terminal时保留key仅供terminal-only重驱。验收覆盖>128 exact-set、深目录/链接、部分批次、registration/cleanup-ready/issuer terminal/key各效果与响应窗口、错home/错slot/后继key及连续重启，证明本机terminal时exact key已缺失而其他home、独立checkpoint和后继slot不变。 | 已验证 |
| U37-05 | **P0/小，同根重开。** 首个/final checkpoint 的同 root 真解封已成立；当前 `#decideRetirement()` 把多条 exposure 与一条 lifecycle 写在一个 commit envelope，却返回 `context.nextLsn + compromised.length`，而 WAL 只为整个 envelope 增加一个 LSN；竞争调用在 projection 已见 `retirement-decided` 时还返回当前 `context.lastLsn`，它可能已越过该 decision envelope。**价值裁决记录：**原 U37-05 的真解封与 final verify 不恢复；C37-C05 把重开范围收窄为 live/竞争/replay watermark。active exposure 是受支持状态，错误位于不可取消 retirement 后，会让正确 final checkpoint 永久被拒；改验收或要求用户重启都不成立，复用现有 envelope/record LSN 即可，故保留 P0/小。 | transaction 把 logical entry 数量和当前日志尾都误当作该 operation 的物理 decision LSN，没有把唯一 commit envelope 的实际 LSN贯穿 live winner、并发 loser 与历史 replay。 | **生产端**：retirement projection transaction、0/1/多 exposure entries、lifecycle record、exact-record replay、final checkpoint verify。**类型组合**：同 envelope 多 entry、并发 decision、decision/final force 效果与响应丢失、后续无关 append 与连续重启。**消费者**：`upToLsn>=decisionLsn` 门禁、cleanup/terminal。**异常终态**：final 已覆盖真实 decision 仍被拒，backup uninstall 在不可逆 gate 后停摆。**审查/测试**：IR37-30～IR37-31、IR37-34、IR37-36、IR37-40；真实 WAL envelope 与 checkpoint service。 | 保留原 transaction 与真解封：append winner 的 watermark 只取该 commit envelope 的 `context.nextLsn`（或等值 `commit.lsn`），不得加 logical entry 数；projection 已见 decision 的并发/响应丢失分支不得返回 `lastLsn`，必须读取该 operation 唯一 `retirement-decided` record 所在 envelope LSN，历史 replay 同源。验收用真实 log 覆盖 0/1/多 exposure、同 envelope 多 entry、decision 竞争、其后追加无关 record、final force/verify 各窗与连续重启，证明 live/loser/replay 水位全等，final 同 root 覆盖实际 decision 后可唯一前滚。**修复后证据：**append winner 只返回 `context.nextLsn`，已见 decision 与历史 replay 均扫描该 operation 的 exact lifecycle record envelope LSN；多 exposure 同 envelope 的直接测试证明 final checkpoint 以真实水位前滚。F37-27/F37-28 在当前指纹复核通过。 | 已验证 |
| U37-06 | **P2/小。** response codec已用exact keys，但server `device.*`/`server.uninstall.*`和mesh request handler只`asRecord/decodeObject`后取字段，unknown keys被忽略；已验证字段仍严格，尚无unknown key改变授权或结果。**价值裁决记录：** 原P1/中把strict输入、S7和全部证据充分性合成一项；无当前越权/错效果，泛化S7会重复维护，故只保留facade strict输入并降P2/小。仅当unknown字段改变签名身份/授权/终态或出现registry外第二入口时重开P1。用户体验与架构均达标。 | Unit37公开request没有在方法分派后、任何lifecycle调用前复用现有plain-object+exact-key检查，造成同一协议的request与response规范化边界不一致。 | **生产端**：server `device.remove/continue/status`、五个`server.uninstall.*` loopback方法、target/issuer及U37-02 terminal-only mesh facade。**类型组合**：合法、unknown、缺失、错类型、旧peer/version。**消费者**：current-anchor/loopback/有限mesh handler与公开行动错误。**异常终态**：非规范客户端误以为扩展字段生效；当前合法路径和安全决定不变。**审查/测试**：IR37-33及IR37-35、IR37-37、IR37-40交界。 | 在现有server method文件与removal mesh文件各复用其已有plain-object/exact-key helper，分支确定后立即校验：device.remove=`requestId,operationId,targetName`，continue=`targetName,mode`，status=`targetName`；uninstall preflight=空，begin migration=`path,requestId,operationId,transferId,targetName`、backup=`path,requestId,operationId,recoveryPackage`，continue=`operationId,confirmBackup,recoveryPackage`，cancel/status=`operationId`；target/issuer每个op及terminal-only握手按各DTO的`v,op`和必填载荷exact-set校验。随后才做类型/签名/授权与调用生产对象；unknown/缺失/错类型统一映射现有稳定invalid/unavailable错误，旧peer在任何journal/gate效果前拒绝。仅补这些facade直接测试，合法输入字节与行为不变；不扩S7 registry、runner、状态DTO或重复元数据。 | 已验证 |

## U37-01～U37-06 收敛事实矩阵

> 本矩阵记录修复后的专项事实链与验收闭包。当前有效四路冷启动对抗统一绑定交付物指纹 `sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61`。
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

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V37-01 | 六项生产闭包的直接合同与场景证据 | core lifecycle 6/6、mesh checkpoint/key 22/22、server lifecycle/RPC 43/43、CLI stop/removal/uninstall主闭包33/33及补充定向60/60 | 当前42文件专项交付闭包 | 修复直接验证 / 低中 / 已完成 | 历史通过；C37-C02～C37-C05 已使受影响输入与结论失效 | `sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0` | 失效 |
| V37-02 | 类型与最终可消费构建 | `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit`；`pnpm build`（上游与主输入）；新增CLI源后`pnpm cli:build` | core/mesh/server/cli源码与当前workspace依赖 | 修复直接验证 / 中 / 已完成 | 历史通过；当前源码与构建产物已变化 | 同上 | 失效 |
| V37-03 | 派生资产与结构合同 | `pnpm s7:lint` | S7 descriptors、coverage tests、registry golden及当前生产入口 | 派生资产预检 / 低 / 50.5s | 历史通过；本轮S7 descriptor与mutation test已变化 | 同上 | 失效 |
| V37-04 | 交付卫生与专项冻结 | `git diff --check HEAD`；42文件逐文件SHA-256后再聚合 | 全部Unit37变更生产/测试/架构规格文件，排除过程账本与清单 | 冻结前检查 / 低 / 已完成 | 历史指纹，已被当前53文件交付闭包替代 | `sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0` | 失效 |
| V37-05 | U37-01/U37-02/U37-03/U37-05 受影响闭包直接证据 | CLI host-stop/device-removal/anchor-uninstall 17/17；local owner/executor role 14/14；core delivery 32/32；owner scheduler 11/11 | 本轮 stop/removal/abort/LSN 生产实现与直接测试 | 修复直接验证 / 中 / 已完成 | 74/74通过；额外9/9 abort子集复跑通过；含真实 lifecycle log/artifact、owner gates、scheduler activation、delivery与多 exposure WAL checkpoint | `sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61` | 有效 |
| V37-06 | 类型与最终可消费构建 | `pnpm --filter @zhixing/cli exec tsc --noEmit`；`pnpm build` | 当前workspace源码、上游dist与53文件Unit37闭包 | 修复直接验证 / 中 / 16.4s+179s | 全量构建成功；CLI类型检查仅有既有config-editor/startup 8项基线，Unit37零新增 | 同上 | 有效 |
| V37-07 | 派生资产与结构合同 | `pnpm s7:lint` | S7 stop/removal descriptor、mutation tests、registry golden及当前生产入口 | 派生资产预检 / 低 / 已完成 | 20/20通过，registry golden一致；mutation覆盖executor-only coordinator与ownerItems传递 | 同上 | 有效 |
| V37-08 | 交付卫生与专项冻结 | `git diff --check`；既有42文件闭包与本轮差异取并集后逐文件SHA-256再聚合 | 53个Unit37生产/测试/S7/架构规格文件，排除过程账本与独立审查清单 | 冻结前检查 / 低 / 已完成 | diff check通过；53文件存在且聚合指纹稳定 | `sha256:64e8c066b376cf8f8726abbeb4db6c89cc82e7e3bf520838c08a0cb611ed3f61` | 有效 |
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
