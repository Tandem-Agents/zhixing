# 单元登记:第 34 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:34
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-09
- **登记来源**:用户要求将第 34 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U34-03、U34-04、U34-09 专项修复已启动：已从权威架构、规格与当前生产装配重建 F34-11～F34-16，并确认 C34-C16～C34-C27 均仍命中同根生产缺口；当前 1 个 P0、2 个 P1 均为“修复中”。U34-01～U34-02、U34-05～U34-08 与 EX34-01 的既有结论继续保留；尚未进入本单元两轮冻结终审、独立功能审查或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅指本次 U34-01～U34-08 修复专项；正式单元终审仍按工作台闭环另行执行）
- **交付物文件集**:当前 `HEAD 735a3dcd…` 加工作区的第 34 单元修复交付，共 28 个非工作台功能、架构与测试路径：core 5、CLI 16、server 2、架构 3、S7 2；工作台文件不参与功能指纹
- **当前交付物指纹**:`6e7b3fadd1358c6b3af463814682f79c111d30fb1c01415f0da968f5cbd1f6d3`
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
| U34-03 | **P1/中。**`CurrentAnchorFirstPartyRpcRouter`/mesh target/client 共用的 `METHODS` 仍是抽样集：漏掉 canonical registry 与 S7 ownership 已登记的 `session.resolve`、`delivery.resolve`、workscene/schedule/trust/skill/memory/status/light-inference 等入口；anchor+executor 根只装 current-anchor router，executor-only 根只装 `LocalConversationRpcRouter`，后者对范围外方法直接 `handled:false`。**同根重开记录：**U34-03 曾以 P1/大完成 signed trust/current-owner 接管并标为已验证；本轮生产 exact-set 与双根装配证明“全部第一方入口统一解析 new owner”的关闭条件尚未满足。**价值裁决记录：**原结论为 P1/中；对立复核排除了让旧 source 下游报错及通用 RPC 代理。新决定保留 P1/中：以 canonical builtin registry 减去明确设备本地 `auth`、`health`、`server.shutdown` 得到唯一有限 relay exact-set；executor-only 先按 local-conversation ownership 分流，再把其余集合交 current-anchor resolver。用户体验与架构均达标；仅当方法被权威重归设备本地或已有同等前置 current-owner 路由时移除。**最终结论：改写并保留。** | 第一方 composition 没有消费 canonical registry 的完整 authority ownership：生产路由与 S7 各维护抽样方法，且 executor-only 缺少“local conversation 或 current anchor”的有限所有权选择。 | **生产端：**canonical registry descriptor、认证 mesh router/target/client、current-authority resolver、anchor+executor 与 executor-only server composition。**组合：**旧 source、new target、第三设备，target 在线/离线，全部 registered authority RPC，未知方法、设备本地方法及 executor-local conversation。**消费者：**session/confirmation、delivery、workscene、schedule、trust、skill、memory、status/light-inference、planned 管理及通知 relay。**异常终态：**部分入口命中新 owner，部分在旧 source/第三设备读旧投影或到下游 fence 才失败；executor-only 若无所有权分流还会误把本地会话发往 anchor。**直接证据：**registry-minus-local exact-set、双根 composition、三设备认证 surface 与 S7 增删/绕过变异。**受影响审查项：**IR34-22、IR34-23、IR34-33、IR34-34。 | 从现有 canonical registry 导出冻结的 relay exact-set，唯一排除设备本地 `auth`、`health`、`server.shutdown`；router、mesh client/target 与 S7 共用该集合，未知方法在 canonical lookup 处拒绝。anchor+executor 直接使用 current-anchor router；executor-only 增加有限 composite：命中 local session/confirmation ownership 时只委托 `LocalConversationRpcRouter`（补齐 `session.resolve`），其 `handled:false` 直接回 canonical，不再串入 anchor；其余 relay 方法才委托 current-anchor router。target 离线稳定返回 retryable且绝不回退旧 source，通知仍按 surface identity/generation 定向 relay。**完成：**两生产根、旧 source/new target/第三设备的 registry-minus-local exact-set 恰一执行于权威 owner；本地会话、设备本地及未知方法零误代理，S7 对任一方法/根的增删、替换、重复、绕过 fail-closed。 | 已验证 |
| U34-04 | **P0/大。**target `installPlannedAnchorPrefix()` 已原子发布 source base、trust/current/install 后才激活 transfer issuer key、写私有 journal `committed`、执行 `onInstalled`；重启先从同一 log 解析本机为 current issuer，却在 target role recovery 建立前因缺 active key fail-stop，且 install 后角色已从 `target:*` 变为 `owner:*`，原 target object 不会再装配。live runtime 还可能保留迁前 scheduler/conversation/intent/confirmation/final/delivery cursor 或 owner。**同根重开记录：**U34-04 曾以 P1/中闭合双端 phase 重驱；该合法切点触发“target committed replay 继续 post-install effects”的正式重开条件。**价值裁决记录：**原 P0/大方案曾宽泛要求重建所有 consumer；对立复核把范围收窄为角色无关的 pre-bootstrap completion 与固定 consumer closure，保留 P0/大。用户体验达标：source 已永久 fenced 后 target 可自动恢复；架构达标：installed envelope 仍是唯一决定事实。仅当 key/journal/trust 与固定 consumer 在公开准入前均由同一 install 可重驱时关闭。**最终结论：改写并保留。** | `transfer:anchor-current` installation 虽是唯一提交事实，却没有成为角色判定前的 key/private-progress trigger，也没有成为 live/startup 共用的有限 post-install consumer trigger；现有 recovery 错误依赖安装前 target 角色。 | **生产端：**target authority install、`prepareMeshRuntimeBootstrap` current-issuer gate、transfer key/private journal、mesh role composition、live/startup phase driver 与 service admission。**组合：**install→key→private committed→consumer→cleanup 每一切点，source 在线/离线、响应丢失、target role 翻转、terminal replay 与连续重启。**消费者：**scheduler/assignment、conversation、intent、interaction/confirmation/final/delivery 及 AuthorityCatalog pending owners。**异常终态：**source 永久 fenced 而 target 连续启动失败，或 target 已对外 current 但仍持迁前 cursor/owner，造成无设备完整服务迁后权威。**直接证据：**真实双端 store/log、角色判定前 key 检查、live/startup consumer gate 与逐切点恢复。**受影响审查项：**IR34-19、IR34-21、IR34-24、IR34-26、IR34-27、IR34-33、IR34-34。 | 抽取 planned 专用、角色无关的两段 completion，二者只由当前 `transfer:anchor-current` installation `{transferId,targetId,commit,issuer,baseDigest}` 触发；把 `setupAuthorityRuntime` 现有“trusted identities→`ProtocolSignatureVerifier`”构造抽为同源窄 helper，供 bootstrap 私有 journal 验签复用，不产生新事实。第一段在 `prepareMeshRuntimeBootstrap` 解析 current issuer 后、`loadActiveAnchorIssuerKey` 前运行：验 installation/current trust/本机 target 全等；active key 缺失时从该 transfer 私有 key exact 验真并幂等激活，私有 journal 存在则从 install 签名决定把 imported 精确推进 committed，已清理但 active key 全等视为 terminal replay，任何歧义 fail-closed；live commit 复用同一函数。第二段在 authority consumers 已装配后、公开准入前（live 时保持 planned/current-owner gate unavailable）按固定 descriptor 重驱 `scheduler+intent+assignment`、`conversation+interaction+confirmation+final`、`delivery` 三组既有 recover/start，并对 AuthorityCatalog 六种 pending kind `{assignment,interaction,final,delivery,intent,confirmation}` 全量反绑 current owner；全部成功才开放服务、清 private root/ready reservation并返回 commit，失败保持 unavailable，由 startup/terminal replay继续。**完成：**install 后任意切点均从同一事实补齐 exact active key、private progress、trust 与固定 consumer；角色翻转不丢恢复入口，公开副作用前无迁前 cursor/owner，连续重启最终唯一 ready；无通用 lifecycle 或第二决定事实。 | 已验证 |
| U34-05 | **P1/中。**target permit 包住 async network range，source range 无 planned capacity step，export 通过 `readSnapshot` 整体 materialize；assembly stop 没有 planned closing gate、取消或等待在途物理步骤。网络挂起可长期占 permit，大 authority/容量饱和可 OOM 或阻塞设备维护，stop 后 I/O 终态不明。 | planned transfer 的 source/export、network、target/staging 物理步骤未共用同一 governor 与可取消 stop 生命周期。 | **生产端：**source log/export/CAS range、target ready/apply/network/import/promote/fsync、两生产根 assembly start/stop。**组合：**零/大 authority、海量 retained ref、容量饱和、磁盘满、网络挂起、并发 stop/cancel 与重启。**消费者：**ArtifactStore、private staging、同设备其他 storage work。**异常终态：**permit 泄漏、O(total) 驻留、stop 后继续写或伪造完成。**直接证据：**真实 governor、固定 chunk、挂起网络与 stop。**受影响审查项：**IR34-13、IR34-29。 | 保持 strict wire/ref，复用 `AuthorityCommitLog.readTail`、同 source-head 的 `ArtifactLifecycleIndex` retention snapshot 与现有 governor，建立本功能窄 `ChunkSource/ChunkSink`：分页序列化原 envelope，catalog/ref 清单以固定 header page 流式落同一 ArtifactStore；网络请求先取得固定 range，permit 只覆盖本地 read/decode/write/fsync并在交付后释放，绝不跨网络或 authority/store/lifecycle 锁。owner/target 共用 assembly `AbortSignal`、closing promise 与 in-flight registry；stop 先拒新 ready/apply/range 与 source command，再取消并等待 step/permit/disposer，耐久 phase 留给启动重驱。**完成：**驻留仅随固定并发×chunk/header page 增长，网络等待零 permit，stop 栅栏后全部端口零新物理效果，失败关闭不伪造 phase。 | 已验证 |
| U34-06 | **P1/中。**source 不可逆 commit 前只重验 trust/期限/catalog/transition；target commit 也不读当前 readiness。即使补“两次瞬时读取”，target 仍可在 ready 响应后、source commit 前漂移，造成 source 永久交权给失去能力的 target。**价值裁决记录：**原把 commit 安全与 CLI 展示合并为 P1/中；两者根因独立，故本项曾收窄为 P1/小，U34-08 单列。**收敛修订记录：**生产竞态证明瞬时双读不足，必须增加现有 transfer journal 内的 late-ready reservation并反绑生命周期/重启，故评级仍为 P1、工作量由小修正为中；未恢复 CLI 体验或其他已否定主张。若相关 revisions 被证明 transfer 全程不可变，或已有等价 reservation，方可删除。 | durable ReadyProof 没有与 target 当前 snapshot、source 唯一提交点共用一个跨响应窗口仍有效的 transfer 私有 late-ready reservation。 | **生产端：**existing-transfer ready replay、target imported→commit 边界、source atomic commit、target defensive commit。**组合：**trust/config/protocol/asset/service revision、secret unlock/issuer key、proof expiry，在复验前后漂移、响应丢失、commit/abort 竞争和重启。**消费者：**source commit guard、target phase driver与service admission。**异常终态：**不可回滚地交权给未 ready target。**直接证据：**逐 revision 和复验响应窗口竞争。**受影响审查项：**IR34-16。 | 不扩公开协议：existing-transfer `ready` 在 target lifecycle 锁内重读完整 readiness、secret/key并与原 ReadyProof exact-match，同时在现有 transfer journal 耐久记录该 proof digest、expiry与current snapshot的 late-ready reservation；会改变相关 revision 的本地路径必须先等待，或在证明 source 未 commit 时耐久 abort reservation。source 原子 commit 前重调同 transfer ready并要求 proof/reservation exact-match；target commit只接受同 reservation。断连/重启先向 source 查询 durable commit/abort：pre-commit expiry可稳定 abort，source commit 已存在则永远 forward-replay，服务等当前能力恢复。**完成：**任一 pre-commit 漂移均在 source commit 零副作用前拒绝，复验响应窗口不能绕过；未漂移、响应丢失、expiry与连续重启全等，post-commit 不倒退。 | 已验证 |
| U34-07 | **P1/中。**现有 happy path/mock 没有真实触发 fresh writer、非空 pending/retained、shared staging、双端切点、post-install 失败、peer/第一方接管、governor/stop、readiness 竞争与两生产根漂移，已实际漏过 U34-01～U34-06。绿色结果不足以安全提交。 | 直接验收证据未穿过本单元核心权威、耐久、资源与生产装配边界。 | **生产端：**strict codec/ready、planned owner/target/phase driver/mesh assembly、S7 两根。**组合：**U34-01～U34-06 的真实非空义务/资产、响应丢失、连续恢复、旧 issuer、stop、late-ready 竞争和装配变异。**消费者：**提交门禁与后续维护者。**异常终态：**缺陷在绿色证据下提交并同根返工。**受影响审查项：**IR34-34。 | 仅扩展现有 planned-transfer/assembly/first-party/S7 测试：用真实双端 `AuthorityCommitLog`、`FileArtifactStore`、`ArtifactLifecycleIndex`、governor、private staging与两生产根跑有限小表；组件矩阵直接复用。生产小表至少覆盖 source fresh+accepted、non-empty retained+atomic install、双端 commit/abort loss+restart、old source/peer/first-party、capacity/network/stop、late-ready drift；S7 对两根 owner/target/driver/lifecycle exact-set 做删除、替换、重复和绕过变异。**完成：**U34-01～U34-06 各根因至少一条真实正反例，production builder 与 gate 共同拒绝漂移，不新建 runner 或配置×故障笛卡尔积。 | 已验证 |
| U34-08 | **P2/中。**targets 只返回 trust 候选，CLI 显示 `displayName（deviceId）` 并要求 raw ID；用户只能在 prepare 后得到泛化失败。**价值裁决记录：**原并入 U34-06/P1；它不影响 authority 正确性或耐久终态，故拆为 P2/中，但仍违反 Unit 34 锁定的设备选择体验。仅当产品正式改为运维 raw-ID 接口或已有等价唯一选择面时重开。 | 用户目标投影把内部 target identity、无副作用 readiness summary 和设备名选择混在传输命令层。 | **生产端：**target readiness summary、server targets DTO、TTY/非TTY CLI list/migrate selector。**组合：**ready/缺口、target 离线、唯一名称、重名、序号、状态刷新和 prepare 拒绝。**消费者：**迁居用户。**异常终态：**暴露内部 ID、误选或多一次可避免往返，无耐久破坏。**直接证据：**DTO exact keys与CLI交互。**受影响审查项：**IR34-31。 | 在现有 target service 增加只读、无 issuer-key/staging 副作用的有限 readiness summary，复用 U34-06 snapshot predicate；`targets` 只返回 opaque internal ID、displayName、ready 与有限缺口 code。TTY仅渲染设备名/状态/可行动提示并用交互序号选择；非TTY只接受唯一 displayName，重名稳定拒绝且不泄露 raw ID；prepare仍使用内部 ID与严格 proof。**完成：**受支持旅程不展示或要求 raw ID，缺口在 prepare 前可行动，列表查询零 transfer 副作用且内部关联严格。 | 已验证 |
| U34-09 | **P1/中。**source `assertNoCompetingTransfer()` 与 `append(prepared)` 分离，`append()` 的事务虽重建整条 source stream，却只归约当前 transfer；target `ready()` 先按各 transfer 私有 journal 读竞争状态，再创建 issuer key，`prepare` 再读后写。两个异 transfer 可同时通过空投影；且 target 每个 transfer 使用独立 `FileAuthorityCommitLog`，所谓“同一 target journal 事务”事实上无法跨 transfer 仲裁。**价值裁决记录：**原结论为 P1/中；对立复核排除了客户端串行、进程 mutex及复用 per-transfer journal。新决定保留 P1/中：source 在既有 authority log 内 claim，target 在同 staging root 增加唯一 target-wide 窄 claim journal，二者均先 claim 后 key/context/prepare；不扩公开状态或通用锁。用户体验与架构均达标；仅当全部生产入口已有同等跨重启 claim-before-effect 时删除。**最终结论：改写并保留。** | planned candidate 的竞争检查与首次耐久副作用没有共享跨 transfer 的耐久线性化点；source 缺 claim phase，target 又把 phase journal 按 transfer 物理分片，无法由现有私有事务实现全局单飞。 | **生产端：**四个认证 planned 管理入口、source owner/journal、target ready/receiver、transfer issuer key 与 private staging。**组合：**同/异 transfer 并发，source/target 空投影，same-payload exact/异载荷冲突，target claim/key 后 source prepared 前崩溃，取消、响应丢失、commit/abort 与连续重启。**消费者：**source phase driver、target key/private owner、terminal cleanup及 U34-04 install completion。**异常终态：**同一 home 两个非终态迁居、两个未激活 issuer key，或 claimless key/staging 无法唯一续驱。**直接证据：**同一真实 source log与单一 target claim log的并发、claim-before-effect S7 变异。**受影响审查项：**IR34-04、IR34-06、IR34-27、IR34-33、IR34-34。 | source `FilePlannedAnchorTransferJournal` 增加内部 `candidate-claimed` phase与 `claimCandidate(identity)`：在同一 `AuthorityCommitLog.transactProjection` 内固定“同 transfer exact replay→异载荷冲突→全 home 非终态检查→append claim”，identity 冻结 `{homeId,requestId,transferId,sourceDeviceId,targetDeviceId,trustEpoch,trustChainHead,anchorEpoch}`，`recoverBeforeAdmission` 从 claim 继续 ready/prepare。target 在稳定 `stagingRoot/candidate-claims` 建一个复用 `FileAuthorityCommitLog` 且注入现有同一 `storageMaintenance` 的窄 claim journal（per-transfer phase journal/private store不变），以 `{homeId,transferId,sourceDeviceId,targetDeviceId,trustEpoch,trustChainHead}` 同样原子 claim；claim 成功前禁止 `#context`、key、reservation或 staging I/O，同 claim replay才幂等创建/读取 exact key。private commit/abort 先耐久，再在 target claim journal 标 terminal并异步清理；claim-only cancel先在source写同identity terminal，再以现有认证 planned service投递窄签名 `candidate-release`，target只可终结全等 claim并清该transfer key/root，丢响应继续exact replay。四个入口中只有 prepare 可新建 claim，targets纯读，continue/commit/cancel/terminal replay只消费原 identity。**完成：**异 transfer 并发恰一双端 claim/key/prepared，败者零耐久副作用；同 transfer、取消、丢响应、commit/abort和连续重启唯一续驱/清理，不存在claimless或永久孤儿key/staging，也不新增通用registry。 | 已验证 |

### U34-03、U34-04、U34-09 专项修复实施记录

| 阶段 | 正式状态与当前证据 |
| ---- | ------------------ |
| U34-09 durable candidate 单飞 | **已验证。**source/target durable claim、claim-before-effect、签名 `candidate-release`、terminal/recovery 已落地；真实 source log 与 target-wide claim journal 并发、claim-only 丢响应取消及既有 planned 直接闭包在当前输入合计 16/16 通过；S7 已反绑双端 claim 顺序、release 与 target-wide journal。F34-11/F34-12 与 C34-C16/C17/C22/C24/C25/C27 在冻结指纹上复核通过。 |
| U34-04 pre-bootstrap/post-install completion | **已验证。**同一 installation helper 已由 live commit 与 role composition 前 bootstrap 共用，exact key/private journal 先补齐；三组 consumer、六种 pending、公开 gate 与 cleanup 顺序已落地。install 后 active-key 故障重启、六类非空 closure、missed issuer 与分组直接证据 4/4 通过。F34-13/F34-14 与 C34-C18/C19/C22/C23/C26 在冻结指纹上复核通过。 |
| U34-03 current-owner relay exact-set | **已验证。**canonical registry-minus-`auth/health/server.shutdown` 单源驱动 mesh/client/target/router；anchor+executor 直接 current-anchor，executor-only ownership composite 保证 local `handled:false` 不串路，`session.resolve` 进入同一 local owner gate。两份直接测试 12/12 通过。F34-15/F34-16 与 C34-C20/C21/C23/C24 在冻结指纹上复核通过。 |

### U34-01～U34-08 固定事实矩阵

> F34-01～F34-10 保留八项既有直接边界；F34-11～F34-16 固定本轮三项同根重开的新增实施与验收边界。执行者不得用 happy path、返回值或 mock 自述代替对应耐久事实。

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
| V34-05 | U34-07：两根 owner/target/driver/lifecycle/current-owner exact-set 与 registry golden | `pnpm s7:lint` | `scripts/s7-entry-coverage.mjs`、变异测试、canonical registry golden | 派生资产/合同预检；50.9s | 18/18 与 registry golden 通过 | 当前冻结指纹 | 有效 |
| V34-06 | 受影响 CLI 类型闭包无新增类型错误 | `pnpm --filter @zhixing/cli exec tsc --noEmit` | Unit34 CLI/core/server 消费闭包及仓库既有 CLI 源码 | 修复诊断 | 仅余 8 个与 Unit34 无关、修复前已存在的 `ZhixingCredentials` 错误；首次发现的 `Dirent` 新错误已修复 | 当前冻结指纹 | 诊断 |
| V34-07 | 当前源码与跨包导出可构建 | `pnpm build` | 当前全部源码、包导出与构建配置 | 常驻必要构建；197.9s | 通过，exit 0 | 当前冻结指纹 | 有效 |
| V34-08 | F34-01～F34-10、C34-C01～C34-C15 在同一输入上完成专项事实链与四路冷启动对抗 | 冻结指纹复算 + 四个相互隔离的只读角色复核 | 28 个非工作台路径及正式矩阵/反证账 | 修复专项收口 | 四路均无新增反证；指纹 `6e7b3fadd1358c6b3af463814682f79c111d30fb1c01415f0da968f5cbd1f6d3` | 当前冻结指纹 | 有效 |
| V34-09 | U34-09 双端 candidate claim、release 与连续恢复 | planned transfer 真实 source/target 定向集 | source authority log、target-wide claim journal、key/private staging 与 signed release | 修复直接验证 | 当前输入合计 16/16 通过；异 transfer 并发与 claim-only 丢响应均覆盖 | `52519474…d8a6d1b2` | 有效 |
| V34-10 | U34-04 pre-bootstrap 与 post-install consumer closure | install/key/consumer 定向单例 + 六类 pending 分组测试 | target installation/private journal、trusted verifier、scheduler/conversation/delivery consumer | 修复直接验证 | 安装恢复相关 3/3；六类 pending 分组 1/1 通过 | `52519474…d8a6d1b2` | 有效 |
| V34-11 | U34-03 canonical exact-set、双根 ownership 与 surface gate | first-party mesh + local RPC 定向测试；`pnpm s7:lint` | server canonical registry、mesh/client/target、两生产根 composite 与现有 S7 | 修复直接验证 / 派生资产预检 | 两份直接测试 12/12；S7 18/18 与 registry golden 通过 | `52519474…d8a6d1b2` | 有效 |
| V34-12 | 当前三项跨包源码与导出可消费 | `pnpm build`；CLI `tsc --noEmit` 诊断 | 当前 workspace source、包导出与三项消费闭包 | 常驻必要构建 172.5s / 类型诊断 | workspace build exit 0；类型检查新增错误 0，仅余修复前既有且无关的 8 个 `ZhixingCredentials` 错误 | `52519474…d8a6d1b2` | 有效 |
| V34-13 | F34-11～F34-16、C34-C16～C34-C27 修复后专项事实链与四路冷启动对抗 | 冻结指纹复算 + 四个相互隔离的只读角色复核 | 22 个非工作台路径及正式矩阵/反证账 | 修复专项收口 | 六格、四路、十二条反证均通过；无新增同根残留 | `52519474…d8a6d1b2` | 有效 |

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
