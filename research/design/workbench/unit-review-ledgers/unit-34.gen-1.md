# 单元登记:第 34 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:34
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-09
- **登记来源**:用户要求将第 34 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U34-03、U34-04、U34-09 已在同一专项冻结指纹完成实现、最小必要验证、逐格事实链复核、四路冷启动对抗和反证差异审计，三项状态均为“已验证”；U34-01～U34-02、U34-05～U34-08 与 EX34-01 的既有结论继续保留。本次专项到此停止，不进入本单元两轮冻结终审、独立功能审查或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅用于 U34-03/U34-04/U34-09 本次专项收口；尚未进入全单元两轮冻结终审）
- **交付物文件集**:当前 `HEAD a24df557…` 上第 34 单元 U34-03/U34-04/U34-09 专项交付共 17 个非工作台生产、测试与 S7 路径；工作台文件不参与功能指纹
- **当前交付物指纹**:`183ec30ed6238f9e9919cbd166cbec1fd8638f1908219753013987d230fb92b4`
- **架构来源**:`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`，以及已定稿开发清单 D34-01～D34-08

## 固定边界

- **功能范围**:仅支持用户从 current anchor 主动迁往另一台已配对、active、启用 anchor 角色且 ReadyProof 就绪的设备；交付 strict planned transfer、transfer-bound issuer key、source 准入关闭与 accepted-work 收束、独立 export/AuthorityCatalog/SourceFreezeProof、target 私有导入、唯一 AnchorTransferCommit、双端恢复与 forward-only、第一方接管、CLI/server 迁居旅程及两生产根 exact-set/必要证据
- **架构不变量**:current anchor 的唯一 `AuthorityCommitLog` / `ArtifactStore` / storage governor、S2 trust/mesh/SecretStore 与 current-authority resolver 是权威事实源；source commit 是唯一全局线性化点，commit 前可安全 abort，commit 后永久 forward-only；target 中间态不可服务，旧 issuer/epoch 永久拒绝；秘密、环境事实、workspace 原始路径和设备缓存不迁移
- **验收条件**:U34-01～U34-09 均达到“已验证”；P0/P1 清零；同一冻结指纹完成两轮冻结终审、独立功能审查与单元提交验证；planned 迁居在双生产根、真实非空义务/资产、故障恢复、资源/stop、第一方接管和产品旅程上取得成比例证据
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
| U34-03 | **P1/中；来源 P34-15。**既有 canonical server RPC exact-set与双根ownership composite仍有效，但所有anchor-role设备仍无条件 `setupChannels()`并连接adapter；`InboundRouter.handleMessage()`在副作用前不读取current-authority或planned readiness。非current target/第三anchor可接收同一渠道身份的消息并写自己的非current authority。证据：`packages/cli/src/serve/access-surfaces.ts:853-919`、`packages/cli/src/serve/channels.ts:140-148,234-242`、`packages/server/src/channels/inbound-router.ts:187-216`；权威合同：`specification.md:2282,2391`。**同根再次重开记录：**旧 U34-03 已闭合canonical RPC路由；channel-inbound不经过该registry，触发“全部第一方入口在副作用前统一解析new owner”的重开条件，故不恢复已否定的通用RPC代理，也不新增问题行。**本轮价值裁决记录：**原独立结论P34-15为P1/中并提出current anchor持有channel连接/准入；反向复核排除仅在`handleMessage`丢弃，因为provider可能已确认而静默丢消息，也排除通用跨机channel relay。新决定仍为P1/中，复用现有registry connect/disconnect和planned lifecycle切换物理接收owner；用户体验达标：无静默丢失/双回复；架构达标：signed current owner仍是唯一选择事实。修复后若non-current或post-install未完成设备仍可连接、确认或写channel input，或abort/commit造成零个/多个channel owner并存，则同根重开。**最终结论：改写并保留。** | current-owner entry exact-set只覆盖canonical RPC，没有覆盖权威矩阵中的channel-inbound物理接收owner；连接时机、router最终守卫与planned owner切换未共用同一current-owner事实。 | **生产端：**channel surface/setup、ChannelRegistry connect/disconnect、adapter authenticated callback、InboundRouter及planned lifecycle。**组合：**current source/new target/第三anchor，启动、迁前stop、pre-commit abort、commit/post-install、断连重投、响应丢失、target离线与连续重启。**消费者：**渠道用户、conversation owner、confirmation/challenge、channel delivery关联。**异常终态：**消息写入错误authority后被base install覆盖，或多设备重复准入/回复；router层晚丢弃还可能吞掉provider已确认事件。**直接证据：**三设备真实channel连接/入站、迁前后owner切换与S7 ownership exact-set。**受影响审查项：**IR34-23、IR34-33、IR34-34。 | 复用现有channel registry/inbound admission与current-authority resolver：把channel配置与连接分离；启动仅current anchor连接，non-current保持配置但断开。source `stopAccepting`先关闭inbound admission并等待已接纳消息，再disconnect；pre-commit durable abort重连同一registry；target仅在U34-04 post-install consumer completion后连接，commit后旧source永久不重连。`handleMessage`保留current owner/readiness的副作用前最终守卫以覆盖连接切换竞态。补current/target/第三anchor、迁前/迁后、abort/commit、断连重投/响应丢失测试；将channel owner纳入现有ownership descriptor/S7 exact-set。**完成：**任一时刻恰一current设备可物理接收并写channel input，切换窗口零错误确认/双写，abort恢复原owner、commit永久交接且不建通用relay。 | 已验证 |
| U34-04 | **P0/大；来源 P34-14。**既有角色无关 pre-bootstrap completion与三组 consumer descriptor仍有效，但 live target的 `ConversationProtocolRuntime` 已有 `#recoveryDiscovered=true`；安装新 authority base后 post-install再次调用 `recoverReadinessProjections()`直接 no-op，却仍可清 private progress并开放。source closure仅 `deliveryStack.flush()`，没有禁止 `AuthorityDeliveryPipeline` timer的下一轮外部 send，commit后旧 source可先外发、再因 append guard拒绝 outcome。证据：`packages/cli/src/serve/conversation-protocol-runtime.ts:620-628,3049-3086`、`packages/cli/src/serve/command.ts:940-989`、`packages/core/src/delivery/authority-pipeline.ts:117-150`。**同根再次重开记录：**旧 U34-04 已闭合 install→key/private→descriptor调用顺序；当前事实触发“固定 consumer必须在公开准入前真实重建且旧 owner零外部副作用”的关闭条件。**本轮价值裁决记录：**原独立结论 P34-14 为 P0/大并笼统要求清全部cache、重建delivery；反向复核确认 conversation漏恢复和source外发真实可达，但target delivery现有authority-driven flush可复用，无需重建整栈。新决定仍为P0/大，收窄为conversation authority-generation重置、source delivery可逆quiesce与obligation read-back；用户体验达标：接管前不开放、接管后不漏不重；架构达标：catalog/log仍为唯一事实，不建通用lifecycle。修复后若旧source在closure后仍能产生consumer外部副作用，或target能在catalog obligation未由new owner重建时开放，则同根重开。**最终结论：改写并保留。** | authority install只重放phase/callback形态，没有形成runtime consumer从source静止到target按新authority重建的所有权切点。one-shot conversation discovery与持续运行的delivery timer分别留下目标漏恢复和源端残留owner。 | **生产端：**source planned lifecycle、delivery pipeline timer/active flush、target authority install/post-install completion、conversation recovery loop/cache、service readiness gate。**组合：**非空六类pending，install前后、conversation已discover、delivery flush前/中/后、source commit/abort、live/startup、响应丢失与连续重启。**消费者：**scheduler/intent/assignment、conversation/interaction/confirmation/final、delivery及AuthorityCatalog pending owners。**异常终态：**迁入确认/终态在当前进程停滞，或旧source与new target对同一delivery发生外部重复发送；用户重启也不能撤销已发生副作用。**直接证据：**真实live install六类pending、source timer→commit→target接管、效果前后失败/丢响应/重启。**受影响审查项：**IR34-19、IR34-21、IR34-22、IR34-24、IR34-33、IR34-34。 | 不要求用户迁后重启，不建通用lifecycle。conversation增加planned-install专用 `recoverInstalledAuthority()`：停loop、等待在途claim，清理只依赖旧authority generation的discovery/journal/projection cache，重置generation后从新snapshot恢复并重启。delivery pipeline复用现有timer/activeFlush增加窄 `quiesceForAuthorityTransfer`/`resumeAfterAuthorityTransfer`：source closure先原子禁止新flush再等待active flush；durable abort恢复，commit永久停止；target post-install继续复用现有authority-driven `recoverInstalledAuthority()` flush。三组callback必须消费传入catalog obligations并在开放前read-back证明每项已有current owner或已终态；失败保留private progress/readiness gate。补真实live install六类pending、source外发切点、效果前后失败/丢响应/重启测试；S7只反绑quiesce→install→recover/read-back→open。**完成：**旧source零后台/外部consumer副作用，target全部obligation恰一归属并在当前进程可重驱后才开放，abort/commit/连续重启唯一收敛。 | 已验证 |
| U34-05 | **P1/中。**target permit 包住 async network range，source range 无 planned capacity step，export 通过 `readSnapshot` 整体 materialize；assembly stop 没有 planned closing gate、取消或等待在途物理步骤。网络挂起可长期占 permit，大 authority/容量饱和可 OOM 或阻塞设备维护，stop 后 I/O 终态不明。 | planned transfer 的 source/export、network、target/staging 物理步骤未共用同一 governor 与可取消 stop 生命周期。 | **生产端：**source log/export/CAS range、target ready/apply/network/import/promote/fsync、两生产根 assembly start/stop。**组合：**零/大 authority、海量 retained ref、容量饱和、磁盘满、网络挂起、并发 stop/cancel 与重启。**消费者：**ArtifactStore、private staging、同设备其他 storage work。**异常终态：**permit 泄漏、O(total) 驻留、stop 后继续写或伪造完成。**直接证据：**真实 governor、固定 chunk、挂起网络与 stop。**受影响审查项：**IR34-13、IR34-29。 | 保持 strict wire/ref，复用 `AuthorityCommitLog.readTail`、同 source-head 的 `ArtifactLifecycleIndex` retention snapshot 与现有 governor，建立本功能窄 `ChunkSource/ChunkSink`：分页序列化原 envelope，catalog/ref 清单以固定 header page 流式落同一 ArtifactStore；网络请求先取得固定 range，permit 只覆盖本地 read/decode/write/fsync并在交付后释放，绝不跨网络或 authority/store/lifecycle 锁。owner/target 共用 assembly `AbortSignal`、closing promise 与 in-flight registry；stop 先拒新 ready/apply/range 与 source command，再取消并等待 step/permit/disposer，耐久 phase 留给启动重驱。**完成：**驻留仅随固定并发×chunk/header page 增长，网络等待零 permit，stop 栅栏后全部端口零新物理效果，失败关闭不伪造 phase。 | 已验证 |
| U34-06 | **P1/中。**source 不可逆 commit 前只重验 trust/期限/catalog/transition；target commit 也不读当前 readiness。即使补“两次瞬时读取”，target 仍可在 ready 响应后、source commit 前漂移，造成 source 永久交权给失去能力的 target。**价值裁决记录：**原把 commit 安全与 CLI 展示合并为 P1/中；两者根因独立，故本项曾收窄为 P1/小，U34-08 单列。**收敛修订记录：**生产竞态证明瞬时双读不足，必须增加现有 transfer journal 内的 late-ready reservation并反绑生命周期/重启，故评级仍为 P1、工作量由小修正为中；未恢复 CLI 体验或其他已否定主张。若相关 revisions 被证明 transfer 全程不可变，或已有等价 reservation，方可删除。 | durable ReadyProof 没有与 target 当前 snapshot、source 唯一提交点共用一个跨响应窗口仍有效的 transfer 私有 late-ready reservation。 | **生产端：**existing-transfer ready replay、target imported→commit 边界、source atomic commit、target defensive commit。**组合：**trust/config/protocol/asset/service revision、secret unlock/issuer key、proof expiry，在复验前后漂移、响应丢失、commit/abort 竞争和重启。**消费者：**source commit guard、target phase driver与service admission。**异常终态：**不可回滚地交权给未 ready target。**直接证据：**逐 revision 和复验响应窗口竞争。**受影响审查项：**IR34-16。 | 不扩公开协议：existing-transfer `ready` 在 target lifecycle 锁内重读完整 readiness、secret/key并与原 ReadyProof exact-match，同时在现有 transfer journal 耐久记录该 proof digest、expiry与current snapshot的 late-ready reservation；会改变相关 revision 的本地路径必须先等待，或在证明 source 未 commit 时耐久 abort reservation。source 原子 commit 前重调同 transfer ready并要求 proof/reservation exact-match；target commit只接受同 reservation。断连/重启先向 source 查询 durable commit/abort：pre-commit expiry可稳定 abort，source commit 已存在则永远 forward-replay，服务等当前能力恢复。**完成：**任一 pre-commit 漂移均在 source commit 零副作用前拒绝，复验响应窗口不能绕过；未漂移、响应丢失、expiry与连续重启全等，post-commit 不倒退。 | 已验证 |
| U34-07 | **P1/中。**现有 happy path/mock 没有真实触发 fresh writer、非空 pending/retained、shared staging、双端切点、post-install 失败、peer/第一方接管、governor/stop、readiness 竞争与两生产根漂移，已实际漏过 U34-01～U34-06。绿色结果不足以安全提交。 | 直接验收证据未穿过本单元核心权威、耐久、资源与生产装配边界。 | **生产端：**strict codec/ready、planned owner/target/phase driver/mesh assembly、S7 两根。**组合：**U34-01～U34-06 的真实非空义务/资产、响应丢失、连续恢复、旧 issuer、stop、late-ready 竞争和装配变异。**消费者：**提交门禁与后续维护者。**异常终态：**缺陷在绿色证据下提交并同根返工。**受影响审查项：**IR34-34。 | 仅扩展现有 planned-transfer/assembly/first-party/S7 测试：用真实双端 `AuthorityCommitLog`、`FileArtifactStore`、`ArtifactLifecycleIndex`、governor、private staging与两生产根跑有限小表；组件矩阵直接复用。生产小表至少覆盖 source fresh+accepted、non-empty retained+atomic install、双端 commit/abort loss+restart、old source/peer/first-party、capacity/network/stop、late-ready drift；S7 对两根 owner/target/driver/lifecycle exact-set 做删除、替换、重复和绕过变异。**完成：**U34-01～U34-06 各根因至少一条真实正反例，production builder 与 gate 共同拒绝漂移，不新建 runner 或配置×故障笛卡尔积。 | 已验证 |
| U34-08 | **P2/中。**targets 只返回 trust 候选，CLI 显示 `displayName（deviceId）` 并要求 raw ID；用户只能在 prepare 后得到泛化失败。**价值裁决记录：**原并入 U34-06/P1；它不影响 authority 正确性或耐久终态，故拆为 P2/中，但仍违反 Unit 34 锁定的设备选择体验。仅当产品正式改为运维 raw-ID 接口或已有等价唯一选择面时重开。 | 用户目标投影把内部 target identity、无副作用 readiness summary 和设备名选择混在传输命令层。 | **生产端：**target readiness summary、server targets DTO、TTY/非TTY CLI list/migrate selector。**组合：**ready/缺口、target 离线、唯一名称、重名、序号、状态刷新和 prepare 拒绝。**消费者：**迁居用户。**异常终态：**暴露内部 ID、误选或多一次可避免往返，无耐久破坏。**直接证据：**DTO exact keys与CLI交互。**受影响审查项：**IR34-31。 | 在现有 target service 增加只读、无 issuer-key/staging 副作用的有限 readiness summary，复用 U34-06 snapshot predicate；`targets` 只返回 opaque internal ID、displayName、ready 与有限缺口 code。TTY仅渲染设备名/状态/可行动提示并用交互序号选择；非TTY只接受唯一 displayName，重名稳定拒绝且不泄露 raw ID；prepare仍使用内部 ID与严格 proof。**完成：**受支持旅程不展示或要求 raw ID，缺口在 prepare 前可行动，列表查询零 transfer 副作用且内部关联严格。 | 已验证 |
| U34-09 | **P1/中；来源 P34-13。**跨 transfer durable claim 修复仍有效，但 source `#prepareCandidate()` 在 remote ready 后以普通 transfer append写首次 prepared，没有在同一 `AuthorityCommitLog` transaction重读 candidate terminal；并发 cancel可先写 released、prepare后写 prepared。target `releaseCandidate()` 仅在内存 `#contexts` 命中时检查 phase，重启后不读稳定路径的 per-transfer journal即可删除 prepared 的 issuer key/staging/journal。证据：`packages/cli/src/serve/planned-anchor-transfer.ts:791-828,1447-1495`。**同根再次重开记录：**旧 U34-09 已闭合跨 transfer claim-before-effect；新生产事实触发其“全部终态与副作用共用跨重启耐久判定”的关闭条件，故不新增问题行。**本轮价值裁决记录：**原独立结论 P34-13 为 P1/中并要求 S7识别跨事务；反向复核排除保持现状与“取消尽力而为”，但收窄 S7只反绑唯一 journal方法和禁止直接 cleanup，事务语义由真实竞争测试证明。新决定为 P1/中、保留；用户体验达标：同 request/transfer可安全重试且不假成功；架构达标：仍只用现有双端 journal。修复后若任一路径可在 transfer state 已存在时写 released，或未读磁盘 phase即删 key/journal/staging，则同根重开。**最终结论：改写并保留。** | candidate terminal、首次 prepared 与物理清理没有共享唯一耐久判定。source 的 released/prepared 可形成矛盾投影；target 重启后的迟到签名 release 可删除唯一重驱材料。 | **生产端：**source owner/journal 的 ready→prepared 与 claim-only cancel；target claim/per-transfer journal、`releaseCandidate`、issuer key/private staging cleanup。**组合：**同/异 transfer、ready前后 cancel双序、same-payload exact/异载荷冲突、target prepared后重启、迟到 release、abort/commit、响应丢失和连续恢复。**消费者：**source phase driver、target key/private owner、terminal cleanup与 U34-04 installation。**异常终态：**released与prepared并存，或 prepared材料被删后迁居永久阻塞/丢失。**直接证据：**同一真实 source log的 cancel↔ready/prepared双序、target重启迟到release及S7绕过变异。**受影响审查项：**IR34-04、IR34-06、IR34-26、IR34-27、IR34-33、IR34-34。 | 复用现有 journals。source journal增加一个事务方法，在同一锁内按 exact replay→candidate非终态→零 transfer state→append prepared排序；claim-only cancel的事务仅在零 transfer state时写 released，否则稳定要求 signed transfer abort。target `releaseCandidate()` 从稳定路径打开 per-transfer journal，只有零 transfer state才写 released并清 key/staging/journal；prepared及以后稳定拒绝，abort/commit仍先耐久再终结claim。补 cancel↔ready/prepared双序、target重启迟到release、同/异载荷和连续恢复测试；S7仅要求两端调用窄方法并禁止绕过磁盘判定直接清理。**完成：**terminal与首次 prepared恰一排序，任何拒绝零物理副作用，重启/丢响应后唯一材料可 exact replay，不新增通用锁或第二事实源。 | 已验证 |

### U34-03、U34-04、U34-09 专项修复实施记录

| 阶段 | 正式状态与当前证据 |
| ---- | ------------------ |
| U34-09 durable candidate 单飞 | **已验证。**source/target durable claim、claim-before-effect、签名 `candidate-release`、terminal/recovery 已落地；真实 source log 与 target-wide claim journal 并发、claim-only 丢响应取消及既有 planned 直接闭包在当前输入合计 16/16 通过；S7 已反绑双端 claim 顺序、release 与 target-wide journal。F34-11/F34-12 与 C34-C16/C17/C22/C24/C25/C27 在冻结指纹上复核通过。 |
| U34-04 pre-bootstrap/post-install completion | **已验证。**同一 installation helper 已由 live commit 与 role composition 前 bootstrap 共用，exact key/private journal 先补齐；三组 consumer、六种 pending、公开 gate 与 cleanup 顺序已落地。install 后 active-key 故障重启、六类非空 closure、missed issuer 与分组直接证据 4/4 通过。F34-13/F34-14 与 C34-C18/C19/C22/C23/C26 在冻结指纹上复核通过。 |
| U34-03 current-owner relay exact-set | **已验证。**canonical registry-minus-`auth/health/server.shutdown` 单源驱动 mesh/client/target/router；anchor+executor 直接 current-anchor，executor-only ownership composite 保证 local `handled:false` 不串路，`session.resolve` 进入同一 local owner gate。两份直接测试 12/12 通过。F34-15/F34-16 与 C34-C20/C21/C23/C24 在冻结指纹上复核通过。 |

> **历史证据说明：**上表只记录 `52519474…d8a6d1b2` 指纹上已完成的上一轮专项实现。最新独立审查已分别以新的同根生产事实重开 U34-03、U34-04、U34-09；现行事实、方案、评级与状态只以上方“问题列表”和“当前状态”为准，不得复用本表的“已验证”作为关闭依据。

### 最新同根专项实施进度

| 问题 | 当前实施事实与证据 | 状态 |
| ---- | ------------------ | ---- |
| U34-09 terminal/prepared 唯一排序 | source 首次 prepared 已改为 candidate+transfer 同一 `AuthorityCommitLog` projection transaction；claim-only release只接受零 transfer state。target candidate journal新增耐久 prepared decision，重启后 `releaseCandidate` 必打开稳定 per-transfer journal，prepared+拒绝且不清 key/staging。真实 cancel先赢、prepared先赢+target重启迟到release及既有prepare共3/3通过；S7拒绝事务与磁盘判定绕过。 | 已验证 |
| U34-04 runtime consumer ownership cut | source delivery 已以可逆 quiesce 拒绝新 flush 并等待 active；target install 后 conversation 以新 authority generation 重发现，三组 callback 返回并核对同组 obligation receipt，durable read-back 和 private cleanup 完成后才开放 surface。conversation/delivery/六类分组直接场景各1/1通过。 | 已验证 |
| U34-03 channel current-owner ownership | channel 配置注册与连接分离，signed current owner + planned readiness 决定唯一连接；source gate等待已接纳消息后断连，abort重连，target仅在 post-install completion 后连接。普通入站和challenge均在首个副作用前终检，相关直接场景4/4通过。 | 已验证 |

### U34-01～U34-08 固定事实矩阵

> F34-01～F34-10 保留八项既有直接边界；F34-11～F34-16 保留上一轮专项边界；F34-17～F34-22 固定最新同根重开的实施与验收边界。执行者不得用 happy path、返回值或 mock 自述代替对应耐久事实。

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
| F34-11 | 四个认证管理入口；source 同/异 transfer 并发、空投影、首次 prepare、claim-only取消、丢响应与重启 | source claim identity `{homeId,requestId,transferId,sourceDeviceId,targetDeviceId,trustEpoch,trustChainHead,anchorEpoch}`；同一 AuthorityCommitLog planned stream | `claimCandidate` transaction 是唯一 source 线性化点；claim 前零 remote/key/staging，异候选稳定 busy；claim/replay/cancel/terminal均由 phase driver消费 | 真实 source log 双并发恰一 claim；claim 后崩溃重启续到同 prepared，claim-only取消、异载荷/绕过失败 |
| F34-12 | target 空竞争、同/异 transfer ready/prepare、key/staging、candidate-release、abort/commit、连续恢复 | target-wide claim identity `{homeId,transferId,sourceDeviceId,targetDeviceId,trustEpoch,trustChainHead}`；稳定 staging-root claim journal + per-transfer phase journal | target-wide transaction先 claim；此前禁止 context/key/reservation/staging；private terminal或签名claim-only release先落盘再终结claim，cleanup可重驱 | 同一真实 target claim log并发、claim→key及key→prepared切点；败者零key/root，release/响应丢失 exact replay且无孤儿 |
| F34-13 | install 前后、key/private committed/onInstalled/cleanup 每一切点；角色 target→owner、source 离线、连续启动 | `transfer:anchor-current` installation `{transferId,targetId,commit,issuer,baseDigest}`；active key与private journal仅为消费进度 | 角色无关 pre-bootstrap completion 在 current-issuer key gate 前验 install并补 exact key/private committed；无 install 零副作用，歧义 fail-closed | 真实 target log/store/secret 从每个切点重启；缺/错 key、journal、target/commit稳定失败，合法最终 ready |
| F34-14 | live/startup；scheduler/assignment、conversation、intent、interaction/confirmation/final/delivery；响应丢失/terminal replay | 同 installation；固定三组 consumer descriptor与 AuthorityCatalog 六种 pending kind exact-set | consumers 装配后、公开准入前重驱既有 recover/start；live 保持 gate unavailable；全部 obligation反绑 current owner后才清 private/开放/应答 | 非空六 kind 小表、迁前 cursor、live/startup与连续重启；删除/重复/绕过任一 consumer失败 |
| F34-15 | canonical 全部 registered RPC；anchor+executor/executor-only；旧 source/new target/第三设备、target离线 | canonical registry minus `{auth,health,server.shutdown}` 唯一 relay exact-set；signed current owner与surface generation | anchor根直接 current-anchor；executor-only按 local-conversation ownership选择 local router，否则 current-anchor；未知先由 registry拒绝，离线不回退 | registry exact-set逐方法参数化；双根/三设备每方法恰一执行，设备本地与未知零 remote副作用 |
| F34-16 | session.resolve、delivery、workscene、schedule、trust、skill、memory、status/light-inference、planned管理及通知/确认关联 | 同 F34-15 descriptor；conversationId/currentAuthority 与 current-anchor resolver各自唯一 owner | local session `handled:false`直接 canonical而不串入 anchor；其余在首次副作用前解析 current anchor；通知按principal/generation定向 | S7 对 exact-set/双根 composite 增删替换重复绕过；target离线retryable、reconnect后同surface收敛 |
| F34-17 | source 同一 candidate 的 ready→prepared 与 claim-only cancel 双序；same/异载荷、丢响应、重启 | candidate identity 与首次 `anchor-prepared` 共处 source `AuthorityCommitLog` 的 candidate/transfer projection transaction | exact replay→candidate 非终态→零 transfer state→append prepared；claim-only release 仅在零 transfer state 成立，输掉竞争零 append/remote cleanup | 真实 source log 用可控 ready 屏障重造 cancel 先赢与 prepared 先赢，重启后只重放唯一决定 |
| F34-18 | target prepared 前后迟到 signed release、进程重启、abort/commit terminal 与物理 cleanup | target-wide candidate decision 与稳定 per-transfer journal；issuer key、reservation、private/journal root仅为决定后的可重驱效果 | target 首次 prepared 先耐久封闭 claim-only release；release 必从稳定路径读取零 transfer state，prepared+稳定拒绝且零删 key/root | 真实 target staging 重启后投递迟到 release；错 identity/重复/响应丢失均不删除唯一重驱材料 |
| F34-19 | live target 已 discovery 后 install；六类 pending 的零/单/多组合，恢复效果前后失败与连续重启 | installed authority generation、当前 composite snapshot 与 conversation recovery generation；catalog obligation identity `{kind,id}` | planned-install 专用 recovery 先停 loop/等 claim，失效旧 generation cache，再从新 snapshot发现并恢复；每项 read-back 为 terminal 或 current-owner pending 后方可开放 | 真实 live protocol 先 discovery 再换 base，六类 obligation 逐项证明 current-owner/terminal，不接受二次 `recoverReadinessProjections()` no-op |
| F34-20 | source delivery timer/主动 flush 在 fence 前、中、后；pre-commit abort、commit、stop与响应丢失 | 同 transfer source closure 与 delivery pipeline quiesced/running 状态；delivery item仍只由 authority log授权 | quiesce 原子拒新 flush并等待 active；abort仅恢复原 pipeline，commit永久保持 quiesced；target按新 authority recover/flush | 可控 transport 阻塞 active flush，证明 closure返回后旧 source零新 send，abort可恢复且commit不可恢复 |
| F34-21 | current source/new target/第三 anchor 的 configured channel；启动、迁前停收、abort、commit、post-install、重投 | signed current anchor deviceId、planned readiness 与同一 registry connection plan；message/conversation identity不变 | 配置/注册与 connect分离；仅 current+ready 连接。source gate→等 accepted→disconnect，abort重连；target仅 consumer closure后连接，commit后旧source不重连 | 三设备连接状态与入站计数小表；连接切换/响应丢失窗口始终至多一处可进入 owner副作用 |
| F34-22 | channel callback 在断连竞态、旧连接迟到、target 尚未 ready、adapter 重投时进入；confirmation/challenge/normal message | `InboundRouter` 的 current-owner/readiness predicate与 accepted in-flight set | `handleMessage` 首个业务副作用前终检；非 current/未ready零 conversation/confirmation写；拒新后只等待已 accepted，provider重投由新current同 identity处理 | 直接 router guard + assembly lifecycle测试；删除 final guard、提前 target connect或abort漏重连均失败 |

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
| C34-C16 | U34-09：target phase journal 按 transfer 分目录/分 log，无法用“本 transfer transaction”线性化异 transfer竞争。 | F34-12 固定唯一 target-wide claim journal；per-transfer journal只保留 phase/private progress，不承担候选选主。 |
| C34-C17 | U34-09：即使 prepare 原子，`ready()` 仍会在 durable phase 前创建 transfer issuer key。 | F34-11/12 固定双端 claim-before-remote/context/key/reservation；S7顺序变异与真实 key store反例共同拒绝。 |
| C34-C18 | U34-04：install 后 trust 立即把本机角色从 target 翻为 owner，依赖 `#plannedAnchorTarget.recoverBeforeAdmission()` 的恢复入口在重启时不存在。 | F34-13 把 completion 放到 role composition 前的 bootstrap store/secret/private窄适配器；live target调用同函数。 |
| C34-C19 | U34-04：private root 在 `onInstalled` 后立即删除，而迁前 cursor/pending owners尚无统一完成门禁；只补 key仍会过早公开。 | F34-14 固定三组 consumer与六种 pending kind；consumer成功后才cleanup/open/respond，失败保留install并重驱。 |
| C34-C20 | U34-03：executor-only 只有 local router；简单串联两个 router 会把“本地拥有、应回 canonical”的 `handled:false` 再转给 current anchor。 | F34-15/16 先按 method ownership选择单一路由；local方法的false直接回 canonical，其余才进入 current-anchor。 |
| C34-C21 | U34-03：现有 S7 只抽样 `session.new` 与四个 `dutyMigration.*`，不能证明 canonical registered authority方法全覆盖。 | relay exact-set由 canonical registry减去三项设备本地方法单源派生，production/S7共用并双向exact-set。 |
| C34-C22 | U34-09↔U34-04：target install/abort已成终态但candidate claim未终结，会永久阻塞后续合法迁居。 | private commit/abort先耐久，随后同identity终结target claim；install completion/cleanup exact replay不得反向释放错误candidate。 |
| C34-C23 | U34-04↔U34-03：install使resolver立即指向target，但consumer closure尚未完成；回退旧source会破坏永久fence，直接放行target会暴露旧cursor。 | current-owner始终是target；F34-14完成前其finite exact-set稳定unavailable/retryable，完成后原surface重放，不回退source。 |
| C34-C24 | U34-09↔U34-03：四个planned管理RPC若各自能创建candidate，路由exact-set仍会留下第二claim入口。 | 仅prepare调用claim；targets纯读，commit/cancel/continue必须携原transfer identity并只消费existing claim；S7反绑调用点exact-set。 |
| C34-C25 | U34-09：claim 已落而 ready/key/prepare 持续失败时，要求“先 prepared 再 abort”会使用户取消无法终结 target-wide claim。 | 增加仅消费全等 claim 的窄签名 `candidate-release`；source 先写 claim-only terminal并保留投递义务，target terminal后清本transfer资源，响应丢失exact replay。 |
| C34-C26 | U34-04：pre-bootstrap 早于 `setupAuthorityRuntime`，不能假设运行期 `authority.verifier` 已存在。 | 抽取现有 trusted-identities verifier 构造供 bootstrap completion复用；只验安装前缀成员签名，不新增 trust/identity 来源。 |
| C34-C27 | U34-09↔U34-05：新增 target-wide claim log 若未复用设备 governor，会为 candidate metadata 重开容量/stop 旁路。 | claim log注入现有同一 `storageMaintenance` 并由 planned closing runtime持有；不改变U34-05的chunk/network边界。 |
| C34-C28 | U34-09：source remote ready await 把 candidate terminal检查与首次 prepared append分开，release/prepared可同时成立。 | F34-17要求二者进入同一 source log projection transaction；普通 `append(preparedRecord)` 不再是合法首次入口。 |
| C34-C29 | U34-09：target重启清空 `#contexts` 后，迟到 release可绕过per-transfer phase并删除prepared材料。 | F34-18要求稳定路径 phase判定，并以耐久 prepared decision封闭检查→清理竞态；拒绝路径零物理副作用。 |
| C34-C30 | U34-04：live protocol的one-shot discovery在install前已完成，post-install callback形态正确但实际恢复为0。 | F34-19增加planned-install专用authority generation重置/重发现；普通readiness恢复不得冒充换代恢复。 |
| C34-C31 | U34-04：source closure中的一次 `flush()` 不会停止timer，commit后仍可能外发同一delivery。 | F34-20以窄quiesce切断新flush并等待active；abort恢复，commit保持永久quiesced。 |
| C34-C32 | U34-04：三组callback忽略传入obligations，调用成功不能证明六类catalog owner已交接。 | F34-19要求消费同一分组并对current composite projection逐项read-back，失败保留private progress和ready gate。 |
| C34-C33 | U34-03：canonical RPC exact-set不包含provider channel长连接，非current anchor仍可物理接收并写本地authority。 | F34-21把现有registry connection plan纳入signed current-owner生命周期；不新增channel relay。 |
| C34-C34 | U34-03↔U34-04：只切连接仍存在迟到callback与post-install未ready窗口；只在router丢弃又可能吞provider已确认消息。 | F34-21/22组合：连接所有权是主边界，router终检只封竞态；target在consumer closure后连接，旧连接事件由新current重投/exact identity收敛。 |

### U34-03、U34-04、U34-09 四路冷启动对抗复审

- **未修改问题列表基线**：`sha256:614e60e6be1ab45d457efbb06efba00831186c3922bb6d75efd396ab41a9e75f`（U34-03/U34-04/U34-09、F34-11～F34-16、C34-C16～C34-C27）。四路均从权威条款和当前生产源码重建反例，未复用前轮结论；复审期间该基线未修改。

| 冷启动角色 | 主动重造的反例与直接交界 | 独立结论 |
| ---------- | ------------------------ | -------- |
| planned candidate 跨 transfer 单飞 | source/target 同时空投影的异 transfer、claim→key、key→prepared、claim-only cancel、commit/abort terminal、丢响应/连续重启；核查 U34-09↔U34-04/U34-03 及 U34-05 governor | 通过。source 共享 authority transaction 与 target-wide claim transaction 分别给出唯一线性化点；claim-before-effect、签名 release、terminal→claim 顺序及四入口 exact-set 已覆盖全部零副作用/恢复终态，per-transfer journal 不再冒充选主。 |
| target pre-bootstrap/post-install 与有限 consumer 恢复 | install→key/private/onInstalled/cleanup 每个崩溃点、target→owner 角色翻转、source 离线、live/startup、六种非空 pending 与旧 cursor；核查 U34-04↔U34-09/U34-03 | 通过。角色无关第一段在 current-issuer gate 前完成，trusted-identities verifier依赖已闭合；固定三组 consumer在公开准入前消费同一 install，失败只保持 target unavailable且不回退永久 fenced source。 |
| current-owner 第一方入口 exact-set | canonical 每个 registered method、executor-local conversation、旧 source/new target/第三设备、target离线、未知/设备本地方法、通知/确认 surface；核查 U34-03↔U34-04/U34-09 | 通过。registry-minus-`auth/health/server.shutdown` 是唯一 relay exact-set；anchor根直接路由，executor-only按 ownership二选一，local `handled:false` 不会误串 current-anchor；离线重试与定向通知均无旧owner副作用。 |
| 生产证据、产品体验与范围价值 | 逐项反向尝试删除P0/P1、改为客户端串行/启动报错/通用RPC或lifecycle框架，并对账EX34-01、既有U34问题及第35～38单元 | 通过。U34-04合法切点导致source已fenced后的持续停摆，P0/大成立；U34-03/U34-09分别造成迁后入口割裂和双候选耐久冲突，P1/中成立。F34-11～F34-16与现有S7/真实小表成比例，EX34-01无新独立根因，后继能力与通用设施零进入。 |

### U34-03、U34-04、U34-09 修复后冻结专项复核

- **冻结指纹**：`sha256:52519474c5c8553cbda2b583a50d8e7504344319aae349f48e165751d8a6d1b2`。算法为对当前差异中的 22 个非工作台生产/测试/S7 文件按路径排序，逐文件计算 SHA-256，再对 `path<TAB>hash` 的 UTF-8 清单计算 SHA-256；下列矩阵、四路角色与反证差异审计均只读绑定该指纹。

| 固定矩阵 | 修复后事实链与直接证据 | 结论 |
| -------- | ---------------------- | ---- |
| F34-11 | source `claimCandidate` 在同一 authority projection transaction 内先固定完整 identity，再发 remote ready；四入口只有 prepare 可创建，claim-only terminal/release 可在丢响应与重启后继续投递。真实 source log 异 transfer 并发和 lost-ready cancel 已覆盖。 | 通过；fresh loser 在 remote/key/staging 前稳定拒绝，same-transfer exact replay 复用唯一 claim。 |
| F34-12 | target 稳定 `candidate-claims` journal 复用 `FileAuthorityCommitLog`、同 artifacts/governor/lifecycle；claim 在 `#context`、issuer key、reservation、private staging 前，commit/abort/release 先耐久 terminal 再清理。真实 target-wide 并发与 S7 顺序变异已覆盖。 | 通过；异 transfer 恰一进入 key/prepared，失败者零私有副作用，terminal/连续恢复无孤儿 claim。 |
| F34-13 | `completePlannedAnchorInstallationBeforeBootstrap` 只读取当前 `transfer:anchor-current` installation，在 active-key/role composition 前核验 trust/base/target、补 exact key 与 private committed；live `onInstalled` 复用同一 helper。真实 install 后 key 激活故障重启覆盖角色翻转切点。 | 通过；无 install 零副作用，错 key/journal/trust fail-closed，合法 terminal replay 唯一。 |
| F34-14 | assembly 固定分区三组 consumer，覆盖 AuthorityCatalog 六种 pending kind；scheduler/conversation/delivery 复用既有 recover/start，`plannedCurrentOwnerReady` 同时门禁本地 router 与认证 mesh target，成功后才 finish/cleanup/open。六类非空分区与 missed issuer 场景已覆盖。 | 通过；live/startup 任一失败均保持 new owner unavailable且不回退永久 fenced source，连续恢复最终开放同一 owner。 |
| F34-15 | server canonical registry 唯一派生 relay exact-set，仅排除 `auth/health/server.shutdown`；mesh target/client/router 共用该集合，anchor+executor 直接 current-anchor，未知 method 在 canonical/finite lookup 拒绝。exact-set 与 target unavailable 测试覆盖。 | 通过；旧 source/new target/第三设备每个 canonical authority method 恰一路由，设备本地/未知零误代理。 |
| F34-16 | executor-only 用 `ExecutorFirstPartyRpcRouter` 先判 local session/confirmation ownership（含 `session.resolve`），local `handled:false` 直接返回 canonical；其余 canonical authority method 才进 current-anchor。surface principal/generation 继续定向通知与迟到代际拒绝。两份直接测试与 S7 双根变异覆盖。 | 通过；本地与 current-anchor 所有权不串路，离线只 retryable，不恢复旧 source。 |

| 冷启动对抗角色 | 主动重造的反例与交界 | 修复后独立结论 |
| ---------------- | ---------------------- | ---------------- |
| planned candidate 跨 transfer 单飞 | 双端空投影、异 transfer 同时 prepare、claim→key、key→prepared、claim-only cancel、terminal/丢响应/重启；交叉 U34-09↔U34-04/U34-03 与 U34-05 governor。 | 通过；source/target 各自唯一耐久 transaction，双端均 claim-before-effect，release/terminal 顺序可重驱，四入口不存在第二选主点。 |
| target pre-bootstrap/post-install consumer 闭包 | install→key/private/onInstalled/consumer/cleanup 每个切点、角色翻转、source 离线、六类非空 pending、live/startup/连续重启；交叉 U34-04↔U34-09/U34-03。 | 通过；installation 是唯一 trigger，bootstrap helper 不依赖运行期 verifier，三组 consumer 完成前所有 current-owner first-party surface 稳定 unavailable。 |
| current-owner 第一方 exact-set | canonical registry 全方法、两生产根、旧 source/new target/第三设备、executor-local conversation、target 离线、未知/设备本地、通知/确认代际；交叉 U34-03↔U34-04/U34-09。 | 通过；registry-minus-local 单源、双根 ownership composite 与 surface generation 给出唯一执行路径，local false 与离线均不回退旧 source。 |
| 生产证据、产品价值与范围边界 | 反向尝试以客户端串行、启动报错、通用锁/registry/lifecycle/RPC代理替代；对账 U34-01/02/05～08、EX34-01 与第35～38单元。 | 通过；三项当前损失、评级和方案比例性仍成立；现有真实小表、S7 18/18、类型诊断和 workspace build 成比例，EX34-01无独立新根因，后继能力零进入。 |

| 反证账 | 差异审计关闭方式 | 冻结指纹上的处置 |
| ------ | ---------------- | ---------------- |
| C34-C16、C34-C17、C34-C25 | 修复后复核通过 | target-wide journal 与双端 claim-before-effect、签名 release 已由真实并发/丢响应测试和 S7 同时反绑。 |
| C34-C18、C34-C19、C34-C26 | 修复后复核通过 | role composition 前 helper、窄 trusted-identities verifier、三组 consumer/六类 pending gate 已进入 live/startup 共用链。 |
| C34-C20、C34-C21 | 修复后复核通过 | canonical registry-minus-local 与 executor-only ownership composite 已单源化，exact-set/unknown/local-false 反例通过。 |
| C34-C22、C34-C23、C34-C24 | 修复后复核通过 | private terminal→claim、new-owner unavailable gate 与 prepare-only claim exact-set 关闭三项直接交界。 |
| C34-C27 | 修复后复核通过 | target-wide claim log 使用同一 `storageMaintenance`，planned closing runtime 包含其物理步骤，未重开 U34-05。 |

- **差异审计结论**：C34-C16～C34-C27 无未处置项；历轮专项结论均能以“修复后复核通过”关闭，未出现必须新增编号的反证。U34-01～U34-02、U34-05～U34-08 未被本轮改写；EX34-01 重开条件及第35～38单元边界未触发。

### U34-03、U34-04、U34-09 最新同根修复后冻结专项复核

- **冻结指纹**：`sha256:183ec30ed6238f9e9919cbd166cbec1fd8638f1908219753013987d230fb92b4`。算法为对本次差异中的 17 个非工作台生产、直接测试与 S7 文件按路径排序，逐文件计算 SHA-256，再对 `path<TAB>hash` 的 UTF-8 清单计算 SHA-256。最终 workspace build 之后仅修正 S7 变异用例的合法期望值，生产源码与构建输入未变化；下列事实链、四路角色和差异审计均只读绑定该指纹。

| 固定矩阵 | 冻结事实链与直接证据 | 结论 |
| -------- | -------------------- | ---- |
| F34-17 | source 首次 prepared 与 claim-only release 共用 candidate+transfer projection transaction；同锁内重读 terminal/transfer state，输掉竞争者零 append。真实 ready 屏障覆盖 cancel 先赢、prepared 先赢及既有 exact replay。 | 通过；released/prepared 不可并存，响应丢失与重启只重放唯一决定。 |
| F34-18 | target 在 per-transfer prepared 之前先耐久记录 candidate prepared；迟到 release 每次从稳定 staging root 打开 phase journal并在任何 key/root清理前判定，拒绝路径零物理副作用。 | 通过；重启清空内存 context 后仍不能删除 prepared key/journal/staging。 |
| F34-19 | planned install 调用 `recoverInstalledAuthority()`：停 recovery loop、等待在途 claim、切换 authority generation、失效旧 generation 派生状态并从新 composite snapshot 重发现；三组 callback 返回原 obligation receipt且 durable read-back逐项证明 current-owner或terminal。 | 通过；live one-shot discovery不能再让迁入 consumer恢复假成功，六类 pending 全部在开放前闭合。 |
| F34-20 | source delivery pipeline 的 quiesce原子拒绝新 flush、清 timer并等待 active flush；durable abort才恢复，commit保持永久quiesced。可控 active send场景证明 closure 等待与恢复边界。 | 通过；网络外发所有权与source fence同切点，commit后旧source零新delivery副作用。 |
| F34-21 | channel配置注册与物理连接分离；signed current anchor与planned readiness形成唯一connection plan。source拒新并等待accepted后断连，abort重连，target在post-install/cleanup后连接。 | 通过；current source/new target/第三anchor在切换窗口至多一个物理入站owner。 |
| F34-22 | `InboundRouter` 在adapter/conversation/confirmation前执行current-owner终检并跟踪accepted in-flight；challenge callback复用同一守卫。非current、未ready与迟到旧连接均在业务副作用前拒绝。 | 通过；连接是主边界，message/challenge守卫只封竞态且不建立relay。 |

| 冷启动对抗角色 | 主动重造的反例与直接交界 | 冻结指纹上的独立结论 |
| ---------------- | ------------------------ | ---------------------- |
| candidate terminal/prepared 与物理 cleanup 耐久排序 | cancel↔ready/prepared双序、same/异载荷、target prepared后重启、迟到签名release、abort/commit、丢响应和连续重启；交叉U34-09↔U34-04/U34-03。 | 通过；双端唯一耐久判定均先于副作用，prepared/released恰一，拒绝路径不清唯一重驱材料。 |
| source/target runtime consumer 恰一所有权 | active delivery阻塞、timer、commit/abort；live protocol先完成旧discovery再安装新base；三组consumer/六种pending、效果前后失败与连续重启；交叉U34-04↔U34-09/U34-03。 | 通过；旧source quiesce与new target authority generation/read-back形成唯一交接，private cleanup和surface开放都在完整消费之后。 |
| channel ingress 物理 owner 与切换竞态 | current source/new target/第三anchor、启动、source drain、abort重连、target开放、旧callback、普通message/challenge、响应丢失；交叉U34-03↔U34-04/U34-09。 | 通过；connection plan是唯一物理owner，router/challenge final guard覆盖迟到竞态，target离线不回退旧source。 |
| 生产证据、产品体验与范围价值 | 尝试以尽力取消、一次flush、router静默丢弃或通用channel relay/lifecycle代替；对账U34-01/02/05～08、EX34-01和第35～38单元。 | 通过；三项P0/P1当前损失与方案比例性仍成立，现有窄原语和有限S7足够，无通用框架、后继恢复或连续同步进入。 |

| 反证账 | 差异审计关闭方式 | 冻结指纹上的耐久处置 |
| ------ | ---------------- | ---------------------- |
| C34-C28、C34-C29 | 修复后复核通过 | source事务与target耐久prepared+稳定phase判定共同关闭cancel/prepared双序和重启迟到release。 |
| C34-C30、C34-C32 | 修复后复核通过 | authority generation重发现、callback exact receipt和durable obligation read-back关闭live no-op与分组假完成。 |
| C34-C31 | 修复后复核通过 | delivery quiesce、active等待与abort-only resume关闭timer残留owner。 |
| C34-C33、C34-C34 | 修复后复核通过 | current-owner connection plan、accepted drain、message/challenge终检和post-install后开放关闭channel物理owner与迟到竞态。 |
| C34-C16～C34-C27 | 当前源码证伪同根回归 | 既有跨transfer claim、pre-bootstrap key/private、canonical RPC exact-set、governor及三项交界仍由当前实现/S7覆盖；未恢复旧方案。 |

- **差异审计结论**：C34-C16～C34-C34 全部以“修复后复核通过”或“当前源码证伪同根回归”关闭；四路未发现需要新增稳定编号的反证。U34-01～U34-02、U34-05～U34-08 未被改写，EX34-01 重开条件与第35～38单元边界均未触发。

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX34-01 | 原 P34-12 主张“S7 与直接证据缺口”应作为独立 P1/中问题；本轮逐项对账确认其三组缺口分别是 U34-09 的 candidate 单飞、U34-04 的安装恢复、U34-03 的入口 exact-set 的直接验收面，没有第四个生产根因。 | 独立登记只会重复工作量和提交门禁，不能增加用户价值；IR34-33、IR34-34 以及各自必要的有限 S7/真实反例已完整并入 U34-03、U34-04、U34-09 的方案与验收。排除仅针对“独立证据根因”，不免除三项各自的证据义务。 | 2026-08-09 独立审查 P34-09～P34-12 的价值裁决；当前正式问题行 U34-03、U34-04、U34-09 及 IR34-33、IR34-34。 | 三项生产根因修复后仍有一项适用核心合同完全没有成比例直接证据，或现有 gate 对独立于三项的新生产装配漂移假绿，并有新的生产事实证明其不归属于三项时重开。 | 已排除 |

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
| V34-05 | U34-07：两根 owner/target/driver/lifecycle/current-owner exact-set 与 registry golden | `pnpm s7:lint` | `scripts/s7-entry-coverage.mjs`、变异测试、canonical registry golden | 派生资产/合同预检；50.9s | 历史 18/18 与 registry golden 通过；最新独立审查证明 gate 未覆盖 durable phase cleanup、runtime consumer ownership与channel owner，待三项修复后补最小变异 | 当前问题基线 | 失效 |
| V34-06 | 受影响 CLI 类型闭包无新增类型错误 | `pnpm --filter @zhixing/cli exec tsc --noEmit` | Unit34 CLI/core/server 消费闭包及仓库既有 CLI 源码 | 修复诊断 | 仅余 8 个与 Unit34 无关、修复前已存在的 `ZhixingCredentials` 错误；首次发现的 `Dirent` 新错误已修复 | 当前冻结指纹 | 诊断 |
| V34-07 | 当前源码与跨包导出可构建 | `pnpm build` | 当前全部源码、包导出与构建配置 | 常驻必要构建；197.9s | 通过，exit 0 | 当前冻结指纹 | 有效 |
| V34-08 | F34-01～F34-10、C34-C01～C34-C15 在同一输入上完成专项事实链与四路冷启动对抗 | 冻结指纹复算 + 四个相互隔离的只读角色复核 | 28 个非工作台路径及正式矩阵/反证账 | 修复专项收口 | 四路均无新增反证；指纹 `6e7b3fadd1358c6b3af463814682f79c111d30fb1c01415f0da968f5cbd1f6d3` | 当前冻结指纹 | 有效 |
| V34-09 | U34-09 双端 candidate claim、release 与连续恢复 | planned transfer 真实 source/target 定向集 | source authority log、target-wide claim journal、key/private staging 与 signed release | 修复直接验证 | 历史16/16未覆盖cancel↔prepared事务双序与target重启迟到release；待补真实竞争/恢复证据 | `52519474…d8a6d1b2` | 失效 |
| V34-10 | U34-04 pre-bootstrap 与 post-install consumer closure | install/key/consumer 定向单例 + 六类 pending 分组测试 | target installation/private journal、trusted verifier、scheduler/conversation/delivery consumer | 修复直接验证 | 历史分组证据未证明live conversation按新authority重建及source delivery timer停机；待补真实consumer所有权切点 | `52519474…d8a6d1b2` | 失效 |
| V34-11 | U34-03 canonical exact-set、双根 ownership 与 surface gate | first-party mesh + local RPC 定向测试；`pnpm s7:lint` | server canonical registry、mesh/client/target、两生产根 composite 与现有 S7 | 修复直接验证 / 派生资产预检 | 历史RPC exact-set仍可复用，但未覆盖channel-inbound物理owner；待补三设备channel lifecycle与S7反绑 | `52519474…d8a6d1b2` | 失效 |
| V34-12 | 当前三项跨包源码与导出可消费 | `pnpm build`；CLI `tsc --noEmit` 诊断 | 当前 workspace source、包导出与三项消费闭包 | 常驻必要构建 172.5s / 类型诊断 | workspace build exit 0；类型检查新增错误 0，仅余修复前既有且无关的 8 个 `ZhixingCredentials` 错误 | `52519474…d8a6d1b2` | 有效 |
| V34-13 | F34-11～F34-16、C34-C16～C34-C27 修复后专项事实链与四路冷启动对抗 | 冻结指纹复算 + 四个相互隔离的只读角色复核 | 22 个非工作台路径及正式矩阵/反证账 | 修复专项收口 | 最新独立审查发现U34-03/U34-04/U34-09三项同根残留，旧四路结论不得作为现行收口证据 | `52519474…d8a6d1b2` | 失效 |
| V34-14 | U34-09 terminal/prepared唯一耐久排序与重启cleanup | CLI planned transfer定向集：cancel先赢、prepared先赢后target重启迟到release、既有正常prepare | source真实AuthorityCommitLog、target稳定phase journal、candidate/key/staging与直接测试 | 修复直接验证 | 3/3通过；拒绝release零key/root删除，唯一决定可exact replay | `183ec30…92b4` | 有效 |
| V34-15 | U34-04 source/target runtime consumer所有权 | conversation installed-authority重发现定向单例；delivery quiesce/active/resume定向单例；六类obligation分组/receipt定向单例 | live protocol、core delivery pipeline、planned lifecycle、assembly consumer receipt与AuthorityCatalog read-back | 修复直接验证 | 3/3通过；旧generation、active send、六类非空owner切点均有直接正反例 | `183ec30…92b4` | 有效 |
| V34-16 | U34-03 channel current-owner物理连接与最终守卫 | CLI channel deferred connect/disconnect + challenge竞态；server non-current message + accepted drain | channel registry/adapter、signed current-owner predicate、InboundRouter与planned connection lifecycle | 修复直接验证 | 4/4通过；非current message/challenge零业务副作用，drain等待已接纳输入 | `183ec30…92b4` | 有效 |
| V34-17 | 当前三项跨包源码、有限装配gate与导出可消费 | core/server `tsc --noEmit`；CLI类型诊断；`pnpm s7:lint`；`pnpm build` | 17个非工作台路径、跨包导出、S7 descriptor/mutation/golden与当前workspace源码 | 类型/派生资产/常驻必要构建；workspace build 154.6s | core/server类型通过；CLI新增错误0、仅余8个既有无关`ZhixingCredentials`错误；S7 18/18及registry golden通过；workspace build exit 0 | `183ec30…92b4` | 有效 |
| V34-18 | F34-17～F34-22、C34-C28～C34-C34与直接交界在同一输入逐格闭合 | 冻结指纹复算 + 四个相互隔离的只读冷启动角色 + 历轮反证差异审计 | 17个非工作台路径、正式矩阵/反证账及U34/EX/后继边界 | 修复专项收口 | 四路均无新增反证；C34-C16～C34-C34全部耐久关闭，EX34-01与第35～38单元未重开 | `183ec30ed6238f9e9919cbd166cbec1fd8638f1908219753013987d230fb92b4` | 有效 |

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
