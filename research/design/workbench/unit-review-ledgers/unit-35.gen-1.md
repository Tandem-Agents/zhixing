# 单元登记:第 35 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:35
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-10
- **登记来源**:用户要求将第 35 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U35-07（P0/中）与 U35-08（P2/小）已在同一冻结指纹上完成生产实现、最小必要验证、专项功能审查与四路冷启动对抗，均为已验证；U35-01～U35-06 的既有已验证结论继续复用，未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否（本轮 65 个非工作台功能交付路径已冻结用于 U35-07～U35-08 修复后专项复核，不代表全单元冻结）
- **交付物文件集**:以第 34 单元封版代码提交 `972f363e` 为基线，当前 Unit 35 功能交付为 65 个非工作台路径：core 10、mesh 11、CLI 38、providers 1、server golden 1、S7 2、架构 2；工作台文件与同期 Unit 34 历史归档不参与功能指纹
- **当前交付物指纹**:`a20589ca2d358f80e5f51f47b5d6589a5cb86dc77429ee7c9bf3338039e91c35`（U35-07～U35-08 修复后专项冻结；65 个非工作台功能路径按 `path<TAB>file-sha256` 排序，以 LF 连接并保留末尾 LF 后再取 SHA-256）
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
| candidate/phase lifecycle / authenticated terminal | scoped signal、target-wide candidate transaction、per-transfer journal、verified/imported事实、install-decided 与 authority installation | `recordVerified` 冻结验证事实；`install-decided` 与 signed abort 在同 candidate transaction 互斥；authority exact read-back、active key 与 private committed 后才写 target-wide terminal | verified/imported 各 sync 窗口、proof/key 异常、prepare/abort/commit 竞争、安装效果或响应丢失、后继 generation 与连续重启 | command、candidate/per-transfer replay、private store/SecretStore、authority installer、startup completion 与两生产根 | 固定 range buffer/网络零 permit继续成立；verified/imported/decision exact replay；terminal 前 claim 唯一占有，历史 terminal 零 authority 写；超限候选事实与 pre-import key cleanup 尚未闭合 | 有问题:U35-07、U35-08 |
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
| U35-03 | **P0/中，同根重开。**原 cancel/stop、claim-only signed abort 与资源治理已经验证；本轮 P35-07 证明同一 target-wide candidate/per-transfer lifecycle 仍未覆盖正常 prepare/import 重放和 commit/install 单飞：candidate 当前为 `claimed → verified → terminal`，`prepareAndImport()` 不先消费已有 verified/imported/aborted，而以变化的 onsite `verifiedAt` 重算并与旧 verified bytes 冲突；`commit()` 又在 `installPlannedAnchorPrefix()` 前写 `terminal:"committed"`，同一 candidate transaction 随即把 target-wide claim 标成 terminal，异 transfer 因而可在原 authority 安装前取得单飞权。事实证据：`disaster-recovery-candidate.ts:41-84,147-241`、`disaster-recovery-target.ts:230-352,360-521,607-637`、`disaster-recovery-authority.ts:158-164`、`target-wide-anchor-candidate.ts`、`commit-log.ts:301-390`；现有 target 测试固定 `now`，S7 只约束 abort-before-cleanup。<br>**价值裁决记录（原 U35-03）：**原 P35-03 与 P35-06 分别登记为 P1/中。对立复核确认稳定 request/transfer identity使硬退出后可以重跑同一候选，因此没有数据损坏或 P0 依据；但用户无法耐久放弃当前候选并选择另一副本，claim-only abort也会永久 stable-busy。两者是同一 pre-commit lifecycle 的生产端与消费端，分开修复任一侧都不能闭合取消/stop，故 P35-06 同根并入本项。保持现状、把取消改成“杀进程”或人工删 staging都会破坏既定可恢复终态；复用现有 signal、root-signed abort与 candidate transaction即可。用户体验达标：取消可确认且可重试；架构达标：唯一 authenticated terminal先耐久后清理。新决定为改写并保留 P1/中。仅当命令已能用同一 signal在所有 pre-commit切点驱动同一 signed terminal，且 claim-only连续重启收敛时关闭；若发现独立于该 lifecycle 的资源旁路再另行重开。<br>**价值裁决记录（本轮 P35-07）：**原结论为 P0/中，并要求新增 `prepared` 与 `install-decided` 两个非终态。对立复核确认 P0 事实不变，但推翻了“必须新增 prepared”的方案前提：现有 candidate `verified` 已耐久冻结 baseline、验证结果、catalog/ref 身份；per-transfer imported 已存在时由原日志 exact replay，不存在时尚无已决定的 import/ReadyProof bytes，执行者可从原 verified、同一 transfer key 与当前有效 reservation 继续一次 imported 决定。另建 prepared 会复制事实源并增加无用户价值的状态。新决定为**改写并保留 P0/中，同根重开 U35-03**：先消费现有 verified/imported/aborted，仅新增不可早释 claim 的 `install-decided`。本轮源码反查未触发补字段条件：transfer issuer key 在 verified 前已写入并回读稳定的 transfer 专属 SecretStore 槽位，verified 后若 imported 尚不存在便没有第二份已决定的 ReadyProof/import bytes；槽位缺失或损坏应 fail-closed，不以新增 candidate 字段或第二 prepared 事实修补。 | candidate transaction 只闭合了取消/abort 的局部排序，调用方没有把 candidate verified、per-transfer imported、authority install decision 和 target-wide claim release 组成同一耐久 reducer：prepare 路径重复生产已冻结验证事实，commit 路径则把“已作安装决定”误写成“安装已完成”的 terminal。 | **生产端：**`runDisasterRecoveryCommand`、`prepareAndImport()`/`commit()`/abort、candidate 与 per-transfer journal、private store/SecretStore/ReadyProof、`installPlannedAnchorPrefix()` 与 startup/request replay。**类型组合：**claimed、verified、imported、aborted、install-decided、authority-installed、private-committed、terminal-committed；变化时钟、空/非空 retained、同/异 transfer、proof过期、key缺失/错绑、prepare/abort与commit竞争、效果或响应丢失、连续重启。**消费者：**private phase replay、target-wide candidate admission、authority WAL/current issuer/current owner、CLI终态与两生产根。**零副作用边界：**aborted、错误 identity、verified 后 key 缺失/损坏在新 key/staging/readiness/import 前拒绝；install-decided 前 abort 可赢，决定后只前滚；authority install 与 private committed 均成立前不得释放 claim。**异常终态：**同一备份永久不可重试，或两个认证恢复依次安装不同 source prefix并覆盖刚发布的安全域。**直接证据：**真实 candidate/per-transfer/authority log、变化 clock、空/非空 retained、abort replay、双 candidate、install各切点及S7早释/重算变异。**受影响审查项：**IR35-05、IR35-10、IR35-14～IR35-15、IR35-29～IR35-34、IR35-36。 | 复用现有 candidate、per-transfer journal、私有 store、ReadyProof 与 authority install primitive。`prepareAndImport()` 先按同 identity 联合归约 candidate 与 per-transfer state：aborted 在任何新效果前重放原终态；imported/committed 直接返回原 imported bytes及其私有引用；verified 且未 imported 时只验真原 verified、catalog/retained exact-set、私有 refs 与现有 transfer 专属 key，恢复 U35-02 的 reservation 后创建一次 ReadyProof/import并追加 imported，禁止重做现场验证、重写 verified 或在 verified 后 load-or-create 新 key。candidate transaction 仅新增与 signed abort 互斥的 `install-decided`：在最终 readiness/expiry 复验和 CAS 提升后、authority install 前，耐久冻结完整 canonical installation entries、`DisasterRecoveryInstallation`/commit 与 candidateReferences exact-set；该决定是 commit 胜出的唯一时刻，写入后不再按重放时钟或 current revision 改判，保持 target-wide claim，且同 identity exact replay只复用原决定。随后用该决定幂等安装并回读同一 authority generation，激活 exact key、补 per-transfer committed，最后才在 candidate/target-wide 同一事务写 committed terminal并释放 claim。authority 尚未安装时由同一 commit 请求重放 install-decided；authority 已可见后由现有 installation loader 在 live/startup 补 private committed 与 terminal，无需新增启动索引。decision先赢则abort拒绝并只前滚，abort先赢则不得产生decision；无匹配 decision/authority/private committed 的 committed terminal fail-closed，历史 terminal replay只返回冻结结果、不得重装旧 authority。扩展现有 S7 拒绝 verified 重算、第二 prepared、早释 claim和不完整 install decision；真实日志场景覆盖变化 clock、空/非空 retained、verified→imported、decision→install→private committed→terminal、abort/commit竞争、双 candidate、proof/key异常、响应丢失和连续重启。**完成：**同一 verified/imported/decision bytes exact replay；错误 identity 与损坏 key 零新副作用；任一时刻恰一 install owner，authority与private commit前异 transfer稳定拒绝，terminal后旧 replay零回滚；P0安全域覆盖与用户重试失败同时消除。不得新增第二 journal、第二 prepared 事实、通用事务/lifecycle 或新 runner。 | 已验证 |
| U35-04 | **P0/大。**DR commit 只由 standalone CLI 构造 target并直接回执；已运行的 `MeshRuntimeAssembly` 没有消费新 disaster installation 的 live handoff，只有冷启动会执行 installed-generation、participant、consumer 与 pending closure。<br>**价值裁决记录：**原结论为 P0/大。对立复核确认冷启动确实能闭合，人工重启也可能恢复，因此问题不是永久数据丢失；但 active anchor-role target 正在运行是本单元正常拓扑，CLI 在 runtime 尚未接管时回执“恢复完成”，会让整条 source-less 核心旅程在唯一 source 已丢失后仍不可用。把规则改为必须停服/重启既弱化 always-online 体验，也绕过 D35-06 明定的 live/startup 共用闭包；现有 installation loader、generation coordinator、consumer receipt和trust watcher可复用，但跨进程检测、gate、完成回执及两 profile故障恢复仍是成组改动，不能据此缩为小修。用户体验达标：完成回执等于当前进程已可服务；架构达标：durable installation仍是唯一代际事实。决定保留 P0/大。仅当生产入口强制且公开地把恢复定义为停服冷启动流程，或 running assembly 已在回执前完成同一 descriptor时重开裁决。 | standalone DR commit与运行中authority runtime没有共享同一个installation consumption completion：trust watcher可看到新trust，但未在发布后第一个await前关闭gate并把disaster installation交给startup同款generation/consumer闭包，也没有CLI可等待的durable completion receipt。 | **生产端：**DR CLI/target commit、disaster installation、trust watcher、anchor+executor与anchor-only两个current-anchor profile的`MeshRuntimeAssembly`。**类型组合：**live/startup；install前后；watcher回调首个await、generation participant/三组consumer/六类pending/read-back/cleanup各切点；响应丢失与连续重启。**消费者：**runtime epoch/projection/cursor/router，scheduler/intent/assignment，conversation/interaction/confirmation/final，delivery与六类AuthorityCatalog pending。**零副作用边界：**新trust可见即gate关闭，receipt前不得cleanup/open/成功回执。**异常终态：**耐久owner已换代而内存仍旧代际或CLI过早报完成。**直接证据：**两profile真实installation/log/catalog，live commit逐切点、非空pending、丢响应/重启与S7 live/cold exact-set。**受影响审查项：**IR35-17～IR35-18、IR35-30～IR35-34、IR35-36。 | 复用现有trust watcher、current-owner gate、disaster installation loader、installed-generation coordinator和consumer receipt：watcher发现更新trust时须在回调第一个异步等待前同步置transition-pending，使全部公开/current-owner入口立即拒绝；随后加载exact current disaster installation，并与cold startup调用同一completion。completion依次完成generation rebind、三组recover/start、六类pending归属与逐项read-back；在target同一`AuthorityCommitLog`的installation progress中耐久写绑定installation digest/generation及全部participant/read-back的`disaster-post-install-completed` receipt后，才cleanup、release gate、open surface和允许CLI报完成。失败保留installation、closed gate与缺失receipt供live/startup重驱。**完成：**两profile任一切点、响应丢失和连续重启下仅当前代际可服务，CLI成功与durable receipt全等；不新增通用IPC/lifecycle。 | 已验证 |
| U35-05 | **P1/中。**`CredentialExposureAuthority.publishRotation()` 没有任何生产调用；正常 editor/startup 只发布 active bindings，而 compromised binding 会被 read guard阻断且 `publishActiveBindings()` 明确跳过。<br>**价值裁决记录：**原结论为 P1/中，并笼统把 editor、service verification与publication串联。对立复核确认保持 degraded只保护了未轮换旧凭据，却使用户完成外部撤销和本地换密钥后仍永久不可路由；这违反 D35-08 明确的当前交付，但不阻断与该 binding 无关的核心能力，故不能升 P0。进一步核对发现通用 startup loader会在 publication前被 compromised guard阻断，而现有 `CredentialBindingDescriptor` 已携 service-verified fingerprint/revision；最优方案应是窄 rotation分支复用该验证产物，而不是新增 provider/channel/MCP 验证框架或放宽普通 guard。用户体验达标：按提示换密钥后该 binding可恢复；架构达标：active+rotated仍在一个 authority transaction。新决定为改写并保留 P1/中。仅当生产已有等价 caller，或产品正式取消恢复后 binding复用并同步删除该交付义务时重开裁决。 | credential editor/save只完成SecretStore写入与host reload，没有把`rotationRequired`、新credential的service-verified principal/readiness和现有`publishRotation()`组成一个窄原子恢复分支；普通active publication又被compromised guard正确阻断。 | **生产端：**config editor/save、SecretStore writer/read-back、当前provider/channel/MCP有限验证入口、credential readiness descriptor、`CredentialExposureAuthority`。**类型组合：**各当前binding kind；同/异principal；revision递增/重复；验证、回读、readiness、authority publish效果前后失败；响应丢失与exact replay。**消费者：**credential route guard、executor readiness、provider/channel/MCP启动。**零副作用边界：**SecretStore回读或service-verified principal/readiness未成立时不得把旧compromised改为rotated。**异常终态：**用户已完成外部撤销与本地换密钥但binding永久不可路由，或未经服务验真错误解封。**直接证据：**真实SecretStore、当前有限binding验证、authority transaction和跨binding隔离场景；S7冻结唯一生产caller与kind exact-set。**受影响审查项：**IR35-21、IR35-30、IR35-32～IR35-34、IR35-36。 | 在现有editor/save完成路径增加唯一`rotationRequired`窄分支：保存前后diff按binding identity定位当前compromised项并冻结稳定requestId/next revision；写入新secret后必须从同一SecretStore回读，再由当前provider/channel/MCP有限生产适配逐kind取得服务认证的canonical principal与readiness descriptor，`user-alias`、歧义或不支持均不得解封。验证成功后调用现有`publishRotation()`，让active新binding与旧compromised→rotated在同一authority transaction发布；响应丢失按requestId/revision exact replay，其他binding不变。**完成：**回读/服务验证/readiness任一失败时旧项仍compromised且新route关闭，成功时单事务恢复且普通publication guard不放宽；三类binding直接场景与S7通过，不新增通用验证框架或自动第三方轮换。 | 已验证 |
| U35-06 | **P1/小。**`runRecoveryRootApproveResetCommand()` 复用 issuer-oriented `openContext(false, false)`；该上下文仍要求本机 anchor role并取得 current issuer 私钥。<br>**价值裁决记录：**原结论为 P1/小。对立复核排除删除 reset 旅程：current issuer仍在、恢复包永久丢失且另一 active device可共同授权是 D35-07 明确支持的安全恢复场景，当前入口在合法最小权限设备上必然失败。放宽为 issuer自签会破坏双人授权，要求 co-signer复制 issuer key会扩大秘密面；只拆出读取 signed trust与本机 device key的窄 context即可。用户体验达标：合法第二设备能完成确认；架构达标：issuer与co-signer权限严格分离。决定保留 P1/小。仅当生产 approval入口已不加载issuer key/anchor配置且只接受distinct active member，或该旅程被权威范围明确取消时重开裁决。 | reset approval入口误复用issuer/anchor的可写上下文并调用可创建key的装载路径，没有独立的只读distinct-active-member approval context。 | **生产端：**`runRecoveryRootApproveResetCommand`、SecretStore device-key reader、signed trust replay、`createDomainResetApproval`。**类型组合：**distinct active executor/surface、current issuer、pending/revoked member；旧chain/epoch、错签名、重复生成与输出丢失。**消费者：**current issuer reset聚合与trust event发布。**零副作用边界：**本地既有device key、current signed trust和distinct active身份任一不成立时零key创建/authority写入。**异常终态：**合法第二设备无法共同授权，或co-signer被迫取得issuer秘密。**直接证据：**真实SecretStore/trust store、各member状态/代际/签名与S7最小权限装配。**受影响审查项：**IR35-27、IR35-29、IR35-32～IR35-34、IR35-36。 | 为approve-reset拆出窄只读context：要求SecretStore已解锁，枚举并加载唯一既有本机device key（只用`loadDeviceKey`，禁止create）；只读加载、验签和replay current signed trust/HomeTrustRecord，要求本机member为active且不同于current issuer。该路径不检查anchor role/config，不加载/创建issuer key，不绑定target/capacity且不写authority；原current-issuer reset路径继续使用严格上下文。**完成：**distinct active设备可签，issuer/pending/revoked/旧代际/错签名稳定拒绝；重复生成可产生同代际等价approval但始终零authority写入/key创建，issuer只接受一次current-generation reset，旧码随换代失效；直接测试与S7通过。 | 已验证 |
| U35-07 | **P0/中。**disaster candidate 将完整 `DisasterRecoveryVerifiedCandidate` 和 installation decision 作为 `verifiedJson`/`decisionJson` 内联写入 `FileAuthorityCommitLog`，而 `MAX_INLINE_LOGICAL_RECORD_BYTES` 固定为 32 KiB；完整 `AuthorityCatalog`、baseline/peer evidence 与 installation entries 没有相同产品上限，合法恢复可在 verified 或 install-decided append 稳定失败。证据：`packages/cli/src/serve/disaster-recovery-candidate.ts:50-106,169-242`、`disaster-recovery-target.ts:249-309,630-655`、`packages/core/src/authority/commit-log.ts:88,162-223,2211-2308`，以及规格“≤32 KiB 内联、超限入 artifact”的冻结合同。<br>**价值裁决记录：**原结论为 P0/中，并笼统要求在 candidate staging 保存超限 payload。对立复核确认问题不是理论容量风险：规格明确规定 `≤32 KiB` 才内联、超限对象必须入 artifact；完整 checkpoint 与 authority catalog 又没有 32 KiB 产品上限，因此保持现状会让受支持的长期 home 在核心人工灾难恢复路径确定失败，给 catalog 人为设限会破坏 full recovery 合同。复核同时推翻原方案中“另找 candidate staging”的不精确部分：candidate 使用的 `FileAuthorityCommitLog` 已注入并公开唯一 `artifactStore`，已有 `ArtifactRef`、present-reference guard 与 retention，不需要第二存储或新框架。新决定为**改写方案并保留 P0/中**。用户体验达标：任意受支持 full checkpoint 都可恢复；架构达标：复用日志既有超限承载与唯一引用事实。关闭后仅在仍有无界 candidate payload 内联、引用生命周期不能支撑 terminal replay，或错/缺引用可越过副作用边界时重开。<br>**根因收敛记录：**对当前 `collectArtifactRefs`、retained-reference projection 与 registered artifact root 反查后确认，只把 payload 本体改成一个普通 ref 仍会把其中的 catalog/retained/installation refs 隐藏在 artifact 内，不能证明 GC 前后的闭包等价；这不是新根因，而是同一“未使用既有 artifact 引用合同”的直接变体。最终方案须让这两类 payload 成为现有 retention 的窄注册 root，内部同步 projection 只保留 ref，公开 state 在日志锁外 hydration，禁止在 reducer/日志锁内做 artifact I/O。 | candidate journal 将无界候选事实与日志内联传输形式绑定，且没有把外置 candidate payload 作为现有 retention 可解引用的注册 root；因此验证/安装决定受 32 KiB 表示上限阻断，或在仅机械外置时丢失嵌套引用闭包。 | **生产端：**candidate `recordVerified()`/`decideInstall()`、target prepare/import/commit、candidate `FileAuthorityCommitLog.artifactStore` 与既有 retained-reference classifier。**类型组合：**32 KiB 上下界；空/非空及多 stream/retained/pending catalog；大 baseline/peer evidence、installation entries；claimed/verified/imported/install-decided/terminal；ref 缺失/损坏/篡改、GC、响应丢失与连续重启。**消费者：**candidate 内部 projection、公开 `state()`/`states()`、per-transfer replay、authority installer、startup completion与两生产根。**零副作用边界：**payload ref 缺失，artifact digest、canonical bytes、strict DTO、phase/transfer/prepare/recovery-root identity 任一不全等时，不得新增 import、decision、authority 或 terminal 效果。**异常终态：**合法完整 checkpoint 永久不能恢复、target-wide claim 持续占有，或历史决定的嵌套引用被 GC 后不能重放。**直接证据：**真实 candidate log + 其 artifactStore/retained-reference projection，在 32 KiB 两侧、闭包 GC、引用损坏、效果/响应丢失及重启场景。**受影响审查项：**IR35-05、IR35-10、IR35-14、IR35-15、IR35-31、IR35-32、IR35-33、IR35-36。 | 用 candidate 现有 `FileAuthorityCommitLog.artifactStore` 分别写 canonical verified/decision bytes并取得 `ArtifactRef`；内部 projection/reducer只保存 phase、transferId与ref，`state()`/`states()`在日志锁外加载并校验 artifact digest/canonical bytes，复用现有 strict validator依次反绑 prepare、verified、recovery root与installation identity。`recordVerified()`/`decideInstall()`先在锁外规范化、写artifact并形成ref，再由同一candidate transaction只比较/追加compact ref；transaction的`candidateReferences`至少保护新payload ref，decision同时保护其冻结candidateReferences exact-set。扩展现有registered-root retention的有限exact-set识别这两个candidate record tag，解引用payload并把其中全部`ArtifactRef`按现有缺省规则无条件保留；不得新建registry。terminal历史重放只hydrate同一ref，缺/错/歧义ref一律fail-closed。**完成：**合法超限payload可exact replay；32 KiB上下界不改变语义；错/缺/篡改ref零副作用；payload及嵌套refs在GC、terminal、响应丢失和连续重启后仍可取得同一verified/decision；真实多stream/retained/pending场景与现有retention/S7直接证据能拒绝内联回退、漏闭包和锁内artifact I/O。不得新增第二journal、第二prepared事实或通用存储框架。 | 已验证 |
| U35-08 | **P2/小。**fresh prepare 在 `recordVerified()` 前已调用 `loadOrCreateAnchorIssuerKey()` 创建 transfer 专属 key，但 authenticated abort 仅在 per-transfer state 存在 `imported` 时调用 `deleteAnchorIssuerKey()`；verified 前或 verified-but-not-imported 的 abort 会确定留下无 authority 用途的 SecretStore 条目。证据：`packages/cli/src/serve/disaster-recovery-target.ts:276-309,668-716`、`packages/mesh/src/device-key-store.ts:66-145`。<br>**价值裁决记录：**原结论为 P2/小。对立复核确认该 key 按 `transferId` 隔离，未进入 active issuer publication，不会造成权限失守、数据泄露或恢复错误，故不得升级为 P0/P1；但泄漏并非未来猜测，每次 key 创建后、import 前的合法 authenticated abort 都会确定留下一个再无消费者的秘密，重复用户取消会单调积累。把它声明为长期保留没有产品价值，另建 secret lifecycle 又成本过高；现有 exact key delete 已足够。新决定为**保留 P2/小**。用户体验达标：取消无额外提示或失败；架构达标：同一 transfer terminal 收束自身秘密且不引入框架。关闭后仅在任一 pre-import abort/replay 仍遗留 key，或 cleanup 可误删 install-decided/active key 时重开。<br>**根因收敛记录：**key creator 位于 candidate transaction 外，abort 与 `loadOrCreateAnchorIssuerKey()` 可并发；仅在 abort 路径耐久后查删一次，会遗漏“abort先查到空、creator随后落key、`recordVerified`再因terminal失败”的晚到key。该反例仍属于同一transfer secret未由authenticated terminal收束，不新增状态或框架；必须由abort端与既有creator失败/终态复核共同使用同一exact delete闭合。 | key cleanup 错把 `imported` 投影当作 transfer key 存在与可删除的前提，且 key creator 未在写后复核同一 candidate terminal；因此已耐久 authenticated abort 不能覆盖 key 已存在和并发晚到两种时序。 | **生产端：**fresh prepare key creation、candidate signed abort、per-transfer abort cleanup、SecretStore exact key slot。**类型组合：**key 创建前后及与abort并发、verified 前后但未 imported、imported、install-decided/current installed；同/异 identity、删除效果/响应丢失与连续重启。**消费者：**ReadyProof/import、abort replay、后继 candidate SecretStore。**零副作用边界：**abort 未耐久、identity 不全等或已 install-decided/current installed时不得删 key；exact slot在load与delete之间换key时必须稳定拒绝。**异常终态：**每次合法 pre-import 取消遗留一个永久无消费者的秘密。**直接证据：**真实 SecretStore 的 create/abort两序、verified前后未imported、错绑key、响应丢失与重启exact replay。**受影响审查项：**IR35-15、IR35-29、IR35-36。 | `candidate.terminal(...,"aborted")`以完整identity耐久胜出且既有install-decision/current-installation门禁均通过后，无论per-transfer是否已有`imported`，abort路径都加载`anchorIssuerKeyRef(transferId)`的当前exact key，并以其`deviceId`调用既有`deleteAnchorIssuerKey()`完成compare-delete/read-back；随后才删staging、release reservation并返回。fresh creator保留`loadOrCreateAnchorIssuerKey()`返回的exact key，在`recordVerified()`前后复核candidate；若同identity authenticated abort已胜出或`recordVerified()`因该terminal拒绝，必须用返回key的`deviceId`幂等补偿删除，slot已被不同key替换则由现有helper拒绝。**完成：**key创建前后及并发abort、verified前后未imported、重复/丢响应/重启replay均无遗留；错abort identity零删除，错绑/替换key不被误删，install-decided/current active key始终保留。不得新增secret lifecycle或第二事实源。 | 已验证 |

## 问题收敛记录

> 本节保留 U35-01～U35-06 上一轮专项修复的事实矩阵、反证处置与历史证据；本轮独立审查 P35-07 已同根重开 U35-03，最新事实、评级、方案、验收与状态只以“问题列表”中的 U35-03 行为准。其余五项仍为“已验证”，下列与 U35-03 相关的旧通过结论不再证明本轮新增的 verified→imported 与 install-decision→authority-install 两个窗口。

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

### U35-03 同根重开固定矩阵（当前）

| 编号 | 直接变体 | 稳定身份与唯一耐久事实 | 线性化点与零副作用边界 | 消费终态与直接验收 |
| ---- | -------- | ---------------------- | -------------------------- | ------------------ |
| F35-13 | claimed；verified 前效果/响应丢失；变化时钟 | candidate prepare identity；per-transfer prepared；私有 refs 尚未由 verified 冻结 | 仍走既有验证路径；recordVerified 是验证事实唯一线性化点 | verified 前失败可续驱或 signed abort；不计入本轮新根因 |
| F35-14 | verified 已有、imported 缺失；空/非空 retained；verified sync 后崩溃 | 原 verified bytes、catalog/retained exact-set、private refs、transfer 专属 SecretStore key | 先验真已有事实并恢复 reservation，只追加一次 imported；不得重算 verified、重做 staging 或新建 key | 变化 clock 下仍得到恰一 imported；真实 candidate/private/per-transfer log 逐切点 |
| F35-15 | imported 已有；prepare/import 响应丢失；proof已过期 | per-transfer imported bytes及其 ReadyProof/key/catalog/ref 身份 | prepare replay不重新签 proof或改 imported；commit才按 U35-02 复验 current readiness/expiry | 返回原 imported；过期或漂移在公开 install 前进入既有 authenticated abort |
| F35-16 | aborted 已有；遗留 key/staging/reservation；同/异 identity 重放 | candidate signed abort terminal | 读取 terminal 先于任何 forward 效果；同 identity 重放原 abort并续清理，异 identity 前置拒绝 | 零新 key/staging/readiness/import；原 cancel/stop 与 claim-only 结论复用 |
| F35-17 | imported→install-decided；prepare/abort与commit竞争；proof临界过期 | imported ReadyProof、candidate identity、完整 canonical installation entries/installation/candidateReferences | 最终 readiness/expiry 复验与 CAS 提升后，candidate transaction 在 install-decided 与 signed abort 间唯一排序；决定后不按重放时钟改判 | abort先赢无decision；decision先赢只前滚，target-wide claim持续占有 |
| F35-18 | install-decided→authority install；安装效果前/后响应丢失 | install-decided 原 bytes、private source head/records、authority install read-back | `installPlannedAnchorPrefix()` 只消费冻结决定并幂等回读同 generation；不得重算 markedAt/trust/commit/refs | 连续重启只安装同一 composite authority；异 transfer稳定 busy |
| F35-19 | authority installed→private committed→candidate terminal；key已清/错绑 | matching current installation、per-transfer imported/committed、exact transfer key | authority install 后激活key并耐久private committed；两者全等后才写candidate+target-wide committed terminal | key异常fail-closed且claim不释放；效果/响应丢失逐步前滚，最终恰一terminal |
| F35-20 | terminal committed exact replay；后继合法 generation；无decision/安装/private commit的伪terminal | candidate install-decided+committed terminal与原安装结果 | terminal replay只返回冻结结果，不重装历史authority；缺任一前置或冲突则projection/startup fail-closed | 旧请求零回滚；新candidate只在前任完整terminal后取得claim；S7拒绝早释与伪terminal |

### U35-03 同根重开反证账（当前）

| 编号 | 主动反例 | 处置 |
| ---- | -------- | ---- |
| C35-C22 | verified 后重跑现场验证，变化的 `verifiedAt` 与原 canonical bytes 冲突 | 同根并入U35-03；F35-14要求 verified-first reducer，只续写 imported |
| C35-C23 | imported 已耐久但响应丢失，重放重新签 ReadyProof/import | 同根并入U35-03；F35-15直接返回原 per-transfer imported bytes |
| C35-C24 | verified 后 transfer key 缺失时 load-or-create 新 key，使一次candidate跨两把key | 同根并入U35-03；verified 前key已耐久，缺失/损坏fail-closed且只能走authenticated abort |
| C35-C25 | 只保存 `DisasterRecoveryInstallation`，遗漏动态 compromised exposure、missing trust entries 或 candidateReferences | 同根并入U35-03；install-decided冻结完整canonical installation entries与引用exact-set |
| C35-C26 | commit先写candidate committed terminal，异transfer在authority install前取得claim | 同根并入U35-03；install-decided保持claim至authority install与private committed均完成 |
| C35-C27 | authority安装效果已发生但响应丢失，重跑按新时钟重算commit/trust/exposure | 同根并入U35-03；F35-18只消费原install-decided并read-back同generation |
| C35-C28 | private committed前释放claim，后继candidate删除/替换仍需激活的transfer key或私有事实 | 同根并入U35-03；F35-19把private committed纳入terminal释放前置 |
| C35-C29 | abort与install decision各落不同日志，竞争后同时成立 | 同根并入U35-03；两者在现有candidate transaction内互斥，phase journal只物化胜者效果 |
| C35-C30 | 历史 committed terminal在后继generation后重放并重新安装旧prefix | 同根并入U35-03；terminal只回放冻结结果且零authority写，伪terminal/冲突fail-closed |

### U35-03 四路冷启动对抗复审（当前）

- **冻结输入：**U35-03 问题行、F35-13～F35-20 与 C35-C22～C35-C30 共 18 行；按行序以 LF 连接并保留末尾 LF 的 SHA-256 为 `0da923eee45a37a1f564c6c56161e0ae650b150b639ec31dcd62c9f611c98773`。以下四路从权威总纲、规格与当前源码重新推导，未复用上一轮结论；复审期间该 18 行未修改。

| 对抗视角 | 冷启动重造的反例与直接交界 | 同一记录结论 |
| -------- | ---------------------------- | ------------ |
| verified→imported 耐久重放 | 从 `prepareAndImport()` 与两个日志重新推导变化时钟、verified sync后崩溃、空/非空retained、imported响应丢失、key缺失/损坏；核查 U35-01 baseline 与 U35-02 ReadyProof/reservation | 通过。verified只拥有验证/catalog/ref事实，imported只拥有ReadyProof/import决定；F35-14～F35-16在两者之间给出唯一续驱，未复制prepared或放宽readiness。 |
| install decision 与 target-wide 单飞 | 从candidate/target-wide同一事务、WAL replacement与private journal重造decision前后崩溃、双candidate、动态exposure/trust条目和响应丢失；核查 Unit34 target-wide/private install合同与 U35-04 post-install边界 | 通过。install-decided冻结完整安装输入并保持claim；authority visibility、private committed、terminal release三点顺序有限且可复核，不把U35-04 consumer receipt错误并入candidate单飞。 |
| abort/commit/identity 与连续恢复 | 从signed abort、proof expiry、同/异identity、key已清/错绑、decision/abort竞争、authority效果后重启及历史terminal replay主动构造反例 | 通过。expiry只在decision前判定；abort与decision同事务互斥，decision后只前滚；请求重放与既有installation loader分别覆盖install前后，错误/伪terminal零authority副作用。 |
| 生产证据、产品体验与范围价值 | 反查真实candidate/per-transfer/authority log、现有target测试与S7 mutation承载面，并核对U35其余五项、第33～34及第36～38单元边界 | 通过。直接故障场景和既有S7可同时拒绝verified重算、第二prepared、不完整decision与早释claim；修复恢复同一备份可重试且消除安全域覆盖，P0/中比例成立，无自动failover、同步、恢复应用或通用基础设施扩面。 |

- **差异审计：**C35-C22～C35-C30 全部以“同根并入 U35-03”闭合；没有反证消失、重复根因或新增问题。U35-03 保持 P0/中：P0 来自不可回滚安全域可被后继认证候选覆盖及唯一备份无法重试的当前损失；中工作量来自一个既有 candidate reducer、一个 target 重放顺序、直接测试与现有 S7 的有限修改。两次价值裁决继续有效，第二 prepared、第二 journal、通用 lifecycle/事务与后继单元能力均被排除。

### U35-03 修复后专项功能审查与四路冷启动对抗

- **冻结交付物：**以第 34 单元封版提交 `972f363e` 为基线的 63 个非工作台功能路径；规范化指纹 `8da1865c02bc6fe07c69f819cee7476345faec308d03d736c94cc17f58dc8f90`。U35-03 九个直接变更文件指纹为 `b2ab9cc49c06867242ab58f4ec882144ccd136b9b7c4ca9c9286432c5f593b8c`；以下矩阵、验证与四路对抗均绑定同一未修改功能输入。
- **直接验证：**disaster target 6/6、mesh ReadyProof 2/2、Biome 定向检查通过、S7 18/18 与 registry golden 通过；同一最终源码输入的 `pnpm build` 成功（17/18 workspace projects scope，383 秒）。CLI 类型检查只复现 8 个不在 U35-03 变更闭包内的既有 config-editor/startup projection 错误，U35-03 变更文件零新增类型错误。

| 固定矩阵 | 修复后事实链与直接证据 | 专项结论 |
| -------- | ---------------------- | -------- |
| F35-13 | claimed 与 fresh verified 继续走既有验证；transfer key 在 `recordVerified` 前耐久保存并回读 | 通过：verified 前故障可续驱或走既有 authenticated abort，不引入第二 prepared |
| F35-14 | existing verified 在任何新 key/staging/readiness 效果前验真原 catalog、retained exact-set、private refs 与专属 key，只续写一次 imported | 通过：变化 clock、空/非空 retained 与 verified sync 后重启均复用原 verified bytes |
| F35-15 | existing imported/committed 直接返回原 imported bytes、refs 与 ReadyProof，不重签或改写 | 通过：响应丢失 exact replay；expiry/revision 只在新 install decision 前复验 |
| F35-16 | candidate aborted 在所有 forward 效果前返回原 signed terminal并续清理，异 identity 前置拒绝 | 通过：原 cancel/stop、claim-only abort、governor 与资源边界保持闭合 |
| F35-17 | CAS 提升与最终 readiness/expiry 复验后，candidate transaction 在 signed abort 与完整 `install-decided` 间唯一排序 | 通过：decision 冻结 installation entries、installation 与 candidateReferences exact-set并持续占有 target-wide claim |
| F35-18 | authority installer 只消费冻结 decision，安装后 exact read-back 同 generation；效果或响应丢失重放同一输入 | 通过：异 transfer 在 authority 可见前稳定 busy，不按重放时钟重算 |
| F35-19 | authority read-back 后激活 exact key、追加并回读 private committed，最后才写 candidate/target-wide committed terminal | 通过：key 缺失/错绑 fail-closed且不释放 claim；live/startup 均只前滚 |
| F35-20 | historical committed terminal只返回冻结结果；decoder/reducer拒绝第二 prepared、冲突 decision、无 decision committed 与 decision 后 abort | 通过：后继 generation 后旧请求零 authority 写，伪 terminal 与错误 identity 零副作用 |

| 对抗角色 | 冷启动重造的反例与交界 | 同指纹结论 |
| -------- | ------------------------ | ------------ |
| verified→imported 耐久重放 | 重造变化 clock、空/非空 retained、verified/imported 各 sync 窗口、proof expiry、key 缺失/错绑；核查 U35-01 baseline 与 U35-02 readiness | 通过：verified 只冻结验证事实，imported 只追加一次并永久 exact replay，无第二 prepared |
| install decision 与 target-wide 单飞 | 重造双 candidate、decision/authority/private/terminal 各窗口、安装效果与响应丢失；核查 Unit 34 private install 与 U35-04 completion | 通过：install-decided 保持 claim，authority 与 private read-back 前不存在 terminal release |
| abort/commit/identity 与连续恢复 | 重造 prepare/abort/commit 竞争、proof 过期、同/异 identity、key 异常、连续重启与后继 generation | 通过：abort 与 decision 同事务互斥；decision 后只前滚，历史 terminal 不回滚 authority |
| 生产证据、产品体验与范围价值 | 反查真实 candidate/per-transfer/authority log、private store、SecretStore、ReadyProof、两生产根、S7 与直接测试；核对 Unit 33～34 和 Unit 36～38 边界 | 通过：恢复可在响应丢失后继续且安全域不会被后继 candidate 覆盖；未新增第二 journal、通用 lifecycle/事务或后继单元能力 |

- **差异审计：**C35-C22～C35-C30 全部以“修复后复核通过”关闭；未发现新增同根反证、独立根因或范围漂移。两次价值裁决继续有效，U35-03 保持 P0/中并更新为“已验证”；U35-01～U35-02、U35-04～U35-06 的既有结论继续复用。

### U35-07～U35-08 固定矩阵（当前）

| 固定矩阵 | 唯一事实、线性化点与零副作用边界 | 直接验收 |
| -------- | ---------------------------------- | -------- |
| F35-21 | verified canonical bytes只写candidate现有artifactStore；candidate transaction只耐久同一`ArtifactRef`，该append是verified可见线性化点 | payload在32 KiB以下、等于边界与以上时得到同一hydrated DTO；claimed/verified重放不产生第二payload事实 |
| F35-22 | decision canonical bytes同样外置；`install-decided`只耐久decision ref并与signed abort互斥，candidateReferences在同事务保护 | 空/非空、多stream/retained/pending、大baseline/peer evidence/installation entries均可写；同输入ref全等、异输入冲突 |
| F35-23 | 内部同步projection只持prepare、phase与payload refs；公开`state()`/`states()`在日志锁外按verified→decision顺序hydrate | claimed、verified、imported、install-decided及两生产根消费者均取得完整原DTO；禁止reducer/日志锁内artifact I/O |
| F35-24 | 两个candidate record tag进入现有registered-root retention exact-set，payload root及其嵌套`ArtifactRef`均按既有缺省规则无条件保留 | verified/decision后执行GC、terminal后再GC、响应丢失与连续重启仍可exact replay全部refs；无第二registry |
| F35-25 | 每次hydrate先由`ArtifactRef`校验原始bytes digest/length与canonical JSON，再复用strict validator反绑transfer、prepare、verified、root与installation | ref缺失、bytes/digest错、未知字段、错transfer/phase/root/installation在任何import/decision/authority/terminal新效果前fail-closed |
| F35-26 | payload artifact先写而candidate append未发生时没有耐久phase事实；同canonical bytes产生同ref，普通未引用对象只由现有GC处理 | artifact写后故障、append效果/响应丢失和连续重启不产生第二candidate事实，也不需要专用cleanup/outbox |
| F35-27 | key尚不存在时authenticated abort terminal仍成立，exact slot删除为空操作；key已存在时terminal耐久后compare-delete并回读 | key创建前、创建后且verified前、verified后未imported、imported四态均收敛，重复abort无遗留 |
| F35-28 | key creator保留本次`loadOrCreate`返回identity；abort先赢时creator在`recordVerified`前后复核terminal并用同identity补偿删除 | abort查空→晚到key、key先落→abort删除、recordVerified与abort竞争三序均无遗留，效果/响应丢失可重驱 |
| F35-29 | abort签名与candidate prepare全字段反绑先于terminal；delete helper以transfer slot与expected key id做compare-delete/read-back | 异request/transfer/target/checkpoint/root或slot在load/delete间被替换时零误删且稳定拒绝 |
| F35-30 | candidate `install-decided`与current disaster installation均是禁止abort/delete的既有门禁；active issuer是独立槽位 | imported但未decision可abort并删transfer key；decision/current installed/active阶段只前滚，历史abort不能删当前key |

### U35-07～U35-08 反证账（当前）

| 反证编号 | 主动重造的反例 | 归因与耐久处置 |
| -------- | ---------------- | ---------------- |
| C35-C31 | verified或decision恰好跨过32 KiB后append被`MAX_INLINE_LOGICAL_RECORD_BYTES`拒绝 | 同根合并至U35-07：两类无界payload都必须外置，边界两侧共用同一ref语义 |
| C35-C32 | 仅把完整payload换成普通ref，payload内catalog/retained/candidateReferences不再被record级collector看到 | 同根合并至U35-07：两个record tag必须进入现有registered-root retention并保留整个嵌套引用闭包 |
| C35-C33 | 为了hydrate直接把artifact read放进同步projection reducer或candidate transaction日志锁 | 同根合并至U35-07：内部projection只存ref，全部hydrate/strict validation在锁外完成，事务只比较ref |
| C35-C34 | ref存在但bytes损坏、digest/length不符、JSON非canonical、DTO或identity错绑 | 同根合并至U35-07：加载、内容验真、strict decode与逐级identity反绑全部前置于新副作用 |
| C35-C35 | artifact put成功但candidate append前失败，重试可能留下孤立payload | 当前方案证伪独立问题：content-addressed同bytes同ref且无phase可见，未引用对象由既有GC处理，不增加专用cleanup |
| C35-C36 | terminal成立后payload root仍在而嵌套refs先被GC，历史commit不能重放 | 同根合并至U35-07：root classifier保留payload及闭包，terminal不削除该retention事实 |
| C35-C37 | key在verified前或verified后未imported，abort因`current?.imported`为false跳过删除 | 同根合并至U35-08：authenticated terminal而非imported决定transfer key清理资格 |
| C35-C38 | abort先耐久并查到空，仍在运行的prepare随后创建key，recordVerified再被terminal拒绝 | 同根合并至U35-08：creator保留exact identity并在terminal竞争失败时补偿删除，abort端与creator端共同闭合 |
| C35-C39 | 错abort identity或SecretStore slot在load/delete间被另一key替换 | 同根合并至U35-08：完整abort/prepare绑定在前，既有expected-key-id compare-delete拒绝替换对象 |
| C35-C40 | install-decided或current installed后迟到abort删除将激活/已决定key | 当前源码与方案共同证伪：candidate transaction拒绝decision后abort，current installation前置拒绝；两门禁均保留且直接验收 |

### U35-07～U35-08 四路冷启动对抗复审（当前）

| 对抗角色 | 冷启动重造的反例与直接交界 | 未修改问题列表上的结论 |
| -------- | ---------------------------- | ------------------------ |
| 超限candidate payload与artifact生命周期 | 从32 KiB限制反推verified/decision全部生产者，重造大catalog/evidence/entries、普通ref隐藏闭包、GC与错ref；核查U35-01 baseline、U35-03 decision、Unit 33 retention与Unit 34 private install | 通过：U35-07同时约束payload root、嵌套引用闭包、锁外hydration与零副作用验真；没有第二存储或registry |
| verified/decision/terminal exact replay与连续恢复 | 从claimed到terminal逐phase重造artifact写/append/安装效果与响应丢失、缺ref、连续重启及后继generation | 通过：candidate日志中的ref仍是唯一phase事实，hydrate只恢复原bytes；terminal历史重放不重算、不回滚authority |
| pre-import key cleanup与active-key隔离 | 重造key创建前后、abort/create竞争、verified/imported、错identity、slot替换、decision/current installed与重复重启 | 通过：U35-08以authenticated terminal授权exact cleanup，并用creator补偿关闭晚到窗口；decision/current installation保持永久防误删 |
| 生产证据、产品体验、范围价值与历史裁决 | 反查真实candidate/target-wide log、artifactStore/retention、SecretStore与两生产根；核对U35-01～U35-06、第33～34及第36～38单元边界 | 通过：P0/中来自合法full recovery确定被32 KiB阻断，P2/小仅是无消费者秘密累积；方案成本分别与损失成比例，未恢复第二journal/prepared或扩入后继能力 |

- **差异审计：**C35-C31～C35-C40 均以“同根合并”或“当前源码/方案证伪独立问题”闭合；四路复审未发现第三个根因。U35-07保持P0/中，U35-08保持P2/小；U35-01～U35-06既有结论与两次价值裁决不变，自动failover、持续/全局同步、恢复应用、通用storage/secret lifecycle及第36～38单元能力继续排除。

### U35-07～U35-08 修复后专项功能审查与四路冷启动对抗

- **冻结输入：**以 `972f363e` 为基线的 65 个非工作台 Unit 35 路径；规范化 SHA-256 为 `a20589ca2d358f80e5f51f47b5d6589a5cb86dc77429ee7c9bf3338039e91c35`。功能代码、测试、架构/规格与 S7 在下列只读复核期间未修改。
- **验证事实：**core registered-root/GC 真实场景 1/1、CLI disaster target 真实场景 9/9、S7 18/18 与 registry golden、Biome 定向检查及 workspace build 17/18 projects 均通过；CLI 类型检查只复现既有 8 个非本单元 config-editor/startup 错误，Unit 35 变更文件零新增错误。

| 固定矩阵 | 冻结源码与直接证据复核 | 结论 |
| -------- | ---------------------- | ---- |
| F35-21～F35-23 | verified/decision canonical bytes均先写candidate既有artifactStore；candidate reducer只投影ref，公开state在事务与日志锁外依次hydrate；32 KiB以下既有场景与超限真实场景共用同一路径 | 通过；日志无inline payload回退，无第二prepared或第二journal |
| F35-24～F35-26 | 两个record tag是现有registered root，ref自身由candidateReferences保护，payload内全部ArtifactRef缺省无条件保留；真实GC保留4个闭包对象并删除未引用对象，篡改payload后历史重放fail-closed | 通过；payload与嵌套refs在terminal、GC、响应丢失和重启后仍由同一ref验真，孤立put仍归现有GC |
| F35-27～F35-28 | authenticated terminal先耐久；abort端对当前transfer slot compare-delete，creator持load-or-create返回identity并在recordVerified前后及失败路径复核terminal | 通过；key先落、abort先查空后晚到creator、verified前后未imported及重复重放均无遗留 |
| F35-29～F35-30 | abort签名/prepare identity在terminal前全等校验；delete按expected deviceId回读，install-decided与current installation门禁保持不变，active issuer槽位未被触及 | 通过；错identity/slot替换零误删，decision/current installed/active只前滚 |

| 对抗角色 | 冷启动重造的反例与直接交界 | 同一冻结指纹上的结论 |
| -------- | ---------------------------- | ------------------------ |
| 超限candidate payload与artifact生命周期 | 从日志32 KiB边界重新枚举空/非空、多stream/retained/pending、大baseline/evidence/entries、普通ref隐藏闭包、terminal后GC及缺/错/篡改ref；核查U35-01 baseline、U35-03 decision、Unit 33 retention与Unit 34 private install | 通过。全部合法payload均外置为唯一ref；registered-root hydration保留payload及嵌套闭包，严格字节/DTO/identity验真先于新副作用 |
| verified/decision/terminal exact replay与连续恢复 | 逐个重造artifact put→candidate append、verified→decision、authority effect/response loss、terminal、后继generation和连续重启 | 通过。同canonical bytes稳定同ref，phase只由compact journal决定；历史terminal只hydrate冻结ref且不会重装旧authority |
| pre-import key cleanup与active-key隔离 | 重造key创建前后、abort/create三序、verified前后未imported、imported、错identity、slot替换、install decision/current installed/active和重启 | 通过。terminal是唯一cleanup授权；abort与creator两侧共同闭合晚到窗口，exact compare-delete与既有门禁保护其他/active key |
| 生产证据、产品体验、范围价值与历史裁决边界 | 反查真实candidate/target-wide log、artifactStore/retention、per-transfer journal、SecretStore、authority log与两生产根；核对U35-07↔U35-08、U35-01～U35-06、第33～34及第36～38单元边界 | 通过。full recovery不再受表示上限阻断，取消不累积无消费者秘密；未引入第二事实源、通用storage/secret lifecycle、自动failover、同步或后继能力 |

- **反证差异审计：**C35-C31～C35-C34、C35-C36～C35-C39均“修复后复核通过”；C35-C35继续由当前content-addressed put与现有GC证伪为独立问题，C35-C40继续由install-decided/current-installation门禁证伪。未发现新增同根反证、第三根因或满足历史价值裁决重开条件的生产事实。

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
| V35-03 | U35-03 verified/imported 重放、install decision、private completion 与 authenticated terminal | disaster target + mesh ReadyProof 定向 Vitest、S7 mutation | candidate/target-wide 与 per-transfer journal、private/shared artifact、SecretStore、ReadyProof、authority install、startup completion | 修复直接验证 / 中 / 6+2 场景 + gate | target 6/6、mesh 2/2、S7 18/18 与 registry golden 通过；覆盖变化 clock、空/非空 retained、错 key、install 响应丢失、异 candidate 和 claim-only abort | 专项冻结指纹 `8da1865c…f90` | 有效 |
| V35-04 | U35-04 live/startup installation completion 与 terminal replay | disaster installation、mesh runtime assembly 定向 Vitest + S7 | installation loader/receipt、bootstrap/assembly、三组 consumer、六类 pending、CLI replay | 修复直接验证 / 中 / 2 场景 + gate | installation 1/1、assembly 1/1、live/cold/terminal exact-set gate 通过 | 同上 | 有效 |
| V35-05 | U35-05 provider/channel/MCP rotation publication | credential rotation publication 定向 Vitest | editor/startup production caller、SecretStore、三类 verifier、exposure transaction | 修复直接验证 / 低 / 3 场景 | 3/3 通过，覆盖多 binding revision 与失败隔离 | 同上 | 有效 |
| V35-06 | U35-06 distinct active co-signer 最小权限 | backup approve-reset 定向 Vitest + S7 context gate | backup command、read-only approval context、SecretStore/trust store | 修复直接验证 / 低 / 1 场景 + gate | distinct active 通过，issuer/pending/revoked 与 key-create/authority-write 路径被拒绝 | 同上 | 有效 |
| V35-07 | CLI 类型检查归因 | `pnpm --filter @zhixing/cli exec tsc --noEmit` | 当前 CLI 源码与 workspace 类型依赖 | 修复直接验证 / 低 | 仅复现 8 个基线既有 config-editor/startup projection 类型错误；Unit 35 变更文件零新增错误 | 失败文件均不在 Unit 35 变更闭包 | 诊断 |
| V35-08 | 既有 S7 与 registry 派生资产 | `pnpm s7:lint` | S7 runner/test、canonical registry golden、两生产根 descriptor | 派生资产预检 / 低 | 18/18 且 registry golden 通过；mutation 拒绝 verified 重算、第二 prepared、install/private/key read-back 前 terminal | 专项冻结指纹 `8da1865c…f90` | 有效 |
| V35-09 | 当前源码可构建与跨包导出可消费 | `pnpm build` | 当前 workspace 源码、package graph 与未变 lockfile | 开发/修复必要构建 / 高 / 383 秒 | 17/18 workspace projects scope 全部成功；作为当前输入唯一 workspace build 证据保留 | 专项冻结指纹 `8da1865c…f90` | 有效 |
| V35-10 | 功能指纹、矩阵、四路对抗与范围边界 | 63 路径规范化 SHA-256 + F35-01～F35-20/C35-C01～C35-C30 只读重建 | 全部非工作台功能路径、权威合同、生产调用图与直接证据 | 专项功能复核 / 中 | 指纹 `8da1865c02bc6fe07c69f819cee7476345faec308d03d736c94cc17f58dc8f90`；U35-03 四路通过，无第二 prepared、第二 journal或 Unit 36～38 扩面 | 同值 | 有效 |
| V35-11 | U35-07 registered-root retention、嵌套引用闭包与严格 hydration | core authority-storage 单例 + Biome 定向检查 | artifact-retention、commit-log、candidate journal及直接测试 | 修复直接验证 / 低 | registered-root/GC 真实场景 1/1；core类型检查与6个适用TS文件Biome通过 | 专项冻结指纹 `a20589ca…c35` | 有效 |
| V35-12 | U35-07/U35-08 candidate exact replay与pre-import exact-key收束 | `pnpm --filter @zhixing/cli exec vitest run src/serve/disaster-recovery-target.test.ts` | candidate/target-wide与per-transfer log、真实FileArtifactStore、SecretStore、ReadyProof与authority install | 修复直接验证 / 中 / 59.74秒 | 9/9通过；含超限verified/decision、篡改ref、verified未imported abort、abort查空后晚到creator、terminal replay | 专项冻结指纹 `a20589ca…c35` | 有效 |
| V35-13 | 当前CLI类型闭包归因 | `pnpm --filter @zhixing/cli exec tsc --noEmit` | 当前CLI源码与workspace类型依赖 | 修复直接验证 / 低 / 29.7秒 | 仅复现既有8个config-editor/startup projection错误；本轮变更文件零新增错误 | 失败文件不在U35-07/U35-08闭包 | 诊断 |
| V35-14 | candidate/retention/key-cleanup结构门禁与派生资产 | `pnpm s7:lint` | S7 runner/test、retained projection version、两生产根descriptor与registry golden | 派生资产预检 / 低 / 73.2秒 | 18/18与registry golden通过；mutation拒绝inline回退、漏registered root、v4→v3、锁内hydration及creator/abort顺序漂移 | 专项冻结指纹 `a20589ca…c35` | 有效 |
| V35-15 | 当前源码与跨包导出可构建 | `pnpm build` | 当前workspace源码、package graph与未变lockfile | 开发/修复必要构建 / 高 / 299.7秒 | 17/18 workspace projects scope全部成功；作为当前输入唯一workspace build证据 | 专项冻结指纹 `a20589ca…c35` | 有效 |
| V35-16 | U35-07/U35-08固定矩阵、四路对抗、反证与范围边界 | 65路径规范化SHA-256 + F35-21～F35-30/C35-C31～C35-C40只读重建 | 全部非工作台功能路径、权威合同、生产调用图与V35-11～V35-15 | 专项功能复核 / 中 | 指纹`a20589ca2d358f80e5f51f47b5d6589a5cb86dc77429ee7c9bf3338039e91c35`；四路通过，十项反证耐久处置且无Unit36～38扩面 | 同值 | 有效 |

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
