# 单元登记:第 34 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:34
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-09
- **登记来源**:用户要求将第 34 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U34-01～U34-08 已按 F34-01～F34-10 完成集中修复并在同一冻结指纹上通过受影响闭包的最小必要验证、专项事实链复核与四路冷启动对抗复审；八项均为“已验证”。本状态只完成本次问题修复收口，尚未进入本单元两轮冻结终审、独立功能审查或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅指本次 U34-01～U34-08 修复专项；正式单元终审仍按工作台闭环另行执行）
- **交付物文件集**:当前 `HEAD 735a3dcd…` 加工作区的第 34 单元修复交付，共 28 个非工作台功能、架构与测试路径：core 5、CLI 16、server 2、架构 3、S7 2；工作台文件不参与功能指纹
- **当前交付物指纹**:`6e7b3fadd1358c6b3af463814682f79c111d30fb1c01415f0da968f5cbd1f6d3`
- **架构来源**:`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`，以及已定稿开发清单 D34-01～D34-08

## 固定边界

- **功能范围**:仅支持用户从 current anchor 主动迁往另一台已配对、active、启用 anchor 角色且 ReadyProof 就绪的设备；交付 strict planned transfer、transfer-bound issuer key、source 准入关闭与 accepted-work 收束、独立 export/AuthorityCatalog/SourceFreezeProof、target 私有导入、唯一 AnchorTransferCommit、双端恢复与 forward-only、第一方接管、CLI/server 迁居旅程及两生产根 exact-set/必要证据
- **架构不变量**:current anchor 的唯一 `AuthorityCommitLog` / `ArtifactStore` / storage governor、S2 trust/mesh/SecretStore 与 current-authority resolver 是权威事实源；source commit 是唯一全局线性化点，commit 前可安全 abort，commit 后永久 forward-only；target 中间态不可服务，旧 issuer/epoch 永久拒绝；秘密、环境事实、workspace 原始路径和设备缓存不迁移
- **验收条件**:U34-01～U34-08 均达到“已验证”；P0/P1 清零；同一冻结指纹完成两轮冻结终审、独立功能审查与单元提交验证；planned 迁居在双生产根、真实非空义务/资产、故障恢复、资源/stop、第一方接管和产品旅程上取得成比例证据
- **必要上下游**:上游仅消费第 33 单元 current verified full recovery checkpoint、唯一 authority log/store/governor、S2 trust/mesh/SecretStore 及 S8 current-authority/current-owner 合同；下游只向第 35 单元冻结新的 current anchor/trust generation 和已提交 planned transfer 事实
- **明确不属于本单元**:第 35 单元 source-less/disaster recovery、恢复应用、`domain-reset`、pending-reenroll、凭据轮换与恢复旅程；第 36～38 单元；anchor 自动故障转移、quorum/witness、多 active anchor、全局连续同步、多目标/云；迁移 SecretStore 内容、环境事实、workspace 原始路径、设备缓存；第二事实源和通用迁移/路由/存储/同步/事务/outbox/事件总线/registry、监控、诊断、benchmark 或信息采集

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| `packages/core` 5 路径 | strict planned result、identity 与 `AuthorityCommitLog` 导出/消费边界；无新增 schema 或生成文件 | 协议直接测试、CLI 消费构建与 workspace build | 通过 |
| `packages/cli` 16 路径 | planned owner/target/phase/current-owner/CLI 生产装配及其直接测试；无独立生成物 | planned-transfer、first-party、DTO/selector 定向测试与 workspace build | 通过 |
| `packages/server` 2 路径 | management context、公开 DTO 与 server 直接消费者 | server 定向测试及 canonical registry 由现有 S7/golden 复核 | 通过 |
| 架构/需求/规格 3 路径 | planned fence、composite base、phase、late-ready 与产品入口合同须相互全等 | 三份文档与冻结实现逐项对账 | 通过 |
| S7 2 路径 | planned owner/target/driver/lifecycle/current-owner 的 descriptor、validator 与变异表 | `pnpm s7:lint`：18/18 及 registry golden 通过 | 通过 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| source accepted-work fence/closure | source `AuthorityCommitLog` 的 append guard、fence/closure 与 accepted token 投影 | append 队列内先接受既有写、再原子安装 guard；closure cursor 与冻结 head 全等 | fence 前后竞争、drain timeout、abort、响应丢失、重启 | 两生产根全部 source writer/trigger、catalog 与 target 恢复 | accepted exact-set 有限；fresh 零追加；pending 恰一落点 | 通过 |
| target private import 与 composite authority publication | per-transfer private store/journal、共享 CAS、target `AuthorityCommitLog` install envelope | retained exact-set 全验后提升；`installPlannedAnchorPrefix` 单次 WAL sync 发布 source base 与 target install/tail | 部分 I/O、共享 ref、publish/post-install 效果前后失败、重启 | source range/export、target importer、全部 log projection/read consumer | 固定 chunk/header；原 source envelope/LSN 保持；terminal exact replay | 通过 |
| current-owner/trust 与双端 phase driver | signed `HomeTrustRecord`、source/target durable journals、assembly current-anchor 投影 | source committed envelope；target install envelope；live/startup/reconnect 共用同一 phase driver | 旧 source/peer、断连、响应丢失、abort/commit 切点与连续恢复 | first-party router、planned management、mesh reconciliation、服务准入 | 同 identity 幂等重驱；commit 后 forward-only；abort 先本地复权 | 通过 |
| storage governor 与 planned lifecycle | device `storageMaintenance`、assembly closing promise/in-flight registry | 本地 read/decode/write/fsync step 取得 permit；closing gate 先拒新写再取消/等待在途 | 容量/磁盘、网络挂起、并发 stop、启动/重连恢复 | source/target range、private store/CAS、两生产根 lifecycle | 网络等待零 permit；固定块；stop 后零新 I/O | 通过 |
| late-ready reservation | target transfer journal 的 `{proofDigest,snapshot,expiry}` 与 readiness revision gate | target lifecycle 锁内 reserve；source commit transaction 内重验；启动公开准入前 rehydrate | ready 响应窗口漂移、expiry、断连、commit/abort 竞争、重启 | target ready/commit、source commit guard、service admission | 每 transfer 至多一项 reservation；pre-commit 漂移零 commit；post-commit 不倒退 | 通过 |
| 产品 selector 与装配证据 gate | side-effect-free readiness summary、opaque targetId、现有 S7 descriptor/golden | CLI 唯一 displayName/TTY 序号映射后才向 strict prepare 交付内部 ID | 重名、离线、stale prepare、builder/lifecycle 删除/替换/重复/绕过 | CLI/server DTO、两生产根与维护门禁 | 有限 DTO/method/constructor exact-set；不建新 runner | 通过 |

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
| U34-01 | **P0/大。**`stopAccepting` 只拒 inbound 与 scheduler；`AuthorityCommitLog` guard 在 `draining` 放行全部 entries；`abortAllAndWait` 超时不可判定，catalog 固定写空 `pendingObligations`。durable fence 后仍可 fresh append，freeze 也可在 accepted work 未终态时宣称静止。 | source 的入口准入、log append guard 与 accepted-work 耐久闭包没有共用一个可恢复的 fence identity 和线性化点。 | **生产端：**两生产根 source owner/lifecycle/log guard；session new/send/delete/control、global state、task/scheduler、deferred intent、confirmation/interaction、final/delivery/outbox、resource lease 等全部 writer/trigger。**组合：**fresh/exact replay，active/queued/pending/final/outbox，drain 超时、abort、响应丢失和连续重启。**消费者：**AuthorityCatalog、target recovery 与迁后 owner。**异常终态：**漏迁、重复或旧 source 残留 producer。**直接证据：**真实 log/owner/assembly 竞争与恢复。**受影响审查项：**IR34-08、IR34-09、IR34-11、IR34-24。 | 在两生产根复用 assembly lifecycle、owner 投影和 log guard 建唯一窄 `PlannedSourceFence`：所有入口在任何副作用前以稳定 `{kind,id,requestId}` 登记 accepted token；同一 gate 先拒 fresh，再冻结 token exact-set，随后安装仅允许本 transfer 与这些 token 有限收束的 guard并耐久写 `anchor-fenced`/closure digest。用现有 owner projections 把每个 token推进为源端终态或 canonical pending obligation；closure cursor 与 log head 全等后才冻结 source prefix，超时/不可判定即不得 freeze。启动从 durable fence 恢复同一 guard；仅 durable pre-commit abort 可恢复 fresh admission。**完成：**fence 后 fresh 写零追加，accepted work 恰一终态或恰一 pending 落点，abort/响应丢失/连续重启不丢义务，target 开放前 source producer/loop 全停。 | 已验证 |
| U34-02 | **P0/大。**target imported 前未拉取 retained artifacts；source envelopes 被逐包改写进 live log并丢失原 envelope/LSN identity；issuer 激活、trust/install、私有 committed 与 `onInstalled` 分步，terminal replay 会跳过失败效果。非空 retained authority 可正常提交失败，崩溃还会暴露半 authority 或造成 source 已交权、target 永不 ready。 | target 把 transfer progress、不可见 authority base、原子 publication 和服务开放混成跨多个事实源的副作用序列。 | **生产端：**strict receiver/importer、per-transfer staging/CAS、authority base reader/installer、key/trust/current-owner 与 service admission。**组合：**空/非空 retained exact-set、已有/共享 ref、部分/完整导入、两次 sync、publish/onInstalled 效果前后失败、terminal replay和连续重启。**消费者：**new current anchor、`readSnapshot/readTail/readStream/durableProjection` 等全部 authority consumers、第一方入口与 paired peers。**异常终态：**共享 CAS 误删、半 authority 可见、原身份丢失或全局停摆。**直接证据：**真实双端 log/store/private staging/启动恢复。**受影响审查项：**IR34-12、IR34-14、IR34-15、IR34-18、IR34-19、IR34-21、IR34-26、IR34-27。 | 每个 transfer 固定独立 root、journal 与 `FileArtifactStore`；imported 前按冻结 catalog 逐 ref 拉取并验 digest/size/exact-set，共享 CAS 命中仅记“已存在”，abort 只删私有 root。用 `AuthorityCommitLog.readTail` 的原始 envelope bytes/LSN/digest 构成不可见 immutable base segment，禁止逐 entry 写 live log；CAS 提升与 base 落位先完成但不公开。唯一 target publication 是同一 AuthorityCommitLog envelope：同时写 committed-base pointer、signed trust/current anchor/epochs 与 planned install；同一 log 的 snapshot/tail/stream/durable projection 只在该 pointer 可见后按“原 source base prefix → target install/tail”组合读取，checkpoint/cursor反绑 `{baseDigest,sourceHead,targetTail}`，target 旧本地记录不得混入新 current authority。私有 journal 仅作进度缓存，terminal 决定从 install envelope 重建。启动/terminal replay从 install 重驱 key activation、trust reconcile 与 service admission，全部成功后才回 committed。**完成：**中间态零公开可见、共享 ref 零误删、所有 consumer 对同一组合 base 全等，效果前后失败可重驱，原 envelope/LSN 全等且同一 commit 最终恰一 ready。 | 已验证 |
| U34-03 | **P1/大。**planned commit 后 target 只 reconcile 本机；旧 source 与其他设备仍按旧 bootstrap trust 运行，session/global/task/channel/confirmation 等第一方入口也未统一解析新 issuer/current owner。**价值裁决记录：**原 P0/大；旧 source committed log fence 已阻止普通权威写，未证成直接耐久破坏，故降为 P1/大；但迁后入口不可连续使用、peer 不消费新 trust，仍违反核心体验与唯一 current-anchor 合同。只有全部入口统一解析新 owner、peer 可验证并消费同一 signed record，或产品正式取消跨入口连续性时才重开。 | planned install 的 signed current-owner/trust 投影未成为 mesh reconciliation 与全部第一方 composition 的共同准入事实。 | **生产端：**target install、旧 source 退役、认证 peer reconnect、两生产根 first-party composition。**组合：**旧 source、在线/离线 peer、target 暂时离线、全部第一方入口、响应丢失、旧 issuer/epoch 与连续重连。**消费者：**CLI/server/session/global/task/channel/confirmation/notification、planned targets/status/prepare/continue/cancel 等管理入口与 mesh peer。**异常终态：**显示完成却仍命中旧 owner、接受后 append 失败或信任旧 issuer。**直接证据：**真实 signed record、peer reconnect 和 finite method exact-set。**受影响审查项：**IR34-22、IR34-23、IR34-25。 | 复用 signed `HomeTrustRecord`、现有 current-authority/current-conversation resolver、mesh `reconcileTrust` 和 canonical first-party surface：target publication、旧 source 与认证 peer 重连都验证并消费同一新 record；session/global/task/channel/confirmation/notification及 planned 管理 exact-set 在副作用前解析 current owner，target 本地执行，旧 source/peer 经现有 mesh 有限转发，target 离线稳定拒绝且绝不回退旧 owner。旧 source 退役 owner/signing/receiver 能力并永久保留 committed fence，不建设 continuous sync。**完成：**全部受支持入口只命中新 owner，同一 peer trust chain 收敛，旧 issuer/epoch 永久零副作用。 | 已验证 |
| U34-04 | **P1/中。**source prepared 后 target 效果前失败时 replay 直接返回；live abort 等待 target 后才恢复，startup 却吞失败直接恢复；target aborted/committed replay 不继续 cleanup/install，恢复也只尝试一次。一次断连或重启即可永久卡住迁居/取消并遗留 key/staging。 | 双端 durable phase decision 与远端投递、私有 cleanup、target install 后效果没有统一的可重驱 consumer。 | **生产端：**source/target prepare、fence、freeze、import、commit、abort、startup与live RPC。**组合：**每一 phase 效果前后失败、远端离线、响应丢失、同/异载荷、commit/abort 竞争、cleanup 暂态失败和连续重启。**消费者：**source admission/accepted owners、target receiver/key/staging/service与用户 continue/cancel。**异常终态：**永久非终态、错误复权、post-commit abort 或资源遗留。**直接证据：**真实双端逐切点 exact replay。**受影响审查项：**IR34-04、IR34-06、IR34-20、IR34-21、IR34-26、IR34-27。 | 让 live 与 startup 共用一个 planned phase driver；每步先读本端 durable decision，再按同 request/transfer 查询并幂等驱动对端。source `prepared/fenced/frozen/imported` 分别补齐 target prepared/frozen/imported；source committed 永久保留 fence并持续投递 commit；source durable abort 先在本地恢复 U34-01 同一 admission gate、accepted owner/recovery loop 与原 token replay，再保留 target abort/cleanup obligation。target committed replay继续 U34-02 post-install effects；target aborted 先稳定拒 commit，再重驱 key/private-root cleanup；异载荷稳定冲突。driver 由现有 lifecycle 周期唤醒，stop 只取消当前 I/O、不清耐久义务。**完成：**全部双端切点在响应丢失和连续重启后唯一收敛 commit 或 abort，commit 后零 abort、abort 后 source owner/loop 恰一恢复且零错误 fencing，终态零未处置效果。 | 已验证 |
| U34-05 | **P1/中。**target permit 包住 async network range，source range 无 planned capacity step，export 通过 `readSnapshot` 整体 materialize；assembly stop 没有 planned closing gate、取消或等待在途物理步骤。网络挂起可长期占 permit，大 authority/容量饱和可 OOM 或阻塞设备维护，stop 后 I/O 终态不明。 | planned transfer 的 source/export、network、target/staging 物理步骤未共用同一 governor 与可取消 stop 生命周期。 | **生产端：**source log/export/CAS range、target ready/apply/network/import/promote/fsync、两生产根 assembly start/stop。**组合：**零/大 authority、海量 retained ref、容量饱和、磁盘满、网络挂起、并发 stop/cancel 与重启。**消费者：**ArtifactStore、private staging、同设备其他 storage work。**异常终态：**permit 泄漏、O(total) 驻留、stop 后继续写或伪造完成。**直接证据：**真实 governor、固定 chunk、挂起网络与 stop。**受影响审查项：**IR34-13、IR34-29。 | 保持 strict wire/ref，复用 `AuthorityCommitLog.readTail`、同 source-head 的 `ArtifactLifecycleIndex` retention snapshot 与现有 governor，建立本功能窄 `ChunkSource/ChunkSink`：分页序列化原 envelope，catalog/ref 清单以固定 header page 流式落同一 ArtifactStore；网络请求先取得固定 range，permit 只覆盖本地 read/decode/write/fsync并在交付后释放，绝不跨网络或 authority/store/lifecycle 锁。owner/target 共用 assembly `AbortSignal`、closing promise 与 in-flight registry；stop 先拒新 ready/apply/range 与 source command，再取消并等待 step/permit/disposer，耐久 phase 留给启动重驱。**完成：**驻留仅随固定并发×chunk/header page 增长，网络等待零 permit，stop 栅栏后全部端口零新物理效果，失败关闭不伪造 phase。 | 已验证 |
| U34-06 | **P1/中。**source 不可逆 commit 前只重验 trust/期限/catalog/transition；target commit 也不读当前 readiness。即使补“两次瞬时读取”，target 仍可在 ready 响应后、source commit 前漂移，造成 source 永久交权给失去能力的 target。**价值裁决记录：**原把 commit 安全与 CLI 展示合并为 P1/中；两者根因独立，故本项曾收窄为 P1/小，U34-08 单列。**收敛修订记录：**生产竞态证明瞬时双读不足，必须增加现有 transfer journal 内的 late-ready reservation并反绑生命周期/重启，故评级仍为 P1、工作量由小修正为中；未恢复 CLI 体验或其他已否定主张。若相关 revisions 被证明 transfer 全程不可变，或已有等价 reservation，方可删除。 | durable ReadyProof 没有与 target 当前 snapshot、source 唯一提交点共用一个跨响应窗口仍有效的 transfer 私有 late-ready reservation。 | **生产端：**existing-transfer ready replay、target imported→commit 边界、source atomic commit、target defensive commit。**组合：**trust/config/protocol/asset/service revision、secret unlock/issuer key、proof expiry，在复验前后漂移、响应丢失、commit/abort 竞争和重启。**消费者：**source commit guard、target phase driver与service admission。**异常终态：**不可回滚地交权给未 ready target。**直接证据：**逐 revision 和复验响应窗口竞争。**受影响审查项：**IR34-16。 | 不扩公开协议：existing-transfer `ready` 在 target lifecycle 锁内重读完整 readiness、secret/key并与原 ReadyProof exact-match，同时在现有 transfer journal 耐久记录该 proof digest、expiry与current snapshot的 late-ready reservation；会改变相关 revision 的本地路径必须先等待，或在证明 source 未 commit 时耐久 abort reservation。source 原子 commit 前重调同 transfer ready并要求 proof/reservation exact-match；target commit只接受同 reservation。断连/重启先向 source 查询 durable commit/abort：pre-commit expiry可稳定 abort，source commit 已存在则永远 forward-replay，服务等当前能力恢复。**完成：**任一 pre-commit 漂移均在 source commit 零副作用前拒绝，复验响应窗口不能绕过；未漂移、响应丢失、expiry与连续重启全等，post-commit 不倒退。 | 已验证 |
| U34-07 | **P1/中。**现有 happy path/mock 没有真实触发 fresh writer、非空 pending/retained、shared staging、双端切点、post-install 失败、peer/第一方接管、governor/stop、readiness 竞争与两生产根漂移，已实际漏过 U34-01～U34-06。绿色结果不足以安全提交。 | 直接验收证据未穿过本单元核心权威、耐久、资源与生产装配边界。 | **生产端：**strict codec/ready、planned owner/target/phase driver/mesh assembly、S7 两根。**组合：**U34-01～U34-06 的真实非空义务/资产、响应丢失、连续恢复、旧 issuer、stop、late-ready 竞争和装配变异。**消费者：**提交门禁与后续维护者。**异常终态：**缺陷在绿色证据下提交并同根返工。**受影响审查项：**IR34-34。 | 仅扩展现有 planned-transfer/assembly/first-party/S7 测试：用真实双端 `AuthorityCommitLog`、`FileArtifactStore`、`ArtifactLifecycleIndex`、governor、private staging与两生产根跑有限小表；组件矩阵直接复用。生产小表至少覆盖 source fresh+accepted、non-empty retained+atomic install、双端 commit/abort loss+restart、old source/peer/first-party、capacity/network/stop、late-ready drift；S7 对两根 owner/target/driver/lifecycle exact-set 做删除、替换、重复和绕过变异。**完成：**U34-01～U34-06 各根因至少一条真实正反例，production builder 与 gate 共同拒绝漂移，不新建 runner 或配置×故障笛卡尔积。 | 已验证 |
| U34-08 | **P2/中。**targets 只返回 trust 候选，CLI 显示 `displayName（deviceId）` 并要求 raw ID；用户只能在 prepare 后得到泛化失败。**价值裁决记录：**原并入 U34-06/P1；它不影响 authority 正确性或耐久终态，故拆为 P2/中，但仍违反 Unit 34 锁定的设备选择体验。仅当产品正式改为运维 raw-ID 接口或已有等价唯一选择面时重开。 | 用户目标投影把内部 target identity、无副作用 readiness summary 和设备名选择混在传输命令层。 | **生产端：**target readiness summary、server targets DTO、TTY/非TTY CLI list/migrate selector。**组合：**ready/缺口、target 离线、唯一名称、重名、序号、状态刷新和 prepare 拒绝。**消费者：**迁居用户。**异常终态：**暴露内部 ID、误选或多一次可避免往返，无耐久破坏。**直接证据：**DTO exact keys与CLI交互。**受影响审查项：**IR34-31。 | 在现有 target service 增加只读、无 issuer-key/staging 副作用的有限 readiness summary，复用 U34-06 snapshot predicate；`targets` 只返回 opaque internal ID、displayName、ready 与有限缺口 code。TTY仅渲染设备名/状态/可行动提示并用交互序号选择；非TTY只接受唯一 displayName，重名稳定拒绝且不泄露 raw ID；prepare仍使用内部 ID与严格 proof。**完成：**受支持旅程不展示或要求 raw ID，缺口在 prepare 前可行动，列表查询零 transfer 副作用且内部关联严格。 | 已验证 |

### U34-01～U34-08 固定事实矩阵

> 下列矩阵是八项问题的直接实施与验收边界；执行者不得用 happy path、返回值或 mock 自述代替对应耐久事实。每格均固定 identity、事实源/线性化点、零副作用边界、终态与直接证据。

| 编号 | 直接变体 | 稳定 identity 与唯一耐久事实 | 线性化点、零副作用边界与消费终态 | 直接验收 |
| ---- | -------- | ---------------------------- | ---------------------------------- | -------- |
| F34-01 | 两生产根的 session/global/task/scheduler/intent/confirmation/interaction/final/delivery/outbox/resource writer；fresh、exact replay、fence 前后竞争 | `{transferId,kind,id,requestId}` accepted token；source AuthorityCommitLog 中 `anchor-fenced` 与 closure digest | admission gate 先拒 fresh，durable fence 是迁居线性化点；fence 后非 transfer/非 accepted 收束零 append；abort仅由 durable pre-commit decision复权 | 每类入口至少一正一反；删除或绕过 gate 必失败 |
| F34-02 | active/queued/pending/final/outbox，drain 超时、响应丢失、连续重启 | 同 accepted token；owner projections、terminal record或 AuthorityCatalog `pendingObligations` | closure cursor 必须与冻结 log head 全等；不可判定不得 freeze；target按原 identity恰一消费，source loop在 target ready 前停止 | 非空义务小表证明 terminal/pending exact-set 无漏无重 |
| F34-03 | 空/非空 retained、共享 ref、部分 import、两次 sync、abort/cleanup | `{transferId,catalogDigest,ref}`；per-transfer journal/private store与同 source-head lifecycle-index snapshot | imported 仅在 export/catalog/ref 全验后成立；共享 CAS 提升前不可见，abort只删 private root；terminal为全量 imported或aborted-clean | 真实 FileArtifactStore 注入缺 ref、共享 ref、部分 I/O 与重启 |
| F34-04 | base publish、key/trust/current/epochs、`onInstalled` 效果前后失败和 terminal replay | `{transferId,sourceHead,baseDigest,commitDigest,targetTail}`；immutable base与target AuthorityCommitLog install envelope | install envelope是唯一 target publication；此前所有 base/refs零 authority 可见；所有 read/projection 统一按 source base→install/tail 组合，其后只 forward-replay post-install，ready后才应答 | 真实双 log 验原 envelope/LSN、composite cursor、单 envelope publication与启动重驱 |
| F34-05 | 旧 source、在线/离线 peer、target 离线；session/global/task/channel/confirmation/notification/管理入口 | signed `HomeTrustRecord` 的 `{homeId,trustEpoch,anchorEpoch,issuer}` | source commit产生新 owner，认证 reconcile/first-party resolver消费；旧 owner和旧 issuer永久零副作用，离线只稳定拒绝不回退 | 全部 method exact-set、peer reconnect、旧 epoch/issuer 反例 |
| F34-06 | prepare/fence/freeze/import/commit/abort 每步效果前后失败、远端离线、同/异载荷、连续重启 | `{requestId,transferId,phase,payloadDigest}` 与双方 durable journals/install | 本端 decision 先于远端效果；driver exact replay未完成效果；source commit后只 forward，source abort后立即复权并保留远端清理义务 | 每个切点双端断连/丢响应/重启，最终唯一 commit或abort |
| F34-07 | 大 authority/海量 ref、容量/磁盘、网络挂起、并发 stop/cancel | `{transferId,part,offset,length,digest}`；governor work identity、private progress和assembly closing promise | 网络等待零 permit；本地固定块效果持 permit；stop栅栏后零新 I/O，取消只留可重驱耐久 phase | 真实 governor 拒绝/取消/成功、挂起网络、固定驻留与 stop |
| F34-08 | trust/config/protocol/asset/service/secret/key/expiry 在复验前后漂移；commit/abort/断连/重启 | 原 ReadyProof digest与target journal `{snapshot,expiry}` late-ready reservation | target lifecycle 锁内 revalidate+reserve；source commit只接受同 reservation；expiry/重启先查 source decision，pre-commit drift零 source commit，post-commit永不abort | 每维漂移、“ready响应后、source append前”竞争及 expiry 连续恢复均闭合 |
| F34-09 | anchor+executor、executor-only；owner/target/driver/lifecycle 与真实 log/store/index | 两生产 profile exact-set和现有 S7 descriptor/golden | production builder决定唯一装配；组件矩阵复用，双根小表只验证交界；删除/替换/重复/绕过稳定失败 | U34-07有限 production table与S7 mutation table |
| F34-10 | ready/缺口/离线、唯一名/重名/序号、刷新与 prepare | opaque targetId、displayName、side-effect-free readiness code | list零 key/staging/transfer副作用；CLI映射后才把内部 ID 交 strict prepare；重名不猜测 | DTO exact keys、raw-ID 隔离、重名重选和 stale prepare拒绝 |

### 根因交界与反证账

| 编号 | 交界 / 反证 | 耐久处置与关闭条件 |
| ---- | ----------- | ------------------ |
| C34-C01 | U34-01↔U34-02：仅冻结 log prefix 不能证明 active/pending obligation 已进入 target。 | F34-01/02 固定 accepted token 与 terminal/pending exact-set；U34-02 只能消费该 catalog。 |
| C34-C02 | U34-02↔U34-04：target install envelope 已写不代表 key/reconcile/service 效果完成。 | install 是唯一决定；phase driver持续重驱 post-install，ready 后才返回 terminal。 |
| C34-C03 | U34-03↔U34-04：一次 `reconcileTrust` 或单次 peer 通知不能保证离线 peer/旧 source 收敛。 | signed record 耐久化并在认证 reconnect 与 first-party resolver 重放，不建设 continuous sync。 |
| C34-C04 | U34-05↔U34-06：瞬时 readiness 双读仍有远端响应到 source commit 的竞态。 | F34-08 增加 transfer 私有 late-ready reservation；相关本地变更与它互斥或 pre-commit abort。 |
| C34-C05 | U34-01～U34-06↔U34-07：组件绿、mock atomic 或八配置 exact-set不能证明真实生产故障终态。 | F34-09 只补两生产根交界小表与有限 S7 变异，故障矩阵留在真实 owner/target。 |
| C34-C06 | U34-06↔U34-08：安全 proof 与用户列表 readiness 同谓词但不能共用有副作用的 `ready()`。 | 列表复用纯 snapshot predicate；proof/key/reservation只在 strict prepare/commit 链产生。 |
| C34-C07 | 八项↔第35～38单元：post-commit forward recovery 不等于 source-less/disaster recovery、恢复应用、全局同步或通用生命周期。 | 仅重驱本 planned transfer 的 durable phase、trust/current-owner与私有资源；后继能力不进入方案或验收。 |
| C34-C08 | U34-02：仅写 committed-base pointer 而未改变 log consumer，会形成“指针存在但 authority 仍缺失”的第二表象。 | U34-02/F34-04 固定同一 log 的全部 read/projection 以 pointer 激活 composite origin，cursor 同时反绑 base 与 tail。 |
| C34-C09 | U34-01↔U34-04：durable abort 后只翻 admission flag 会遗失被 fence 暂停的 owner/loop 与 accepted replay。 | phase driver 从同一 accepted token/owner projection 恢复 admission、owner/recovery loop，再异步完成 target cleanup。 |
| C34-C10 | U34-08：CLI 曾生成 `duty-UUID`，会被 strict transfer identity 在发起前拒绝。 | 改为严格 `xfer-ULID`，并由 selector/DTO 直接测试与 S7 拒绝旧形态；修复后复核通过。 |
| C34-C11 | U34-05↔U34-08：本地 targets 查询与 target summary 曾绕过 planned lifecycle，stop 后仍可进入端口。 | 两入口统一进入 runtime gate；stop 场景与 S7 lifecycle 规则修复后复核通过。 |
| C34-C12 | U34-03：旧 source server 缺少 current-anchor first-party/planned 管理转发，迁后入口会停在旧端。 | 增加有限 `CurrentAnchorFirstPartyRpcRouter`，只覆盖 canonical session/confirmation/planned method exact-set，并以 active anchor/executor 认证；直接测试与 S7 修复后复核通过。 |
| C34-C13 | U34-03↔U34-04：source durable commit 后、target 响应前，同进程 current-owner resolver 仍返回旧 source。 | owner 暴露 `onSourceCommitted(targetDeviceId)`，fresh/replay/startup 均更新 assembly durable projection；响应丢失/重启场景修复后复核通过。 |
| C34-C14 | U34-06：target 重启只持有 journal reservation，未在公开准入前恢复本地 readiness revision gate。 | target `recoverBeforeAdmission` 扫描非终态 journal 并 rehydrate 同一 reservation；late-ready 重启直接测试修复后复核通过。 |
| C34-C15 | U34-04↔U34-05：startup/reconnect phase recovery 未纳入 planned closing promise，stop 可能与恢复 I/O 交错。 | startup 与 reconnect recovery 均通过 planned runtime `run` 登记并由 closing promise 等待；S7 删除/绕过变异和 workspace build 修复后复核通过。 |

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
| V34-01 | U34-01/02/04/05/06：planned source/target、真实 retained/private/atomic、双端 phase、governor/stop 与 late-ready 直接矩阵 | `pnpm --filter @zhixing/cli exec vitest run src/serve/planned-anchor-transfer.test.ts`；失效闭包只补 `-t "holds the target readiness revision across the source commit window"` | planned owner/target、core log/store/index、两端 staging、governor 与直接测试 | 修复直接验证；完整矩阵 14/14，后续失效单例 1/1，4.31s（命令总 12.63s） | 通过；未受后续改动的用例复用，reservation/restart 变化项已在当前输入补证 | 当前冻结指纹 | 有效 |
| V34-02 | U34-03：旧 source first-party/current-owner 接管 | `pnpm --filter @zhixing/cli exec vitest run src/serve/__tests__/first-party-conversation-mesh.test.ts` | finite first-party router、认证 peer、session/confirmation/planned exact-set | 修复直接验证 | 3/3 通过 | 当前冻结指纹 | 有效 |
| V34-03 | U34-08 与 server consumer：设备名 selector、DTO exact keys、raw ID 隔离 | CLI selector/DTO 定向集；server 定向集 | duty migration command/facade、server context/RPC consumer | 修复直接验证 | selector/DTO 8/8；server 32/32 通过 | 当前冻结指纹 | 有效 |
| V34-04 | U34-03/04：source committed 响应丢失与启动恢复只解析新 current owner | planned-transfer response-loss 定向单例 | owner durable commit projection、assembly resolver、phase driver | 修复直接验证 | 1/1 通过 | 当前冻结指纹 | 有效 |
| V34-05 | U34-07：两根 owner/target/driver/lifecycle/current-owner exact-set 与 registry golden | `pnpm s7:lint` | `scripts/s7-entry-coverage.mjs`、变异测试、canonical registry golden | 派生资产/合同预检；50.9s | 18/18 与 registry golden 通过 | 当前冻结指纹 | 有效 |
| V34-06 | 受影响 CLI 类型闭包无新增类型错误 | `pnpm --filter @zhixing/cli exec tsc --noEmit` | Unit34 CLI/core/server 消费闭包及仓库既有 CLI 源码 | 修复诊断 | 仅余 8 个与 Unit34 无关、修复前已存在的 `ZhixingCredentials` 错误；首次发现的 `Dirent` 新错误已修复 | 当前冻结指纹 | 诊断 |
| V34-07 | 当前源码与跨包导出可构建 | `pnpm build` | 当前全部源码、包导出与构建配置 | 常驻必要构建；197.9s | 通过，exit 0 | 当前冻结指纹 | 有效 |
| V34-08 | F34-01～F34-10、C34-C01～C34-C15 在同一输入上完成专项事实链与四路冷启动对抗 | 冻结指纹复算 + 四个相互隔离的只读角色复核 | 28 个非工作台路径及正式矩阵/反证账 | 修复专项收口 | 四路均无新增反证；指纹 `6e7b3fadd1358c6b3af463814682f79c111d30fb1c01415f0da968f5cbd1f6d3` | 当前冻结指纹 | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-34.gen-1 -->
