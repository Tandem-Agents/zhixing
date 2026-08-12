# 单元登记:第 37 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:37
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-12
- **登记来源**:用户要求将第 37 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U37-01～U37-06 已在同一专项交付指纹上完成实现、最小必要验证与四路冷启动对抗；六项均已验证，尚未进入全单元独立复审或提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否（仅冻结本批专项交付物指纹；未进入全单元冻结准备）
- **交付物文件集**:42 个 Unit37 生产、直接测试及分布式运行时架构/规格文件；过程账本与独立审查清单不计入交付指纹
- **当前交付物指纹**:`sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0`（U37-01～U37-06 专项冻结）
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
| U37-01 | **P0/大。** `HostStopCoordinator` 的六个opaque callback只drain inbound/jobs、cancel conversations、checkpoint lifecycle log并执行空governor step；executor-only signal仍绕过coordinator，`isHostStopped()`又把managed `instanceId`截成PID只查存活。故`work-settled/flushed/terminal`均可在F37-04未闭合、callback无界挂起或PID被后继复用时失真。**价值裁决：保留。** 安全停机是Unit37核心路径；保持现状或放宽终态会丢accepted work或误判/误停后继实例，复用既有owner、governor与supervisor即可，不需要通用lifecycle。用户体验与架构均达标。 | stop没有一个由F37-04固定owner readers产出的、gate关闭后冻结且可逐项read-back的`HostStopAcceptedWorkSnapshot`；入口也未统一到同一operation，最终停止事实没有同时反绑endpoint lock代际与service manager投影。 | **生产端**：OS signal、CLI/RPC stop、executor-only runtime、`HostStopCoordinator`、lifecycle log、F37-04 owners/outbox、governor、三平台supervisor与本机endpoint lock。**类型组合**：immediate/drain/cancel，managed/on-demand/foreground，全部owner空/非空，每phase，deadline/blocker/flush/permit/manager，效果/响应丢失、PID successor与连续重启。**消费者**：conversation/channel/scheduler/delivery/assignment准入、公开stop状态与future launch。**异常终态**：漏收束、gate误开、无界等待、伪terminal或误停新代。**审查/测试**：IR37-07～IR37-12、IR37-35、IR37-38；真实owner/outbox/governor/supervisor/lock固定切点。 | 在Unit37现有stop runtime内用一个静态`HostStopAcceptedWorkPorts`替换opaque closure：`accepted`后幂等关闭conversation/turn/assignment、remote/channel/scheduler/delivery及permit新准入，read-back成功才写`gate-closed`并把F37-04各项稳定id/revision和完整expected endpoint lock（pid/port/startTime/startedAt）写入现有evidence artifact，managed `instanceId`只作为该锁代际的稳定摘要。`immediate`把同一snapshot逐项推进到下一耐久可重放点，`drain`推进到终态，`cancel`写既有cancel事实并等待不可取消步骤；随后逐owner核对snapshot闭合，flush authority/assignment/intent/final/delivery logs与outbox，拒新permit并等待既有permit/物理步骤归零，才写`ready-to-stop`。managed外部driver先全等复验expected lock与definition，再调用现有`stopCurrentExact(spec,expectedInspection)`；lock已换代则禁止manager stop，只有旧lock已不存在且独立manager inspect证明旧任务不再running时才为旧operation补terminal。on-demand/foreground按同一exact lock自退出。OS signal、CLI/RPC、executor-only只进入该coordinator；每步使用现有deadline/signal，失败保持gate与operation。验收以三策略×三形态覆盖F37-04全项、每phase sync/效果/响应窗口、timeout/blocker/permit/manager、PID复用/lock successor与连续重启，证明零强杀、future definition不删、后继零误停且只补原operation缺失效果。 | 已验证 |
| U37-02 | **P0/大。** target `accept()/abort()`在识别aborted replay前执行close/freeze或重复release；issuer先本地abort后best-effort远投，revoke只停在`revoked`，普通trust admission又先拒revoked target；`commitLost()`还伪造`authority-settled/revocation-ready`。响应丢失会留下单端abort、冻结gate或无target terminal。**价值裁决记录：** 原结论还把两根requestId不同本身认定为根因；signed receipt只要求operation/device/member generation/issuer/trust全等，不要求共享requestId，故删除该主张。新决定为改写后保留P0/大；仅当requestId后来进入签名授权并出现生产失败时重开该子项。用户体验与架构均达标。 | 两根同一operation没有在现有`device-lifecycle` projection内持有“issuer命令待target裁决、target durable winner、issuer terminal待target消费”的peer-effect事实；所有入口也未先以accepted receipt identity判terminal，导致abort/ready竞态与跨端terminal无法唯一排序。 | **生产端**：issuer/target两根AuthorityCommitLog、accept/decide/abort/ready/revoke/cleanup-ready/terminal、lost分支、认证mesh handshake/service与pre-runtime resumer。**类型组合**：anchor+executor/executor-only target，同/异receipt identity，各phase，abort/prepare-ready/revoke竞争，在线转离线、始终离线/已accepted后lost、效果/响应丢失、revoked后查询、迟到请求与连续重启。**消费者**：双方gate、selector/fresh dispatch、trust/exposure、route/capability、target cleanup。**异常终态**：单端abort、僵尸gate、重复效果、revoked无terminal、key删除后失去重连能力、lost伪ready或旧身份复活。**审查/测试**：IR37-03、IR37-15、IR37-19、IR37-23、IR37-26、IR37-32～IR37-33、IR37-36～IR37-37；真实两根日志、握手与断连。 | 只扩现有executor-removal record/reducer：在同一operation projection加入窄`peer-effect`，保存issuer签名abort/revoked terminal、target签名`aborted/cleanup-ready`回执及其ack；pending effect冻结issuer竞争phase与guard，恢复扫描原记录重投。cancel线性化在target journal：abort先赢则target耐久aborted并回原回执，issuer收到后才写aborted/释放guard；ready已先耐久则同一abort请求返回原signed ready，issuer清除cancel-attempt并继续原revoke，禁止产生第二终态。target的accept/decide/abort/finish均先在journal transaction验`operationId/home/target member public key+device-key generation/accepted issuer/trust ancestor`并判winner，再执行gate/owner/cleanup；迟到同载荷只回原结果。reachable路径由target ready授权issuer原子revoke；target完成bulk cleanup后、key仍在时耐久并提交`cleanup-ready`，issuer据此写本端terminal并返回签名terminal，target收到后才执行U37-04 key-last与本机terminal。普通mesh仍拒revoked设备，只在现有TLS身份验真与trust admission之间增加固定terminal-only分支：以历史target key证明generation，issuer从本根按该device找唯一accepted/terminal operation并返回signed accepted receipt；随后receipt+operation签名全等时仅允许取pending abort/issuer terminal及提交target回执，零registry/普通能力。lost在issuer根耐久lost decision后原子写revoke/exposure与`localData=unknown` terminal，跳过target-ready/cleanup；已持accepted的迟到target把issuer terminal写为保留本地数据的lost-terminal并由pre-runtime拒旧身份，始终离线target无需伪造本地事实。验收穿过两根真实日志与认证mesh，覆盖各phase/效果/响应窗口、abort-vs-ready/revoke、cleanup-ready后断线、在线转离线、两类lost、错误identity和连续重启，证明恰一跨端终态且key删除前已取得可重放issuer terminal。 | 已验证 |
| U37-03 | **P0/中。** target `accept()`先close/freeze再返回摘要；离线begin固定报空。当前snapshot把pendingFinal当outbox、lease当permit，遗漏remote/channel/scheduler/delivery obligation，settled也不重读DeferredGlobalIntent等；重启后旧decision只验operation/home/target，不与当前owner投影全等。用户会在不完整后果上选择并可能漏转/漏删accepted work。**价值裁决记录：** 原结论P0/大并提出广义manifest；现有conversation snapshot、pendingClosureWork、intent、outbox、owner journal与decision artifact已足够，故改为固定Unit37 DTO的P0/中。仅当这些owner不能产出F37-04闭包时重开大工作量。用户体验与架构均达标。 | 没有一个在业务副作用前可展示、在gate关闭后可冻结、并由decision/ready共同反绑的`ExecutorRemovalPreflightSnapshot`；counts替代稳定item identity/revision使重启无法证明消费的是同一集合。 | **生产端**：device remove CLI/RPC、target accept/decide、local owner、AuthorityTransfer/delete、intent/final/delivery outbox、remote/channel/scheduler/delivery obligation、lease/permit/managed instance、decision artifact与ready。**类型组合**：F37-04各项空/单/多，transfer/destroy，在线/离线unknown，snapshot漂移，首次/重启及不可逆边界。**消费者**：用户选择、transfer/delete、target ready、issuer revoke。**异常终态**：副作用后才发现负载、旧decision误用、漏转/漏删或未settled即ready。**审查/测试**：IR37-13、IR37-16、IR37-18、IR37-20、IR37-34、IR37-36、IR37-38；真实owner/intent/outbox/obligation/lease/permit。 | 复用U37-01同一静态F37-04 readers但定义removal专用DTO：target验真并耐久accepted receipt后先只读全部owner，返回名称、`known|unknown`和snapshot digest，零gate/abort/transfer/delete；offline固定返回unknown并只允许wait/lost。用户提交transfer/destroy时先关闭全部本地准入，再冻结每项稳定id/revision及managed generation；若与已展示digest不等，立即释放gate、返回新摘要且不写decision。全等时把canonical snapshot bytes写入现有artifact并在同一transaction声明candidate reference，同一lifecycle evidence反绑snapshot ref/digest、mode、current-anchor identity，随后只重放该decision。transfer/delete前及target ready前逐项调用既有owner收束并read-back原snapshot：conversation authority/active run+interaction/pending final+assignment/DeferredGlobalIntent/RunFinalOutbox+delivery outbox/remote+channel+scheduler+delivery obligation/lease/permit均须达到所选终态，managed instance保持同代；漂移只在首个不可逆效果前重显，之后新工作因gate不可进入。重启严格hydrate原artifact并核对refs，不以重算counts替代；ready签名绑定snapshot与closure digest。验收覆盖TTY/非TTY、offline unknown、F37-04空/非空、漂移前后、两模式每项效果/响应丢失及连续重启，公开输出零内部id且不新增manifest/第二事实源。 | 已验证 |
| U37-04 | **P2/小。** current-home path/SecretStore作用域、公开响应等待`onRemoved`及pre-runtime拒旧identity均已成立；剩余事实是`rm(...recursive)`把任意大树作为一个governor step，且本机`terminal`先于`onRemoved`里的device-key删除。**价值裁决记录：** 原P0/大声称跨home误删并留下可用旧key；home-scoped store、`assertOwnedPath`、trust revoke与pre-runtime已证伪，改为P2/小。仅当共享store、响应早于key删除或旧key可重新准入时重开P0/P1。用户体验与架构均达标。 | bulk cleanup、supervisor unregister、非device秘密、cleanup-ready、issuer terminal、exact key与本机terminal没有被表达成固定且可恢复的key-last顺序。 | **生产端**：冻结removable roots、storage governor、安全文件原语、home SecretStore、`unregisterFutureExact`、device-key store、target/issuer journal与pre-runtime。**类型组合**：小/大树、部分删除、registration/cleanup-ready/issuer terminal/key各窗口、错slot、效果/响应丢失、连续重启。**消费者**：removed状态、旧identity准入、当前进程safe exit。**异常终态**：单步大删除长期占用maintenance，或terminal前仍需补删key；当前无跨home删除/身份复活。**审查/测试**：IR37-22、IR37-24～IR37-25及IR37-31～IR37-32、IR37-37～IR37-38交界。 | 只改现有cleanup：对现有固定removable roots（不含当前`device-lifecycle`日志/evidence与独立checkpoint）逐个做home/path校验，用窄bottom-up walker每次最多128个dirent（文件/符号链接unlink、空目录rmdir）作为一个现有governor step；重启从同一root重扫，缺失项幂等，不建manifest。完成文件批次后执行`unregisterFutureExact`并read-back absent；现有`SecretStore.list("")`结果按稳定顺序分成128项批次，删除当前home全部非device-key ref并逐项read-back，写`cleanup-complete`。key仍在时生成并耐久U37-02 `cleanup-ready`回执，取得同operation issuer签名terminal后，target finalizer才以冻结`targetDeviceId+deviceKeyGeneration`调用现有device-key compare-delete/read-back，把key evidence与issuer terminal写本机terminal，`onRemoved`只安全退出。pre-runtime遇已有issuer terminal且key已缺失时不建key/角色，幂等补本机terminal后拒绝启动；未取得issuer terminal时保留key仅供terminal-only重驱。验收覆盖>128 exact-set、深目录/链接、部分批次、registration/cleanup-ready/issuer terminal/key各效果与响应窗口、错home/错slot/后继key及连续重启，证明本机terminal时exact key已缺失而其他home、独立checkpoint和后继slot不变。 | 已验证 |
| U37-05 | **P0/中。** `AnchorUninstallCoordinator`在`force()`后立即以`status()`要求新checkpoint已recoverable；真实`AuthorityCheckpointOwner.force()`只`recoverPending→createAndReplicate→cleanupExpired`，只有`AuthorityCheckpointService.verify(checkpointId,recoveryRoot)`才从冻结target读取、真解封、`assertFullBinding`并写`checkpoint-verified`。owner port与uninstall入口均未传入recovery root，fake测试则同步自报ready；当前identity的`checkpointGeneration`还由旧checkpointId/LSN派生，不能代表随后两次forced checkpoint共享的authority/target代际。首个checkpoint稳定失败；绕过会在假备份上retire唯一anchor。**价值裁决：保留。** backup卸载是无迁居目标时的核心路径，现有service/recovery package已足够。用户体验与架构均达标。 | uninstall把replicated误当verified，并混淆“稳定checkpoint authority/target generation”与“每次checkpoint identity”；一次性recovery package、verification digest及retirement decision LSN也未贯穿首个/final验证与重启继续。 | **生产端**：CLI/loopback uninstall、recovery-package decoder、`AnchorUninstallCoordinator`、checkpoint owner/service、FileArtifactStore/独立target、recovery root、retirement transaction与cleanup。**类型组合**：首个/final，空/非空catalog/retained，target/authority generation/checkpoint identity/decision LSN，create/replicate/read/unseal/verify各sync/响应窗口、篡改与连续重启。**消费者**：后果确认、本机lifecycle continuation、retirement、fresh gate、cleanup/terminal。**异常终态**：backup路径不可用，或在不可恢复/错误代际备份上退役唯一权威。**审查/测试**：IR37-29～IR37-31、IR37-34、IR37-36、IR37-40；真实store/target/root。 | 给现有`AuthorityCheckpointOwnerPort`只增加透传既有service的`verify(checkpointId,recoveryRoot)`；CLI沿现有`readRecoveryPackageFromTty/decodeRecoveryPackage`取得一次性root，loopback RPC以strict字段传入，在零accepted前strict decode并冻结target/root binding，禁止落日志/artifact/配置。accept identity中的`checkpointGeneration`改为冻结`homeId+anchorEpoch+trustHead+targetId+recipientKeyId+recovery root keyId`的service generation；首个/final各自checkpointId、envelope digest与upToLsn只进入对应evidence。`beginRecoveryBackup`先`force(pre)`，再`verify`从冻结target真解封；全等核对service generation、checkpointId/targetId、envelope/manifest、records/catalog/retained refs与verification root后，才写verification digest并显示后果。用户确认后原子写retirement decision并冻结其LSN，`force(final)`后用同一root再次verify，要求同service generation且`upToLsn>=decisionLsn`、完整exact-set含retirement/exposure，才写`final-checkpoint-verified`并授权cleanup。root不耐久；进程退出停在原phase，pre-runtime只恢复gate并保留现有loopback uninstall continuation，不自动调用verify/开放current-owner准入，用户以同operation重新输入package后前滚。验收必须穿过真实FileArtifactStore、retirable target、service.verify和recovery root，覆盖首个/final各sync/响应窗口、空/非空retained、错/篡改package、target/generation/checkpoint/LSN及连续重启，禁止fake owner通过`status()`自报验证。 | 已验证 |
| U37-06 | **P2/小。** response codec已用exact keys，但server `device.*`/`server.uninstall.*`和mesh request handler只`asRecord/decodeObject`后取字段，unknown keys被忽略；已验证字段仍严格，尚无unknown key改变授权或结果。**价值裁决记录：** 原P1/中把strict输入、S7和全部证据充分性合成一项；无当前越权/错效果，泛化S7会重复维护，故只保留facade strict输入并降P2/小。仅当unknown字段改变签名身份/授权/终态或出现registry外第二入口时重开P1。用户体验与架构均达标。 | Unit37公开request没有在方法分派后、任何lifecycle调用前复用现有plain-object+exact-key检查，造成同一协议的request与response规范化边界不一致。 | **生产端**：server `device.remove/continue/status`、五个`server.uninstall.*` loopback方法、target/issuer及U37-02 terminal-only mesh facade。**类型组合**：合法、unknown、缺失、错类型、旧peer/version。**消费者**：current-anchor/loopback/有限mesh handler与公开行动错误。**异常终态**：非规范客户端误以为扩展字段生效；当前合法路径和安全决定不变。**审查/测试**：IR37-33及IR37-35、IR37-37、IR37-40交界。 | 在现有server method文件与removal mesh文件各复用其已有plain-object/exact-key helper，分支确定后立即校验：device.remove=`requestId,operationId,targetName`，continue=`targetName,mode`，status=`targetName`；uninstall preflight=空，begin migration=`path,requestId,operationId,transferId,targetName`、backup=`path,requestId,operationId,recoveryPackage`，continue=`operationId,confirmBackup,recoveryPackage`，cancel/status=`operationId`；target/issuer每个op及terminal-only握手按各DTO的`v,op`和必填载荷exact-set校验。随后才做类型/签名/授权与调用生产对象；unknown/缺失/错类型统一映射现有稳定invalid/unavailable错误，旧peer在任何journal/gate效果前拒绝。仅补这些facade直接测试，合法输入字节与行为不变；不扩S7 registry、runner、状态DTO或重复元数据。 | 已验证 |

## U37-01～U37-06 收敛事实矩阵

> 本矩阵记录修复后的专项事实链与验收闭包。四路冷启动对抗统一绑定交付物指纹 `sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0`。
>
> 修复执行状态：`F37-09～F37-20` 全部落地并逐格复核；U37-01～U37-06 均已验证，未进入全单元终审或提交验证。

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

### 四路冷启动对抗复审

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

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V37-01 | 六项生产闭包的直接合同与场景证据 | core lifecycle 6/6、mesh checkpoint/key 22/22、server lifecycle/RPC 43/43、CLI stop/removal/uninstall主闭包33/33及补充定向60/60 | 当前42文件专项交付闭包 | 修复直接验证 / 低中 / 已完成 | 全部适用断言通过；含真实owner、双根日志、artifact/checkpoint、SecretStore、facade及C37-C01重放 | `sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0` | 有效 |
| V37-02 | 类型与最终可消费构建 | `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit`；`pnpm build`（上游与主输入）；新增CLI源后`pnpm cli:build` | core/mesh/server/cli源码与当前workspace依赖 | 修复直接验证 / 中 / 已完成 | CLI构建成功；类型检查仅有8项既有config-editor/startup基线，Unit37零新增 | 同上 | 有效 |
| V37-03 | 派生资产与结构合同 | `pnpm s7:lint` | S7 descriptors、coverage tests、registry golden及当前生产入口 | 派生资产预检 / 低 / 50.5s | 20/20通过，registry golden一致 | 同上 | 有效 |
| V37-04 | 交付卫生与专项冻结 | `git diff --check HEAD`；42文件逐文件SHA-256后再聚合 | 全部Unit37变更生产/测试/架构规格文件，排除过程账本与清单 | 冻结前检查 / 低 / 已完成 | diff check通过；冻结专项指纹 | `sha256:7aa71cf3bff190967e2c458519844ea0f63bf4c5ba9780d965a83abd7e65c3c0` | 有效 |
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
