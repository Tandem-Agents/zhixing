# 单元登记:第 35 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:35
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-10
- **登记来源**:用户要求将第 35 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U35-01～U35-06 专项修复、最小必要验证、修复后功能矩阵与四路冷启动对抗均已完成，六项已验证；尚未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否（本轮仅冻结 63 个非工作台功能交付路径用于问题专项复核，不代表全单元冻结）
- **交付物文件集**:以第 34 单元封版代码提交 `972f363e` 为基线，当前 Unit 35 功能交付为 63 个非工作台路径：core 8、mesh 11、CLI 38、providers 1、server golden 1、S7 2、架构 2；工作台文件与同期 Unit 34 历史归档不参与功能指纹
- **当前交付物指纹**:`30056a12eeeedfb4d22f5dca6757199e2755f78dad0fdafb245a1038e799c5c0`（问题专项冻结；排序后的 `path<TAB>file-sha256` 清单以 LF 连接并保留末尾 LF 后再取 SHA-256）
- **架构来源**:`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`，以及已定稿开发清单 D35-01～D35-09

## 固定边界

- **功能范围**:仅支持值班设备永久丢失后，由另一台 active anchor-role 设备基于用户明确选择的完整 checkpoint 副本和无回显恢复包执行 source-less 恢复；交付恢复候选与现场验证、no-rollback baseline、私有完整导入、root-signed commit/abort、原子 composite authority 安装、旧安全域 fencing、恢复根与凭据生命周期、pending-reenroll/fresh pairing、公开恢复旅程及两生产根 exact-set/必要证据
- **架构不变量**:恢复包、current verified full checkpoint、signed trust/current-authority evidence、本地 `AuthorityCommitLog`/私有 `FileArtifactStore`、target-wide candidate journal、installed generation/current-owner 与 credential exposure authority 是既有唯一事实源；不可回滚 commit 前必须完成真实 readiness 与 authenticated terminal 排序，commit 后旧 issuer/epoch/route/binding 永久拒绝；秘密、环境事实、workspace 原始路径和设备缓存不得进入恢复 authority
- **验收条件**:U35-01～U35-06 均达到“已验证”；P0/P1 清零；no-rollback、真实 readiness、pre-commit cancel/stop、live/startup handoff、credential rotation、distinct co-signer 在两生产根、故障恢复与必要 S7/直接证据上闭合
- **必要上下游**:上游只消费第 33 单元完整可恢复 checkpoint、恢复根激活与 retention 合同，以及第 34 单元 composite authority、installed-generation/current-owner、target-wide candidate、私有 staging、storage governor 和 post-install closure；下游第 36～38 单元能力不进入本单元
- **明确不属于本单元**:自动 failover、quorum/witness、自动升主、持续或全局同步、恢复应用、业务数据恢复向导、多目标/云备份、通用 transfer/registry/lifecycle/事务/outbox/事件总线；第 36 单元托管服务与角色自恢复、第 37 单元停机/移除/卸载、第 38 单元升级发布；单设备原地重置、issuer 与恢复包同时丢失后的绕过；监控、诊断、benchmark 与信息采集

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| `@zhixing/core` 8 路径 | strict identity/ReadyProof、disaster recovery command/result、candidate/phase reducer 与导出闭包 | core protocol 定向测试 10/10；workspace build 消费导出成功 | 通过 |
| `@zhixing/mesh` 11 路径（含 native bridge） | authenticated trust evidence、ReadyProof、control-plane service 与既有 mesh 导出/平台实现 | 真实认证 mesh evidence 3/3、mesh ReadyProof 2/2、workspace build 成功 | 通过 |
| `@zhixing/cli` 38 路径 | DR command/target/candidate/installation、runtime assembly、credential rotation、reset approval 与直接测试 | 各专项定向测试、CLI 类型诊断、两生产根 S7 与 workspace build 均已登记 | 通过 |
| `@zhixing/providers` 1 路径、server golden 1 路径 | credential binding 生产消费与 canonical surface 基线 | rotation 三类 binding 测试 3/3；S7 registry golden 通过 | 通过 |
| 架构与规格 2 路径 | Unit 35 no-rollback/readiness/lifecycle/live handoff/rotation/co-signer 合同同步 | 总纲与规格双向对账，无第 36～38 单元能力 | 通过 |
| S7 runner/test 2 路径 | 既有有限 gate 的 Unit 35 production exact-set 与 mutation 反证 | `pnpm s7:lint` 18/18 且 registry golden 通过 | 通过 |
| package/lockfile/生成 schema | 本轮未改变 package manifest、依赖锁或独立 schema；`dist` 为忽略的构建产物 | 基线差异与 workspace build 核对，无需同步 lockfile/schema | 不适用:无对应交付变化 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| reachable-peer evidence / `RecoveryBaseline` | 本机 signed trust、认证 known-peer inventory 与每个 peer 的 exact signed suffix | candidate verified transaction 冻结 cut/evidence/baseline digest | peer 丢响应、冲突、新成员 suffix、旧 root/issuer/epoch、重启 | evidence mesh service/collector、baseline selector、candidate/import/commit | attempt 内 cut 有限；无持续同步；exact replay 复用同 digest | 通过 |
| production readiness / `ReadyProof` | production snapshot builder、SecretStore、candidate 私有 issuer key 与 durable reservation | install 前在同一 coordinator 内 exact revalidate | proof expiry、各 revision 漂移、响应丢失、重启 | planned/disaster producer、target reserve/commit、runtime admission | snapshot/revision exact-set 有限；reservation 仅至 install 或 authenticated terminal | 通过 |
| pre-commit lifecycle / authenticated terminal | scoped signal、target-wide candidate transaction 与 per-transfer journal | prepared/aborted 在 candidate transaction 先唯一排序，terminal 耐久后 cleanup | no-claim/claim-only/prepared、prepare/abort 竞争、容量/网络等待、stop | command、inventory/target/governor、startup/replay | fixed range buffer；网络零 permit；terminal/cleanup 不受 forward gate 阻断 | 通过 |
| disaster installation / current generation receipt | target `AuthorityCommitLog` 中 installation 与 `disaster-post-install-completed` receipt | 三组 consumer、六类 pending read-back 全等后同 log 写 receipt | trust watcher 首个 await、participant/consumer 切点、响应丢失、连续重启 | DR target/CLI、bootstrap、两 current-anchor profile、current-owner surface | 固定 participant/pending exact-set；receipt exact replay；失败 gate 保持关闭 | 通过 |
| credential rotation publication | credential exposure authority transaction 与同一 SecretStore 回读 | service-verified active 新 binding 与旧 compromised→rotated 单 envelope 发布 | provider/channel/MCP 验真、readiness、publish 效果/响应丢失 | editor/save、startup adapters、route guard | 当前 binding exact-set；requestId/revision 幂等；无第三方自动轮换 | 通过 |
| distinct active reset approval | current signed trust 与唯一既有本机 device key | 只读验签后生成 distinct-active approval；issuer 在 current generation 唯一消费 | issuer/pending/revoked、旧 chain/epoch、错签名、输出丢失 | approve-reset CLI、SecretStore/trust store、reset aggregator | 零 authority 写与零 key 创建；同代际 approval 可替代，无 durable outbox | 通过 |

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
| U35-01 | **P0/中。**生产 DR baseline selector 只收到目标本机 trust events，没有取得已认证且可达 active peer 的 signed trust/current-authority evidence；本机旧链因此可被当成 current no-rollback baseline。证据为 D35-03 支持“目标本机落后、仍有 active peer 可达”，而当前生产调用图只传本机链。<br>**价值裁决记录：**原结论为 P0/中。对立复核先假设保持现状或把 peer evidence 改为非强制；但 D35-03 明确支持该拓扑，旧 root/issuer/epoch 可被真实接受并不可回滚地接管。不处理会保留安全域回滚，改规则排除在线 peer 会降低既定恢复安全；现有认证 mesh evidence 与 selector 已足以解决，不需新同步框架。当前范围内用户体验达标：不让用户在看似成功中回滚安全域；架构达标：`RecoveryBaseline` 仍是唯一事实。决定保留 P0/中。仅当生产事实证明所有可达 active peer evidence 已在 claim 前进入同一 selector，或权威产品范围明确取消该拓扑时重开裁决。 | DR evidence producer 未在 candidate claim 前从认证 known-peer inventory 与本地 trust ancestor 共同冻结 reachability cut，也未把 cut 内本机、全部可达 peer 的可验签 current trust suffix及 checkpoint 汇入同一 `RecoveryBaseline` 选择并耐久绑定 candidate；只按可能落后的本地 active-member 集合发现 peer 仍会漏证，selector 本身不是根因。 | **生产端：**DR inventory/claim、认证 mesh trust reconciliation、baseline selector。**类型组合：**本机 current/落后链；cut 内 peer 同代/前进/冲突/请求或响应丢失；旧 root/issuer/epoch；exact replay与连续重启。**消费者：**candidate verified identity、private import、root-signed commit、installed generation。**零副作用边界：**cut 证据缺失、冲突、不可验签或不可比较时不得 claim/key/import。**异常终态：**旧安全域被不可回滚接管。**直接证据：**真实 local/peer `FileMeshBootstrapStore` 与认证 mesh 请求，stale-local/newer-peer、冲突/丢响应/重启场景和 S7 producer exact-set。**受影响审查项：**IR35-07、IR35-29、IR35-32、IR35-34、IR35-36。 | 在首个 candidate claim 前，复用认证 mesh 的现有 known-peer inventory冻结一次 reachability cut；本地trust只提供已知祖先，peer须返回签名`HomeTrustRecord`与从该祖先通向其head的exact event prefix/suffix，新增member也必须由该可验签suffix证明，不能因本地成员投影落后而漏掉。用现有trust reconciliation校验home、认证设备、成员状态、签名、祖先与current issuer；任一已纳入cut的peer丢响应、歧义、冲突或不可验证均fail-closed，cut后新连接属于下一attempt。把本机/peer/checkpoint证据交给现有selector，并在candidate verified transaction冻结cut/evidence digest与唯一baseline，响应丢失和重启只能复用。**完成：**可达更新peer存在时绝不接受更旧baseline；无peer边界仍可恢复；claim前失败零key/import，exact replay全等；直接场景与S7通过且不引入持续同步。 | 已验证 |
| U35-02 | **P0/中。**`recoveryReadiness()` 以空 capability 集合和仅由 enabledRoles 派生的合成 digest 填充 ReadyProof，未读取目标真实角色、配置、协议、资产、服务、credential revision、SecretStore/issuer-key 代际。<br>**价值裁决记录：**原结论为 P0/中。对立复核排除“DR 只恢复 authority、服务以后再说”，因为 D35-04 把目标当前可承担值班职责列为不可回滚 commit 的必要前置，且 synthetic proof 会对缺配置、缺服务或锁定 secrets 返回成功。保持或删减 readiness 会把恢复完成变成不可服务；复用现有 production snapshot/coordinator 足够，无需新 readiness 框架。用户体验达标：提交成功即实际可用；架构达标：同一 target readiness snapshot 同时约束 reservation 与 commit。决定保留 P0/中。仅当 production snapshot 已真实覆盖全部冻结 revision/secret/key，或 commit 被改成可安全回滚且产品合同同步改变时重开裁决。 | DR 使用独立 synthetic snapshot，且既有 readiness reservation 未覆盖 credential/SecretStore/issuer key 等全部 revision producer；proof 创建与不可回滚 install 因而不受同一真实快照和串行化边界约束。 | **生产端：**DR context、production snapshot builder、readiness coordinator、配置/协议/资产/服务/credential/SecretStore/issuer-key mutator、commit guard。**类型组合：**真实角色与配置；协议/资产/服务/credential revision；SecretStore 锁定/回读失败；issuer key 缺失/换代；proof expiry、任一 revision 漂移、响应丢失和连续重启。**消费者：**prepare、candidate ReadyProof、commit、live/startup owner admission。**零副作用边界：**任一真实事实缺失或 reservation 不成立时零公开 import/install；仅允许candidate私有issuer key存在并由authenticated terminal清理。**异常终态：**唯一新 owner 已提交却不可服务。**直接证据：**两生产根真实 snapshot/SecretStore/key、逐 revision 竞争、expiry/丢响应/重启和 S7 synthetic-producer 变异。**受影响审查项：**IR35-13、IR35-29、IR35-32、IR35-34、IR35-36。 | 复用planned与disaster唯一production readiness snapshot builder。candidate claim后先幂等加载或创建其私有transfer issuer key；ReadyProof identity全等绑定home/request/transfer、selected baseline/evidence digest与该exact key id/public key，再把current roles/config digest、protocol、assets、services、credential binding revision/generation、SecretStore unlock/read-back纳入同一snapshot/ReadyProof digest，禁止synthetic fallback。全部有限revision producer必须走现有coordinator串行化；reservation从proof创建保持到authority install或authenticated terminal release，commit在install前exact revalidate同一durable proof，expiry/漂移只abort并由U35-03清理私有key。**完成：**缺配置/服务/secret/key与任一revision漂移均零公开authority副作用；proof丢响应/重启按同一snapshot/key重放，install后admission全等；直接场景和S7通过。 | 已验证 |
| U35-03 | **P1/中。**target-wide claim 的 authenticated terminal 与公开命令的 pre-commit cancel/stop 不在同一 lifecycle：claim 已耐久而 per-transfer `anchor-prepared` 未追加时，当前 abort reducer 无合法入边；命令也未把同一 AbortSignal 传给 inventory/import/commit或触发 root-signed abort。<br>**价值裁决记录：**原 P35-03 与 P35-06 分别登记为 P1/中。对立复核确认稳定 request/transfer identity使硬退出后可以重跑同一候选，因此没有数据损坏或 P0 依据；但用户无法耐久放弃当前候选并选择另一副本，claim-only abort也会永久 stable-busy。两者是同一 pre-commit lifecycle 的生产端与消费端，分开修复任一侧都不能闭合取消/stop，故 P35-06 同根并入本项。保持现状、把取消改成“杀进程”或人工删 staging都会破坏既定可恢复终态；复用现有 signal、root-signed abort与 candidate transaction即可。用户体验达标：取消可确认且可重试；架构达标：唯一 authenticated terminal先耐久后清理。新决定为改写并保留 P1/中。仅当命令已能用同一 signal在所有 pre-commit切点驱动同一 signed terminal，且 claim-only连续重启收敛时关闭；若发现独立于该 lifecycle 的资源旁路再另行重开。 | 公开命令、governor、target-wide candidate 与 per-transfer reducer没有共享一个 scoped pre-commit lifecycle；尤其 claim-only 没有可先耐久的 authenticated abort terminal。 | **生产端：**`runDisasterRecoveryCommand`、inventory/read/prepare/import/commit、storage governor、target-wide candidate transaction与 per-transfer reducer。**类型组合：**各 pre-commit 切点；无 claim/claim-only/prepared；取消/SIGINT/SIGTERM/stop；容量等待、网络挂起、prepare/abort竞争、效果或响应丢失、连续重启。**消费者：**target cleanup、后续 candidate admission、CLI终态。**零副作用边界：**abort identity/signature未全等前零 journal/key/staging；commit 后不得回退。**异常终态：**永久 stable-busy或 stop 后继续新 I/O。**直接证据：**真实 candidate/per-transfer journal、governor和transport的逐切点故障场景及 S7 signal/terminal exact-set。**受影响审查项：**IR35-15、IR35-22、IR35-30～IR35-34、IR35-36。 | 命令建立唯一scoped `AbortController`，把signal贯穿inventory/read/prepare/import/commit、固定块source/sink与governor；stop先拒新forward step、取消等待并等当前固定块安全点，网络等待不持permit，authenticated terminal/cleanup不受forward gate阻断。durable claim前取消直接返回且零target副作用；claim后以原prepare identity生成root-signed abort。target先全等校验command/abort签名及request/transfer/source/target/epoch/candidate identity，并沿用第34单元target-wide candidate的prepared/aborted唯一排序：abort先赢则在candidate transaction耐久完整signed terminal后cleanup；prepared decision先赢而per-transfer phase尚缺时先从原payload补phase再走既有reducer，已有phase同理，committed只前滚。startup/replay同时扫描两类journal，exact replay返回原signed abort。**完成：**每个pre-commit切点只保留零效果cancel、可续做同一transfer或恰一authenticated aborted；错误identity零副作用，stop后零新forward I/O且下一candidate可进入；竞争/丢响应/重启场景与S7通过。 | 已验证 |
| U35-04 | **P0/大。**DR commit 只由 standalone CLI 构造 target并直接回执；已运行的 `MeshRuntimeAssembly` 没有消费新 disaster installation 的 live handoff，只有冷启动会执行 installed-generation、participant、consumer 与 pending closure。<br>**价值裁决记录：**原结论为 P0/大。对立复核确认冷启动确实能闭合，人工重启也可能恢复，因此问题不是永久数据丢失；但 active anchor-role target 正在运行是本单元正常拓扑，CLI 在 runtime 尚未接管时回执“恢复完成”，会让整条 source-less 核心旅程在唯一 source 已丢失后仍不可用。把规则改为必须停服/重启既弱化 always-online 体验，也绕过 D35-06 明定的 live/startup 共用闭包；现有 installation loader、generation coordinator、consumer receipt和trust watcher可复用，但跨进程检测、gate、完成回执及两 profile故障恢复仍是成组改动，不能据此缩为小修。用户体验达标：完成回执等于当前进程已可服务；架构达标：durable installation仍是唯一代际事实。决定保留 P0/大。仅当生产入口强制且公开地把恢复定义为停服冷启动流程，或 running assembly 已在回执前完成同一 descriptor时重开裁决。 | standalone DR commit与运行中authority runtime没有共享同一个installation consumption completion：trust watcher可看到新trust，但未在发布后第一个await前关闭gate并把disaster installation交给startup同款generation/consumer闭包，也没有CLI可等待的durable completion receipt。 | **生产端：**DR CLI/target commit、disaster installation、trust watcher、anchor+executor与anchor-only两个current-anchor profile的`MeshRuntimeAssembly`。**类型组合：**live/startup；install前后；watcher回调首个await、generation participant/三组consumer/六类pending/read-back/cleanup各切点；响应丢失与连续重启。**消费者：**runtime epoch/projection/cursor/router，scheduler/intent/assignment，conversation/interaction/confirmation/final，delivery与六类AuthorityCatalog pending。**零副作用边界：**新trust可见即gate关闭，receipt前不得cleanup/open/成功回执。**异常终态：**耐久owner已换代而内存仍旧代际或CLI过早报完成。**直接证据：**两profile真实installation/log/catalog，live commit逐切点、非空pending、丢响应/重启与S7 live/cold exact-set。**受影响审查项：**IR35-17～IR35-18、IR35-30～IR35-34、IR35-36。 | 复用现有trust watcher、current-owner gate、disaster installation loader、installed-generation coordinator和consumer receipt：watcher发现更新trust时须在回调第一个异步等待前同步置transition-pending，使全部公开/current-owner入口立即拒绝；随后加载exact current disaster installation，并与cold startup调用同一completion。completion依次完成generation rebind、三组recover/start、六类pending归属与逐项read-back；在target同一`AuthorityCommitLog`的installation progress中耐久写绑定installation digest/generation及全部participant/read-back的`disaster-post-install-completed` receipt后，才cleanup、release gate、open surface和允许CLI报完成。失败保留installation、closed gate与缺失receipt供live/startup重驱。**完成：**两profile任一切点、响应丢失和连续重启下仅当前代际可服务，CLI成功与durable receipt全等；不新增通用IPC/lifecycle。 | 已验证 |
| U35-05 | **P1/中。**`CredentialExposureAuthority.publishRotation()` 没有任何生产调用；正常 editor/startup 只发布 active bindings，而 compromised binding 会被 read guard阻断且 `publishActiveBindings()` 明确跳过。<br>**价值裁决记录：**原结论为 P1/中，并笼统把 editor、service verification与publication串联。对立复核确认保持 degraded只保护了未轮换旧凭据，却使用户完成外部撤销和本地换密钥后仍永久不可路由；这违反 D35-08 明确的当前交付，但不阻断与该 binding 无关的核心能力，故不能升 P0。进一步核对发现通用 startup loader会在 publication前被 compromised guard阻断，而现有 `CredentialBindingDescriptor` 已携 service-verified fingerprint/revision；最优方案应是窄 rotation分支复用该验证产物，而不是新增 provider/channel/MCP 验证框架或放宽普通 guard。用户体验达标：按提示换密钥后该 binding可恢复；架构达标：active+rotated仍在一个 authority transaction。新决定为改写并保留 P1/中。仅当生产已有等价 caller，或产品正式取消恢复后 binding复用并同步删除该交付义务时重开裁决。 | credential editor/save只完成SecretStore写入与host reload，没有把`rotationRequired`、新credential的service-verified principal/readiness和现有`publishRotation()`组成一个窄原子恢复分支；普通active publication又被compromised guard正确阻断。 | **生产端：**config editor/save、SecretStore writer/read-back、当前provider/channel/MCP有限验证入口、credential readiness descriptor、`CredentialExposureAuthority`。**类型组合：**各当前binding kind；同/异principal；revision递增/重复；验证、回读、readiness、authority publish效果前后失败；响应丢失与exact replay。**消费者：**credential route guard、executor readiness、provider/channel/MCP启动。**零副作用边界：**SecretStore回读或service-verified principal/readiness未成立时不得把旧compromised改为rotated。**异常终态：**用户已完成外部撤销与本地换密钥但binding永久不可路由，或未经服务验真错误解封。**直接证据：**真实SecretStore、当前有限binding验证、authority transaction和跨binding隔离场景；S7冻结唯一生产caller与kind exact-set。**受影响审查项：**IR35-21、IR35-30、IR35-32～IR35-34、IR35-36。 | 在现有editor/save完成路径增加唯一`rotationRequired`窄分支：保存前后diff按binding identity定位当前compromised项并冻结稳定requestId/next revision；写入新secret后必须从同一SecretStore回读，再由当前provider/channel/MCP有限生产适配逐kind取得服务认证的canonical principal与readiness descriptor，`user-alias`、歧义或不支持均不得解封。验证成功后调用现有`publishRotation()`，让active新binding与旧compromised→rotated在同一authority transaction发布；响应丢失按requestId/revision exact replay，其他binding不变。**完成：**回读/服务验证/readiness任一失败时旧项仍compromised且新route关闭，成功时单事务恢复且普通publication guard不放宽；三类binding直接场景与S7通过，不新增通用验证框架或自动第三方轮换。 | 已验证 |
| U35-06 | **P1/小。**`runRecoveryRootApproveResetCommand()` 复用 issuer-oriented `openContext(false, false)`；该上下文仍要求本机 anchor role并取得 current issuer 私钥。<br>**价值裁决记录：**原结论为 P1/小。对立复核排除删除 reset 旅程：current issuer仍在、恢复包永久丢失且另一 active device可共同授权是 D35-07 明确支持的安全恢复场景，当前入口在合法最小权限设备上必然失败。放宽为 issuer自签会破坏双人授权，要求 co-signer复制 issuer key会扩大秘密面；只拆出读取 signed trust与本机 device key的窄 context即可。用户体验达标：合法第二设备能完成确认；架构达标：issuer与co-signer权限严格分离。决定保留 P1/小。仅当生产 approval入口已不加载issuer key/anchor配置且只接受distinct active member，或该旅程被权威范围明确取消时重开裁决。 | reset approval入口误复用issuer/anchor的可写上下文并调用可创建key的装载路径，没有独立的只读distinct-active-member approval context。 | **生产端：**`runRecoveryRootApproveResetCommand`、SecretStore device-key reader、signed trust replay、`createDomainResetApproval`。**类型组合：**distinct active executor/surface、current issuer、pending/revoked member；旧chain/epoch、错签名、重复生成与输出丢失。**消费者：**current issuer reset聚合与trust event发布。**零副作用边界：**本地既有device key、current signed trust和distinct active身份任一不成立时零key创建/authority写入。**异常终态：**合法第二设备无法共同授权，或co-signer被迫取得issuer秘密。**直接证据：**真实SecretStore/trust store、各member状态/代际/签名与S7最小权限装配。**受影响审查项：**IR35-27、IR35-29、IR35-32～IR35-34、IR35-36。 | 为approve-reset拆出窄只读context：要求SecretStore已解锁，枚举并加载唯一既有本机device key（只用`loadDeviceKey`，禁止create）；只读加载、验签和replay current signed trust/HomeTrustRecord，要求本机member为active且不同于current issuer。该路径不检查anchor role/config，不加载/创建issuer key，不绑定target/capacity且不写authority；原current-issuer reset路径继续使用严格上下文。**完成：**distinct active设备可签，issuer/pending/revoked/旧代际/错签名稳定拒绝；重复生成可产生同代际等价approval但始终零authority写入/key创建，issuer只接受一次current-generation reset，旧码随换代失效；直接测试与S7通过。 | 已验证 |

## 问题收敛记录

> 本节固定 U35-01～U35-06 的事实矩阵、反证处置与执行边界；问题行中的根因、完整影响面和最优方案是本轮最新合同。修复后矩阵与对抗记录绑定同一问题专项冻结指纹，六项状态均为“已验证”。

### 固定矩阵

| 编号 | 问题与直接变体 | 稳定身份与唯一耐久事实 | 线性化点与零副作用边界 | 消费终态与直接证据 |
| ---- | -------------- | ---------------------- | -------------------------- | ------------------ |
| F35-01 | U35-01：local current/落后；known-peer cut内peer同代/前进/新增member；无peer | inventory/cut digest、peer/home/head、candidate baseline digest | candidate claim前按认证inventory冻结cut并由selector唯一选择；缺证据前零claim/key/import | baseline写入candidate verified事实；真实local/peer store与认证mesh |
| F35-02 | U35-01：peer冲突、旧root/issuer/epoch、请求/响应丢失、重启 | 每个cut成员的signed record与exact trust suffix | 任一cut成员缺失/冲突fail-closed；exact replay只复用原baseline | 旧域零commit；冲突/丢响应/连续重启场景与S7 |
| F35-03 | U35-02：真实role/config/protocol/assets/services/credential/secret/key | home/request/transfer/baseline、candidate-private issuer key、snapshot/proof digest | claim后先固定私有key再创建并reserve全等proof；任一缺项前零公开import/install | prepare与commit读取同一candidate/baseline/snapshot/key |
| F35-04 | U35-02：各revision漂移、proof expiry、回读失败、响应丢失、重启 | durable ReadyProof与reservation identity | 所有revision producer串行；install前exact revalidate | 漂移只abort，install后admission全等；竞争/恢复场景 |
| F35-05 | U35-03：inventory/read/prepare/import/commit各pre-commit切点，no-claim/claim-only/prepared | command/abort、candidate prepared-or-aborted decision、phase identity | no-claim零效果；candidate先排序，phase再物化/终结 | 可续做或恰一aborted；真实journal与逐切点场景 |
| F35-06 | U35-03：cancel/stop、容量等待、网络挂起、prepare/abort竞争、重启 | scoped signal、part sequence、governor permit | stop拒新forward但放行terminal/cleanup；网络零permit；错误identity零append | stop后零新forward I/O，terminal可收敛且下一candidate可进 |
| F35-07 | U35-04：两current-anchor profile，live/startup与所有completion切点 | disaster installation、installed generation、authority-log completion receipt | 新trust可见前同步关gate；同log receipt前不得open/cleanup/回执 | live/startup共用completion；真实runtime/log/catalog |
| F35-08 | U35-04：三组consumer、六类pending空/单/多、效果/响应丢失、连续重启 | generation participant receipt、pending owner/read-back | 全participant同generation且逐项read-back后写receipt | 仅当前代际服务；两profile逐切点场景与S7 exact-set |
| F35-09 | U35-05：provider/channel/MCP、同/异principal与revision | binding identity、requestId、service-verified principal/readiness | SecretStore回读和service verification后才publishRotation | active+rotated同一authority transaction；真实三类binding |
| F35-10 | U35-05：验证/回读/readiness/publish效果前后失败与exact replay | secret ref、next revision、exposure transaction identity | 任一前置失败零authority解封；旧compromised保持 | 同request/revision全等重放，其他binding隔离 |
| F35-11 | U35-06：distinct active、issuer、pending、revoked | local deviceId/keyId、current trust head/epoch | 只读验签后签approval；拒绝前零key创建/authority写入 | 仅distinct active可签；真实SecretStore/trust store |
| F35-12 | U35-06：旧chain/epoch、错签名、重复生成与输出丢失 | approval绑定home/seq/head/epoch与device signature | 生成零authority写；issuer按current generation唯一消费 | 同代际approval可替代，换代后旧码拒绝；无需durable approval outbox |

### 同根反证账

| 编号 | 主动反例 | 处置 |
| ---- | -------- | ---- |
| C35-C01 | 本机落后但认证active peer已前进，local-only selector仍成功 | 同根并入U35-01；F35-01/F35-02要求cut evidence与baseline同一candidate冻结 |
| C35-C02 | 已进入reachability cut的peer丢响应后被静默剔除 | 同根并入U35-01；该attempt fail-closed，下一attempt才可重建cut |
| C35-C03 | 缺服务、锁定SecretStore或缺issuer key仍由synthetic proof通过 | 同根并入U35-02；F35-03拒绝synthetic fallback |
| C35-C04 | revalidate后credential/key revision在install前漂移 | 同根并入U35-02；F35-04要求全部producer受同一reservation串行 |
| C35-C05 | claim-only先走per-transfer abort而reducer无入边 | 同根并入U35-03；candidate transaction先耐久signed terminal |
| C35-C06 | stop只结束CLI，网络/容量等待或claim仍继续 | 同根并入U35-03；同一signal、fixed-part安全点和terminal恢复闭合 |
| C35-C07 | trust watcher先发布新trust，异步completion前旧runtime仍准入 | 同根并入U35-04；回调第一个await前同步关闭current-owner gate |
| C35-C08 | CLI在install后立即报成功，但三组consumer/六类pending尚未接管 | 同根并入U35-04；以durable completion receipt作为唯一成功边界 |
| C35-C09 | 新secret只产生user-alias principal却解除compromised | 同根并入U35-05；只接受有限生产适配返回的service-verified identity |
| C35-C10 | service验证成功但SecretStore回读或readiness失败 | 同根并入U35-05；publishRotation前置不成立，旧项保持compromised |
| C35-C11 | co-signer approval路径仍加载current issuer key/anchor配置 | 同根并入U35-06；只读approval context与issuer context权限分离 |
| C35-C12 | approval路径用load-or-create生成未在trust中的新device key | 同根并入U35-06；只允许加载既有本机device key，缺失即拒绝 |
| C35-C13 | 本地trust成员投影落后，按其active集合发现peer会漏掉认证known peer的新成员事实 | 同根并入U35-01；以认证known-peer inventory冻结cut，成员资格由可验签suffix证明 |
| C35-C14 | readiness snapshot先生成、candidate issuer key随后创建，proof无法绑定实际commit key | 同根并入U35-02；claim后先固定私有key，再以该key生成并reserve真实snapshot |
| C35-C15 | stop gate同时禁止terminal/cleanup，取消后反而无法写入signed abort | 同根并入U35-03；gate只拒新forward step，认证终态与幂等清理必须继续前滚 |
| C35-C16 | 为approve-reset输出丢失强制建设byte-exact replay与耐久approval队列 | 当前合同证伪：approval生成零authority副作用，同代际码可替代且issuer换代时唯一消费；新增状态无当前价值 |
| C35-C17 | readiness proof只绑定target revisions却未绑定selected no-rollback baseline/candidate | 同根并入U35-02；proof全等反绑home/request/transfer、evidence/baseline digest与exact issuer key |
| C35-C18 | strict peer evidence decoder把合法 genesis `seq=0` 当成非法序号，导致无根链证据被误拒 | 同根并入U35-01；序号边界改为仅拒绝负数，真实认证 mesh 的 genesis/suffix 场景复核通过 |
| C35-C19 | 多 binding credential rotation 仅从当前投影推导 next revision，遗漏旧 compromised binding 的既有 revision | 同根并入U35-05；revision 同时取 current records、new binding 与 old binding 的最大值后递增，三 binding 隔离场景复核通过 |
| C35-C20 | scoped signal 已贯穿 candidate/target，却未传入 inventory target 打开与 paired peer 等待 | 同根并入U35-03；`openInventoryTargets`/`waitForPeer` 统一接收 signal，等待可取消且 S7 mutation 反绑全部入口 |
| C35-C21 | authority 已安装且 completion receipt 已写，但 CLI 响应丢失后的重跑先命中“本机已是 issuer”拒绝，无法返回原终态 | 同根并入U35-04；命令先识别 current disaster installation 并等待 exact receipt 后直接重放成功，零 inventory/peer/package/private 副作用 |

### 四路冷启动对抗复审

- **冻结输入：**问题行 U35-01～U35-06、F35-01～F35-12 与 C35-C01～C35-C17；规范化 SHA-256 为 `c469866fd9770605ad9bc4cc36af984bc39af0d672115ab690a64467e5114e71`。以下四路均从权威合同与生产调用图重新推导，未复用前轮结论；复审期间问题行、固定矩阵与反证账未修改。

| 对抗视角 | 主动重造的核心反例与交界 | 结论 |
| -------- | ------------------------ | ---- |
| no-rollback evidence 与真实 readiness | 重造 stale local/newer known peer、peer suffix新增member、cut内丢响应/冲突、真实服务/SecretStore/key缺失、各revision漂移；核查 U35-01↔U35-02、U35-02↔U35-04 | 通过。known-peer cut、candidate baseline、ReadyProof与exact issuer key形成单一身份链；C35-C01～C04、C13～C14、C17均已有直接处置，无新独立根因。 |
| pre-commit lifecycle、authenticated terminal 与资源 stop | 重造 no-claim/claim-only/prepared、prepare/abort竞争、容量等待、网络挂起、stop阻断cleanup、commit赢竞态及连续重启；核查 U35-03↔U35-04 | 通过。第34单元candidate prepared/aborted排序点被直接复用，forward gate与terminal/cleanup边界明确；C35-C05～C06、C15闭合，无新独立根因。 |
| live/startup installed-generation 消费闭包与 credential publication | 重造 trust watcher首个await窗口、两profile三组consumer/六类pending切点、CLI过早回执，以及provider/channel/MCP回读/服务验真/readiness/authority publish失败；核查 U35-02↔U35-04、U35-04↔U35-05 | 通过。同一AuthorityCommitLog completion receipt闭合live/startup，rotation只走editor/save窄分支与现有publishRotation；C35-C07～C10闭合，无新独立根因。 |
| reset co-signer、生产证据、产品体验与范围价值 | 重造issuer自签、pending/revoked、旧chain/epoch、key缺失/多key、输出丢失及重复生成；核查 U35-01↔U35-06、六项与第33～34及第36～38单元边界 | 通过。只读distinct-active approval context满足最小权限；byte-exact approval outbox被C35-C16证伪。未引入自动failover、持续同步、恢复应用或后继单元能力。 |

- **差异审计：**C35-C01～C35-C15、C35-C17均以“同根合并”进入对应问题的执行合同与验收；C35-C16以“当前合同证伪”关闭。六项评级与工作量保持 U35-01/P0中、U35-02/P0中、U35-03/P1中、U35-04/P0大、U35-05/P1中、U35-06/P1小；没有同根重复项、未处置反证或需用户裁决的架构空洞。

### 修复后专项功能审查与四路冷启动对抗

- **冻结交付物：**以第 34 单元封版提交 `972f363e` 为基线的 63 个非工作台功能路径；规范化指纹 `30056a12eeeedfb4d22f5dca6757199e2755f78dad0fdafb245a1038e799c5c0`。本节全部判断、直接证据与四路对抗均绑定该同一指纹；工作台记录变化不改变功能指纹。

| 固定矩阵 | 修复后事实链与直接证据 | 专项结论 |
| -------- | ---------------------- | -------- |
| F35-01 | 认证 mesh service/collector 冻结 local+known-peer cut，peer 以 `HomeTrustRecord` 与 exact signed suffix 证明同代/前进/新增 member；真实认证 mesh 测试覆盖 stale-local/newer-peer 与 genesis `seq=0` | 通过：唯一 baseline 与 candidate evidence digest 全等，claim 前缺证据零副作用 |
| F35-02 | collector 对 cut 内丢响应、冲突、错 home/root/issuer/epoch fail-closed，candidate 只重放原 cut/baseline；S7 固定生产 service/consumer exact-set | 通过：旧安全域不可因本机落后或 peer 丢失而被接受 |
| F35-03 | planned/disaster 共用 production snapshot，proof 绑定 request/candidate/evidence/baseline、私有 issuer key、roles/config/protocol/assets/services/credential/SecretStore revision | 通过：缺真实服务、secret 或 exact key 时零公开 install |
| F35-04 | target reservation 与 commit 在同一 coordinator 内 exact revalidate；expiry、revision/key 漂移只走 authenticated abort；core 10/10、mesh 2/2 与 planned expiry/hold 定向场景通过 | 通过：proof 创建至不可回滚 install 的响应窗口被同一 durable identity 封闭 |
| F35-05 | command/candidate/target 复用一个 scoped signal；candidate transaction 先排序 prepared/aborted，claim-only 可先耐久 signed terminal，prepared 则补 phase 后走原 reducer | 通过：no-claim、claim-only、prepared、commit-win 均只有零效果/续做/恰一 terminal |
| F35-06 | inventory open、paired wait、fixed range、governor 与 target forward step 全部可取消；网络等待零 permit，terminal/cleanup 不受 forward gate 阻断；target 场景 4/4 与 S7 mutation 通过 | 通过：stop 后零新 forward I/O，连续重启可释放 candidate |
| F35-07 | trust watcher 在首个 await 前同步关闭 gate；live/startup 均加载 exact disaster installation 并调用同一 installed-generation completion；installation 与 assembly 定向场景通过 | 通过：两 current-anchor profile 只在 current generation 完成后服务 |
| F35-08 | 三组 consumer 与六类 pending 逐项 read-back，participant/generation 全等后同 `AuthorityCommitLog` 写 completion receipt；CLI exact terminal replay 等待同 receipt | 通过：效果/响应丢失及连续重启不产生“已提交未接管”终态 |
| F35-09 | editor/startup 生产路径按 provider/channel/MCP 有限 exact-set 回读 SecretStore 并取得 service-verified principal/readiness，再调用既有 `publishRotation()` | 通过：三类 binding 均有唯一生产 caller，非服务身份不可解封 |
| F35-10 | active 新 binding 与旧 compromised→rotated 在同 authority transaction 发布；revision 纳入 old/new/current records，效果后响应丢失按 request/revision exact replay；测试 3/3 | 通过：失败保持旧 compromised，成功只改变目标 binding |
| F35-11 | approve-reset 只读加载唯一既有本机 device key 与 current signed trust，要求 distinct active，明确拒绝 issuer/pending/revoked | 通过：合法 co-signer 可签且零 issuer key、零 anchor 配置、零 authority 写 |
| F35-12 | approval 严格绑定 current home/head/epoch/device signature；旧代际/错签名拒绝，同代际重复生成可替代，issuer 仍唯一消费 | 通过：输出丢失无需新增 durable approval outbox，换代后旧码失效 |

| 对抗角色 | 冷启动重造的反例与交界 | 同指纹结论 |
| -------- | ------------------------ | ------------ |
| no-rollback evidence 与真实 readiness | 从零重造 stale local/newer peer、suffix 新成员、cut 丢响应/冲突、genesis seq、真实服务/secret/key 缺失及 proof expiry/revision 漂移；核查 U35-01↔U35-02、U35-02↔U35-04 | 通过。C35-C01～C04、C13～C14、C17～C18 均被当前源码与直接证据拒绝，无第二 evidence/readiness 事实源 |
| pre-commit lifecycle、authenticated terminal 与资源 stop | 从零重造 inventory/read/prepare/import/commit 取消、claim-only、prepare/abort 竞争、网络挂起、容量等待、stop 与连续重启；核查 U35-03↔U35-04 | 通过。C35-C05～C06、C15、C20 修复后复核通过；forward 与 terminal 边界无残留旁路 |
| live/startup installed-generation 与 credential publication | 从零重造 trust watcher 首 await、两 profile participant/consumer/pending 切点、receipt 响应丢失，以及三类 binding 回读/验真/readiness/publication 失败；核查 U35-02↔U35-04、U35-04↔U35-05 | 通过。C35-C07～C10、C19、C21 修复后复核通过；CLI 成功、runtime 可服务与 durable receipt 全等 |
| reset co-signer、产品体验与范围价值 | 从零重造 issuer 自签、pending/revoked、旧 chain/epoch、错 key/signature、输出丢失，并反查两生产根、S7、上游 Unit 33～34 与下游 Unit 36～38 边界 | 通过。C35-C11～C12 复核通过，C35-C16 继续由当前合同证伪；未引入自动 failover、持续同步、恢复应用或通用基础设施 |

- **修复后差异审计：**C35-C01～C35-C15、C35-C17～C35-C21 均以“修复后复核通过”关闭；C35-C16 以“当前合同证伪”关闭。专项审查未发现新的独立根因、未处置反证或范围漂移；六项评级/工作量和既有价值裁决不变。

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
| V35-01 | U35-01 认证 peer evidence 与 no-rollback baseline | trust-evidence 定向 Vitest（含真实认证 mesh） | evidence service/collector、mesh control plane、local/peer bootstrap store 与 candidate | 修复直接验证 / 低 / 3 场景 | 3/3 通过，含 stale-local/newer-peer、冲突与 genesis suffix | 专项冻结指纹 `30056a12…5c0` | 有效 |
| V35-02 | U35-02 strict ReadyProof、真实 snapshot 与 reservation | core anchor-transfer、mesh readiness、planned expiry/hold 定向 Vitest | core identity/protocol、mesh readiness、CLI setup/planned/disaster target | 修复直接验证 / 中 / 10+2+2 场景 | core 10/10、mesh 2/2、planned 两个定向场景通过 | 同上 | 有效 |
| V35-03 | U35-03 candidate terminal、取消、governor 与 stop | disaster target 定向 Vitest + S7 signal/terminal mutation | DR command/candidate/target、inventory/paired wait、candidate/per-transfer journal、governor | 修复直接验证 / 中 / 4 场景 + gate | target 4/4；全部入口 signal 与 terminal exact-set gate 通过 | 同上 | 有效 |
| V35-04 | U35-04 live/startup installation completion 与 terminal replay | disaster installation、mesh runtime assembly 定向 Vitest + S7 | installation loader/receipt、bootstrap/assembly、三组 consumer、六类 pending、CLI replay | 修复直接验证 / 中 / 2 场景 + gate | installation 1/1、assembly 1/1、live/cold/terminal exact-set gate 通过 | 同上 | 有效 |
| V35-05 | U35-05 provider/channel/MCP rotation publication | credential rotation publication 定向 Vitest | editor/startup production caller、SecretStore、三类 verifier、exposure transaction | 修复直接验证 / 低 / 3 场景 | 3/3 通过，覆盖多 binding revision 与失败隔离 | 同上 | 有效 |
| V35-06 | U35-06 distinct active co-signer 最小权限 | backup approve-reset 定向 Vitest + S7 context gate | backup command、read-only approval context、SecretStore/trust store | 修复直接验证 / 低 / 1 场景 + gate | distinct active 通过，issuer/pending/revoked 与 key-create/authority-write 路径被拒绝 | 同上 | 有效 |
| V35-07 | CLI 类型检查归因 | `pnpm --filter @zhixing/cli exec tsc --noEmit` | 当前 CLI 源码与 workspace 类型依赖 | 修复直接验证 / 低 | 仅复现 8 个基线既有 config-editor/startup projection 类型错误；Unit 35 变更文件零新增错误 | 失败文件均不在 Unit 35 变更闭包 | 诊断 |
| V35-08 | 既有 S7 与 registry 派生资产 | `pnpm s7:lint` | S7 runner/test、canonical registry golden、两生产根 descriptor | 派生资产预检 / 低 | 18/18 且 registry golden 通过 | 专项冻结指纹 `30056a12…5c0` | 有效 |
| V35-09 | 当前源码可构建与跨包导出可消费 | `pnpm build` | 当前 workspace 源码、package graph 与未变 lockfile | 开发/修复必要构建 / 高 / 325 秒 | 17/17 packages 成功；作为同输入唯一 workspace build 证据保留 | 专项冻结指纹 `30056a12…5c0` | 有效 |
| V35-10 | 功能指纹、矩阵、四路对抗与范围边界 | 63 路径规范化 SHA-256 + F35-01～F35-12/C35-C01～C35-C21 只读重建 | 全部非工作台功能路径、权威合同、生产调用图与直接证据 | 专项功能复核 / 中 | 指纹 `30056a12eeeedfb4d22f5dca6757199e2755f78dad0fdafb245a1038e799c5c0`；四路通过，无 Unit 36～38 扩面 | 同值 | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-35.gen-1 -->
