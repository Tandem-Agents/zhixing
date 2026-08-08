# 单元登记:第 33 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:33
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-08
- **登记来源**:用户要求将第 33 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U33-04、U33-05、U33-10 已在最终专项冻结指纹上完成实现、最小必要验证、F33-30～F33-40 只读事实重建与四路冷启动对抗，三项均为“已验证”；其余 U33 问题与 EX33-01 既有结论继续复用。受变更影响的独立审查项已标为 `[~]` 等待后续独立审查，本轮未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅作为 U33-04、U33-05、U33-10 专项修复与对抗收口基线；不代表全单元冻结终审已开始）
- **交付物文件集**:`git diff HEAD --name-only -- . ':(exclude)research/design/workbench/**'` 与非工作台未跟踪路径并集排序所得 22 个生产实现、直接测试、S7 与架构/规格文件；`research/design/workbench/` 流程账本路径不参与功能指纹
- **当前交付物指纹**:`92953a6e3f7d5cd179f9c5c5a933f844487036541d5710b2d4effaab7a4e488e`；算法为对排序后的 22 个非工作台路径逐文件计算 SHA-256，以 `path<TAB>hash`、LF 与末尾 LF 形成 UTF-8 清单后再计算 SHA-256
- **架构来源**:`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`，以及已定稿开发清单 D33-01～D33-08

## 固定边界

- **功能范围**:同一 `CheckpointEnvelope.v1` 下的全量 authority payload、每日与迁居前强制 checkpoint 接缝、独立目录或 active paired device 单目标 adapter、恢复包真解封、`fullBackupReady`、新代替换、独立 target 的 27 天回收边界与 source-local 缓存释放事实，以及两生产根的唯一 owner、生命周期、管理入口、S7 门禁和直接证据
- **架构不变量**:current anchor 的唯一 `AuthorityCommitLog` / `ArtifactStore` / `ArtifactLifecycleIndex` / storage governor 是权威事实源；full coverage 与 retention 使用同一分类谓词；root/chain/source generation、target binding 和物理文件身份必须冻结且可重驱；秘密不回显，路径与 wire 边界 fail-closed；可选备份故障不得阻断普通业务
- **验收条件**:U33-01～U33-13 均达到“已验证”；P0/P1 清零；full capture、generation readiness、target lifecycle、资源与物理边界、兼容/秘密/状态/可用性及 S7 必要证据在两生产根取得成比例直接证据
- **必要上下游**:上游仅复用现行 S2 root-activation `CheckpointEnvelope`、`RecoveryActivationCoordinator` / `RecoveryCheckpointTarget`、`FileMeshBootstrapStore`、current anchor authority/log/store/index/governor；下游仅冻结第 34 单元读取“当前根、已验证、全量”checkpoint 的窄接缝和第 35 单元解封载荷合同
- **明确不属于本单元**:第 34 单元 `SourceFreezeProof(anchor)`、AuthorityCatalog 导入、`TrustTransition`、`ReadyProof`、planned `AnchorTransferCommit`、旧锚点 tombstone/current-anchor 切换；第 35 单元恢复应用、disaster-recovery commit、domain-reset/reenroll、凭据轮换及灾难恢复旅程；第 36～38 单元；多目标 quorum、云存储、连续同步、通用事务/outbox/事件总线/registry/扫描/备份框架、监控、诊断、benchmark 和信息采集

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| `packages/core/src/authority/artifact-retention.ts`、`contracts/*`、`resources/storage-maintenance.ts` | core 类型、retention 分类、lifecycle index 与 governor 消费者、导出及直接测试 | 类型检查、分类/index/governor 定向合同测试 | 通过 |
| `packages/mesh/src/full-checkpoint.ts`、`checkpoint*.ts`、`bootstrap-authority.ts`、`recovery-package.ts`、`index.ts`、package/tsup | full capture、crypto、owner/service/target、恢复包和公开导出闭包 | mesh 定向合同/故障测试与导出检查 | 通过 |
| `packages/mesh/src/paired-checkpoint-target.ts` 与 CLI pairing/bootstrap 相关实现 | paired transport、staging、onboarding receiver 与生产装配 | pairing/target/response-loss 定向测试 | 通过 |
| `packages/cli/src/serve/backup-*`、`access-surface.ts`、`mesh-runtime-*`、`command.ts`、`index.ts`、management facade | backup setup/verify/status、两生产根、可选 owner 与无回显输入 | CLI/assembly/TTY/serve 定向测试 | 通过 |
| `packages/server/src/context.ts`、`rpc/methods/server*`、canonical registry golden | `/status`/`server.info` 公开 DTO、registry 派生资产 | server 定向测试与 golden 检查 | 通过 |
| 两份 distributed-runtime 架构/规格文档 | 当前 S9 合同、兼容和后继边界与实现全等 | 文档—合同逐项对账 | 通过 |
| `scripts/s7-entry-coverage.mjs`、`.test.mjs` | 生产入口/角色 exact-set、owner/receiver 与 golden 消费 | S7 直接测试和 lint | 通过 |
| `packages/mesh/src/__tests__/full-authority-checkpoint.test.ts` 及 CLI/server 直接测试 | U33-01～U33-12 的必要证据闭包 | 按问题验收逐项反绑，不扩成包全测 | 通过 |
| 3 个 `research/design/workbench/` 路径 | 仅流程状态与历史归档，不影响功能派生资产 | 核对不进入交付指纹 | 不适用:流程账本不参与功能通过判定 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| full capture 与 retained artifact closure | `AuthorityCommitLog` 冻结前缀 + `ArtifactLifecycleIndex` + retention 分类原语 | 同一 `DurableLogCheckpoint` 后、created 前形成可验真闭包 | index 落后/损坏、删除竞争、缺 ref、共享/嵌套/大资产 | owner/capture → checkpoint service/verify/readiness | 不递归包含 checkpoint；分页/chunk 有界 | 通过 |
| root/chain generation 与 readiness | lifecycle created/verified 事实及 payload root/chain/source prefix | candidate identity 创建及 verified 投影 | 同日 rotate、同 root 链变化、丢响应、重启 | owner/service → status、后继窄接缝 | 每 generation 唯一且旧代不计 current ready | 通过 |
| candidate single-flight | owner 当前执行事实 | 按 candidate identity 加入或拒绝 | daily/forced 双序与重放 | daily/forced producer → 内部 forced consumer | 同 key 恰一执行，不同 key 稳定拒绝 | 通过 |
| target binding 与 checkpoint lifecycle | 耐久 target binding map + lifecycle facts | owner 按 targetId 解析并重驱至终态 | 目标切换、旧 target 离线、效果后丢响应、重启/到期 | setup/owner/service → verify/cleanup/status | 旧 binding 只保留未终态义务；source-local 与 target retention 事实分层 | 通过 |
| storage governor 与 lifecycle abort | current anchor storage governor + owner abort signal | 每个物理 I/O step 前取得 permit | 大资产、容量/磁盘不足、网络挂起、stop | capture/CAS/target/transport → owner lifecycle | 总驻留与 permit 同界；permit 不跨网络或 authority/store 锁 | 通过 |
| directory/paired root 与文件身份 | 冻结 root binding、opened handle identity、durable progress | no-follow handle-relative operation、同 handle fsync、exact-set 核对后推进 | parent/root/file 替换、begin 崩溃、乱序/丢响应 | 两 target adapter → owner/service | staging/文件集合有界且可重驱，根外零副作用 | 通过 |
| compatibility、秘密输入、公开状态与可选 owner | v1/v2 codec、TTY secret reader、status owner、backup runtime state | 严格 decode/无回显读取/稳定 DTO/owner unavailable | 旧包、非 TTY、原始错误、坏配置/离线 target | CLI/mesh/server → 用户与现有 S2 replay | 零秘密输出；可选失败不阻塞 serve | 通过 |
| S7 生产 exact-set 与必要证据 | 实际 registrar/topology descriptor + 真实 log/store/index 场景 | lint/golden 与直接场景验收 | 删除/错角色/错顺序/绕过、门禁绿色假通过 | CLI/mesh/server producer → S7 gate/提交门禁 | 有限入口集合与两生产根小表，不建笛卡尔积 | 通过 |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。整表须覆盖固定边界、全部交付文件、关键原语和九类核查面。
>
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |
| R33-01 | full capture 与 retention 闭包 | core retention/index；mesh full capture/owner/service；真实 log/store/index 测试 | `c66cd68d…`（32 文件内容清单） | 相关分类、index、capture 或验证输入变化 | 失效 | 0/2 | U33-01 专项修复与直接证据通过；输入已变化，待后续正式独立审查 |
| R33-02 | root/chain generation 与 current readiness | lifecycle facts、recovery payload、status/readiness、rotate/重启测试 | `c66cd68d…`（32 文件内容清单） | identity、verification、readiness 输入变化 | 失效 | 0/2 | U33-02 专项修复与直接证据通过；输入已变化，待后续正式独立审查 |
| R33-03 | daily/forced candidate 关联 | owner single-flight、daily/forced producers 与双序测试 | `c66cd68d…`（32 文件内容清单） | owner active identity 或 forced 接缝变化 | 失效 | 0/2 | U33-03 专项修复通过；P2 边界与第 34 单元排除保持不变 |
| R33-04 | target binding、重驱与 retention | binding config、target resolver、owner/service、setup/status/cleanup | `92953a6e…`（22 文件内容清单） | target 配置、resolver、lifecycle/cleanup 输入变化 | 失效 | 0/2 | U33-04 已在专项指纹上修复并通过直接验证与四路对抗；生产输入已变化，待后续独立审查 |
| R33-05 | I/O 资源治理与 stop | governor、capture/CAS、directory/paired transport、lifecycle signal | `92953a6e…`（22 文件内容清单） | 物理 I/O、permit 或 stop 顺序变化 | 失效 | 0/2 | U33-05 已在专项指纹上修复并通过直接验证与四路对抗；生产输入已变化，待后续独立审查 |
| R33-06 | root/file identity 与 durable progress | directory/paired adapter、staging、fsync/progress、故障测试 | `c66cd68d…`（32 文件内容清单） | root binding、open/fsync/progress 输入变化 | 失效 | 0/2 | U33-06 专项句柄桥、adapter 直接验证与同指纹物理身份对抗通过；因生产输入变化，留待后续正式独立审查 |
| R33-07 | paired result 严格解码 | result codec、pairing socket/client 与命令关联断言 | `c66cd68d…`（32 文件内容清单） | codec 或任一推进字段变化 | 失效 | 0/2 | U33-07 专项修复通过；P2 价值边界未扩大 |
| R33-08 | v1 recovery package 兼容 | recovery codec、backup/pairing 入口、S2 mesh-ready replay | `c66cd68d…`（32 文件内容清单） | v1/v2 codec 或旧 replay 消费路径变化 | 失效 | 0/2 | U33-08 专项修复通过；v1 仍只产生 S2 mesh-ready |
| R33-09 | 恢复秘密输入边界 | backup verify/pairing CLI、TTY reader、输出与错误路径 | `c66cd68d…`（32 文件内容清单） | 输入 reader 或 CLI 输出路径变化 | 失效 | 0/2 | U33-09 专项修复通过；两入口共用无回显 reader |
| R33-10 | 公开状态与稳定错误 | owner status、server.info、CLI status、verification failure | `92953a6e…`（22 文件内容清单） | DTO、认证边界或错误映射变化 | 失效 | 0/2 | U33-10 已在专项指纹上修复并通过直接验证与四路对抗；既有泄露裁决未恢复，待后续独立审查 |
| R33-11 | 可选 backup owner 与普通业务隔离 | CLI/server 两生产根、配置解析、paired runtime 与 unavailable 状态 | `c66cd68d…`（32 文件内容清单） | 组合根装配或错误边界变化 | 失效 | 0/2 | U33-11 专项修复通过；availability 与 trust/root fail-stop 分层 |
| R33-12 | 入口 exact-set 与必要恢复证据 | S7 capture/validator/golden、实际 owner/receiver/CLI descriptor、两生产根小表 | `c66cd68d…`（32 文件内容清单） | 生产入口、角色、门禁或必要证据变化 | 失效 | 0/2 | U33-12 专项修复、S7 与两个 P0 小表通过；待后续正式独立审查 |
| R33-13 | 跨项组合推演 | R33-01～R33-12 当前输入、结论及交界 | `92953a6e…`（R33-01～R33-12 当前输入汇总） | 任一前置项边界、输入或结论变化 | 失效 | 0/2 | 三项直接交界已在专项四路对抗闭合；前置项输入变化，待后续独立审查整体重审 |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U33-01 | **P0/中。**`captureFullAuthorityCheckpoint` 把冻结前缀内全部非 checkpoint record 原样纳入，又以“≤8 MiB canonical JSON 通用 ref 递归”自行推断资产；当前 `ArtifactLifecycleIndex` 只在 surface-asset authority 内拥有真正的删除/保留投影，capture 没有读取同一冻结 source-head 的窄端口。因此已删除会话资产可被带入，非通用 JSON 或大于阈值但仍受保留的注册资产可被漏掉，随后仍能真解封并宣告 full verified。**价值裁决记录：**原 P0/大命中根因，但“需要新 capture 规划”被现有分类与 lifecycle 原语证伪；方案收窄为复用接入，改为 P0/中，重开扩面条件为现有原语无法表达任一当前必备内容类。**收敛记录（2026-08-08）：**“取当前 index”仍会与先前冻结前缀错代；必须由现有 index 提供精确 source-head 快照，若 index 已越过该头则整次 capture 以新前缀重试，禁止回退或猜测历史状态。 | coverage 标签、注册型 retention 分类和删除投影没有共享一个精确 source-head vector；通用爬取因此成为第二套保留谓词。 | **生产端：**core retention/index、current-anchor assembly、mesh capture/owner/service。**组合：**六类权威内容、会话删除、共享/嵌套/外置/大资产、index 落后/损坏/越代、缺 ref、checkpoint 防递归。**消费者：**verify/readiness及第 34 单元只读窄接缝。**异常终态：**缺类或携带已删除内容却 full-ready。**直接证据：**真实 `AuthorityCommitLog`/`ArtifactStore`/`ArtifactLifecycleIndex`，并发追加/删除与连续重启；IR33-06/07/33/36。 | 在现有 `ArtifactLifecycleIndex` 增加只读 checkpoint-retention 端口并由 current-anchor 组合根注入 capture：先冻结 index 全部 source heads，按主 `DurableLogCheckpoint` 读取恰好该前缀；只用 `classifyRetainedRecordReferences`、`collectRegisteredArtifactRoots` 及其注册型解析器生成候选传递闭包，再由 index 在同一 source-head vector 过滤 live retention。index 落后则追平到该头，损坏则既有 rebuild 后重试，已越头/任一源变化则丢弃本轮并冻结新头；禁止通用 JSON 扫描。所有 ref 逐项验 digest/bytes，checkpoint stream 不入候选；任何不可分类、deferred、缺失或损坏均在 `checkpoint-created` 前零副作用失败。验收覆盖六类、删除、共享/嵌套/外置/>8 MiB、index 落后/损坏/越代、缺 ref、并发与重启，载荷 retention 与冻结快照全等。 | 已验证 |
| U33-02 | **P0/中。**daily ID 只含 home/issuer/target/date，不含 recovery root 与 trust chain；`checkpoint-created` 未耐久冻结完整 root/chain/source identity，`status()` 又只看 recipient、verification 签名和 full envelope，不打开/反绑加密 payload 的 `trustChainHead`。同日 rotate 会复用旧 ID 冲突，同一 root 下 chain 推进后旧 verified 仍可投影 current ready。价值裁决保留 P0/中。 | root generation、chain generation、source prefix 与 request identity 没有成为 created→verified→readiness 共用的稳定代际键。 | **生产端：**owner candidate、service/lifecycle records、recovery payload/status。**组合：**同日 root rotate、同 root chain 变化、daily/forced、source prefix、fresh/exact replay。**消费者：**verify、status、`fullBackupReady`、第 34 单元窄接缝。**异常终态：**旧代误报 ready或新代无法创建。**直接证据：**响应丢失、并发、连续重启；IR33-17/22/26/29。 | 在现有 checkpoint lifecycle 定义唯一 generation binding：`rootKeyId + recipientKeyId + trustChainHead + targetId`；入口 request key 固定为 `daily:<UTC day>` 或 `forced:<requestId>`。service 先按二者 exact replay，fresh 才冻结 U33-01 的 source checkpoint，并以 `generation + request + source(logId/lsn/prefixDigest/frameEndOffset)` 派生最终 checkpointId；`checkpoint-created` 耐久写齐这些字段并与 envelope/payload 全等。verify 在同一日志事务核对 created/replicated、当前 root/chain、source 与已解 payload后写 terminal；readiness 只接受当前 root/chain 的全等 created+verified，不需持秘密重新解封。root/chain 变化使旧代只留历史，不计 current ready、不 rewrap、不提前误删。验收覆盖同日 rotate、同 root chain 推进、daily/forced、效果后丢响应、terminal replay和连续重启，新旧代及 source prefix 不混用。 | 已验证 |
| U33-03 | **P2/小。**owner 只有无 key 的全局 `#active`，forced 在 daily 运行时会加入并返回 daily checkpoint；当前没有公开 forced consumer，损失限于内部请求关联。**价值裁决记录：**原 P1 以第 34 单元未来消费者为当前损失，举证不足，降为 P2/小；重开条件为本单元出现实际 forced consumer或第 34 单元启用该接缝。 | single-flight 未绑定 U33-02 的 generation/request candidate key，不同请求被错误当成同一执行。 | **生产端：**daily/forced owner。**组合：**同 key/不同 key、daily→forced/forced→daily、响应丢失、stop/restart。**消费者：**内部 forced 接缝。**异常终态：**返回非 originating candidate但当前无公开数据损失。**直接证据：**双序与 replay；IR33-09/10/19。 | 将 `#active` 收为 `{candidateKey,promise,abort}`；candidateKey 直接复用 U33-02 的 generation+request key。同 key 加入同 promise；不同 key 立即返回稳定、可重试的 `checkpoint-candidate-busy`，不排队、不串行代替、不新增队列。完成/失败只清同 key，stop 只取消当前 key；后续同 request 由 lifecycle exact replay。验收覆盖双入口双序、同/异 key、响应丢失、stop 与重启，绝不把一个 candidate 作为另一个返回，且不启用第 34 单元消费者。 | 已验证 |
| U33-04 | **P1/中。**已有 active paired device、home 尚无恢复根时，`runBackupSetupCommand` 在严格读取恢复包前先用临时 root/recipient 连接 target；source 的 `prepareMeshRuntimeBootstrap` 会因无 recovery root 直接拒绝，target active assembly 又只在已有 `recoveryBackupPublicKey` 时注册 paired receiver，因此两端在首个 checkpoint command 前均不可达，v1 包内 legacy checkpoint/root 与 v2 包内真实 recipient 也来不及成为 transport/receiver 身份。**历史裁决继续有效：**历史 target 验证、setup 空成功、startup recover window 已闭合；cleanup 不恢复为启动门禁，也不新增 IPC/watcher/reload RPC。**本轮价值裁决记录（2026-08-08）：**保持现状会让明确支持的已有配对设备首次备份及 v1 第二 root-activation 永久不可用；删除支持会迫使用户改用目录或重新配对，体验与单目标 adapter 架构均不达标。复用现有 control plane、receiver/staging 和 coordinator 可闭合，不需第二套配对或恢复框架，维持 P1/中。**修复后同根收窄：**真实链进一步证明 source coordinator 单边提交不足以让 target 形成可重启的 root；该缺口仍属于同一 root-establishment lifecycle，不新增问题。 | paired setup 错把“已有 recovery root”这一正常 mesh ready 前提用于建立首个 root 的前置传输；package identity、current-issuer 授权、target 私有 staging 绑定、双端 root activation 与有限 topology 退役没有形成同一可重驱 lifecycle。 | **生产端：**`backup setup --device`、source mesh bootstrap、target active assembly/receiver、paired staging、`RecoveryActivationCoordinator`、现有 S7 receiver 门禁。**类型组合：**已有配对/无恢复根的 v1/v2、正确/错误 recipient、receiver 缺失/建立/退役、断连、并发、响应丢失、连续重启与 terminal replay；目录 setup、新设备 onboarding 为回归边界。**消费者：**首次 durable replica、source/target root activation、S2 mesh-ready。**异常终态：**合法 setup 在首个 I/O 前失败，或 source 已激活而 target 重启后仍无 root；错 issuer/recipient/identity 必须零 checkpoint 副作用，normal business mesh 在激活前保持关闭。**受影响审查项：**IR33-03、IR33-16、IR33-23、IR33-33、IR33-34、IR33-36。 | 将包生成/无回显回读/严格解码提前到连接前，以 v1 legacy checkpoint/root 或 v2 root/recipient 冻结真实身份；在既有 `ProductionMeshControlPlane`、service registry、paired receiver/staging 上增加仅供“已配对、无 root、current issuer”的 root-establishment 模式，只暴露现有 strict checkpoint commands，不放开普通 mesh/business service，正常 ready gate 不变。receiver 首个 begin 在现有私有 staging 耐久绑定 `{homeId,source=currentIssuer,targetId,checkpointId,recipientKeyId}`，同载荷 exact replay、冲突稳定拒绝、重启续驱；真实回读与 source coordinator 原子激活后，以同一 strict service 提交与 checkpoint plan 全等的签名 root event/trust record，target 用现有 bootstrap store 耐久验真，效果后丢响应由 active receiver 只读 exact replay，有限连接完成应答后退役并重载正常 topology。同步现有 S7 有限 descriptor/validator 反绑该分支。验收覆盖全部上述变体：合法路径双端恰一副本/根事实且 target 重启可运行，断连/丢响应/重启可重驱，错误输入零副作用，目录 setup 与新设备 onboarding 零回归。 | 已验证 |
| U33-05 | **P2/小。**既有 O(备份总量) 驻留已由 checkpoint 专用有界 source/sink 闭合；当前残留精确限定为 `backup-command.ts` 的 backup setup client 与 `mesh-pair-command.ts` 的首次 pairing client 两处构造 `PairedRecoveryCheckpointTarget` 时未传入各自已经持有的 `storageMaintenance`，而 runtime owner 构造点已正确注入，故固定上限的 range decode 仅在两条第一方路径绕过设备唯一容量准入。**本轮价值裁决记录（2026-08-08）：**没有 O(total)、伪终态或已证实用户可见故障，不恢复原 P1/大与通用 streaming 扩面；两处一参注入即可消除生产分叉，维持 P2/小。 | paired target 的三个生产 client owner 没有共用同一构造合同；两个入口遗漏现有 governor，使有限 `network-range-decode` step 的 capacity fact 分叉。 | **生产端：**backup setup、首次 pairing、runtime owner、`PairedRecoveryCheckpointTarget`。**类型组合：**两遗漏构造点及已正确构造点、容量成功/拒绝/取消、并发 range 消费、网络等待。**消费者：**固定 range part 的 decode/消费。**异常终态：**设备饱和时两入口仍可额外占用有限 buffer/I/O；wire/chunk、总量驻留与 lifecycle 终态不在本问题内。**受影响审查项：**IR33-08、IR33-15、IR33-32、IR33-33、IR33-36。 | 在 backup command 传入 `context.capacity.storage`、首次 pairing 传入 `input.storageMaintenance`，保持 runtime owner 现状；沿用现有 target 逻辑使网络请求先完成，再仅以同一 governor 包住固定 range decode/消费，交付后释放且不跨网络、authority/store/lifecycle 锁。不改 wire/chunk、完成值或 source/sink。验收直接穿过两生产构造，覆盖准入拒绝/取消/成功与并发消费，并证明网络等待零 permit、固定 buffer 受唯一 governor 约束、既有有界语义不回退。 | 已验证 |
| U33-06 | **P1/大。**directory/paired staging 已冻结 configured/owned root并拒绝 root link/reparse，最终文件也有 no-follow handle 复核；但 root 首次 `ensureDurableDirectory`及全部 child `mkdir/open/rename/rm`仍由字符串路径发起，父目录 `assertCheckpointDirectoryIdentity` 与副作用不是同一系统调用，最终 handle 不能阻止父组件在间隙被 symlink/junction/reparse/rename 替换。**既有价值裁决记录：**额外文件与 staging retention 未满足 P1 重开条件，不得恢复；P1仅覆盖物理身份与 progress。**独立审查重开与价值裁决记录（2026-08-08）：**新父目录 TOCTOU 触发同根重开。**本次收敛记录（2026-08-08）：**仓库的 Node 22 `fs` 表面没有 dir-handle-relative create/rename/unlink，且无既有 native bridge；仅改 TypeScript 无法满足零根外副作用。锁定方案因此必须含 mesh 包内专用跨平台句柄桥，工作量由中～大核定为大；它只暴露 checkpoint 固定操作，不得扩成通用文件系统框架。 | 安全边界冻结了“路径所指对象”，root 建立与 child I/O却仍按可再次解析的路径执行；缺少把 parent identity 与副作用原子绑定的 OS 原语。 | **生产端：**directory setup/open、directory target、paired staging/receiver及其 publish/retire/cleanup。**组合：**configured root 创建、configured/owned parent 在每个边界被 symlink/junction/reparse/rename 替换、最终文件替换、越根、响应丢失与重启。**消费者：**owner/service续传、验证和 cleanup。**异常终态：**根外创建、正文、发布或删除已经发生后才被事后检查发现。**直接证据：**当前 `freezeCheckpointDirectory(..., true)`、`checkpoint-target.ts`/`paired-checkpoint-target.ts` 的 assert→字符串系统调用及 IR33-12/13/15/31/32/33/36。 | 保留 frozen binding，在 `@zhixing/mesh` 内增加唯一 checkpoint-child native bridge：POSIX 用冻结 dirfd 的 `mkdirat/openat/openat2 + renameat + unlinkat + fsync`（逐组件 no-follow/beneath），Windows 用冻结 filesystem/drive root handle起步的 `NtCreateFile(RootDirectory)`、handle rename/disposition、FileId/volume/reparse 复核与 flush。配置路径不存在时只由该桥从已打开 filesystem root逐组件创建/打开并拒绝链接；已存在时直接冻结最终 handle。桥随后只接受已校验单组件名并提供 mkdir/open/read/write、同父/双父 rename、已知 exact-set 递归删除和 sync；两 adapter 禁止再对 root/child 调用路径版 create/open/rename/rm。运行中路径替换只能改变名字，不能改变冻结对象；child nlink/type/identity、同 handle fsync 与 exact-set 成功后才追加 progress。验收逐格覆盖 F33-24～F33-26，在 POSIX 与 Windows 实际于 root 建立及每个 child 调用前替换 parent/final file，证明根外零创建/正文/发布/删除、漂移零 progress，正常 commit/read/retire及连续重启零误杀；不恢复额外文件主张。 | 已验证 |
| U33-07 | **P2/小。**普通 mesh transport 会调用 `assertPairedResult`，pairing socket 只核对外层 frame 后把内部 result 强转；现有 target 客户端随后已逐命令反绑 type、checkpointId、seq/offset/progress、bytes/digest，因此当前额外字段不会错误推进 activation。**价值裁决记录：**原 P1 的“跨命令结果可推进”被现有断言证伪，降为 P2/小；重开条件为发现任一未手工反绑字段可影响 durable/activation。 | 同一 wire 联合在普通 mesh 与 onboarding pairing socket 走了不同 decoder，严格 exact keys 形成双实现。 | **生产端：**paired result codec、Mesh transport、pairing socket transport。**组合：**begun/progress/appended/stored/manifest/range/retired、额外/缺失字段及错关联。**消费者：**paired target client。**异常终态：**当前仅严格性分叉，无错误 activation。**直接证据：**IR33-04/05/14/31。 | 从现有 paired module 导出唯一严格 result decoder；普通 mesh 与 pairing socket 都在返回给 client 前调用它，client 继续反绑 originating command 的 checkpointId/seq/offset/progress/bytes/digest/supersededBy。验收覆盖全部合法 state、额外/缺失字段、错 command/checkpoint/seq/offset/progress/digest，非法结果零 progress、合法两 transport 零误杀。 | 已验证 |
| U33-08 | **P1/小。**v1 recovery package 的 `legacyCheckpoint` 已由 codec 严格解出，但 backup 初次 root 与 pairing root-activation 都只取 `decoded.root`，随后另造 full checkpoint；旧包内 S2 trust-only checkpoint 从未交给已经能同时打开 full/trust-only 的 `RecoveryActivationCoordinator`。价值裁决保留 P1/小。 | 兼容 payload 停在 codec，未接回现有 S2 root-activation replay 线性化点。 | **生产端：**recovery codec、backup initial-root、pairing onboarding。**组合：**v1 legacy、v2 secret-only、未知版本、fresh/exact replay。**消费者：**既有 S2 mesh-ready 投影。**异常终态：**旧包解码成功却效果丢失或被错误当 full。**直接证据：**响应丢失/连续重放及 readiness 隔离；IR33-03/34。 | 新 encoder 继续只产 v2。两个 root-activation 入口解码后：存在 `legacyCheckpoint` 时校验其 root-activation plan、issuer、candidate root 与当前 chain，直接把该 checkpoint 交给现有 `RecoveryActivationCoordinator.activatePrepared`，使用当前受限 directory/onboarding target 做幂等 write/read/commit；不存在时才走新 full capture。legacy terminal 只维持既有 mesh-ready，绝不产生 `fullBackupReady`，普通 periodic `backup verify` 也不得把 v1 当 full。验收覆盖 v1 fresh/效果后丢响应/terminal replay、v2 无 legacy、未知版本拒绝和 mesh-ready/full-ready 隔离。 | 已验证 |
| U33-09 | **P1/小。**backup verify 与 pairing 回读均用 `readline.question`；backup 虽先检查 TTY，输入仍回显，pairing 连非 TTY 也未 fail-closed。价值裁决保留 P1/小。**收敛记录（2026-08-08）：**仓库没有可直接复用的成品 secret-line reader；可复用的是现有 stdin ownership/raw-mode/key-event 原语，故方案收窄为一个 recovery-package 专用 reader，不能假定不存在的机制。 | 高熵恢复秘密没有共享一个无回显、可取消、可清零的 TTY 输入边界。 | **生产端：**backup verify/initial root 与 pairing root 回读。**组合：**TTY/非 TTY、paste/backspace/enter、取消/异常。**消费者：**recovery decoder。**异常终态：**用户粘贴秘密进入屏幕、录屏或终端缓冲。**直接证据：**IR33-21/31。 | 在 CLI 现有 stdin ownership、raw-mode 与 key-event 原语上实现单一窄 `readRecoveryPackageFromTty`：只接受 TTY，提示不渲染字符，支持 paste/backspace/Enter/Ctrl-C，累计到有界可变 buffer并直接交 recovery decoder，finally 清零；两入口共用，非 TTY/取消返回稳定可行动错误。验收覆盖 TTY 成功、非 TTY、取消、异常及两入口，除创建流程有意的一次性展示外，输入秘密不进入 stdout/stderr/错误/日志且 buffer 清零。 | 已验证 |
| U33-10 | **P1/小。**`ConfiguredCheckpointOwnerSlot.status()` 在 current target 离线或 paired runtime 缺失时直接返回 `unavailable, fullBackupReady:false`，绕过 `AuthorityCheckpointService.status()` 对同一 `AuthorityCommitLog` 中 created+replicated+verified 与本地 full envelope 的耐久投影；即使 slot 保留 true，`projectRecoveryBackupStatus()` 对 unavailable 又会再次硬编码 false，而独立 `backup status` 已用 metadata-only target 得到正确耐久结论。**历史裁决继续有效：**公开 DTO 已移除内部身份/raw error，原泄露主张与扩面方案不恢复。**本轮价值裁决记录（2026-08-08）：**把 readiness 等同目标在线会让已验证恢复能力随断网、睡眠和进程重启漂移并误导用户；复用现有只读逻辑并修正一个消费者即可闭合，维持 P1/小。 | target operational availability 与 durable backup readiness 在 service、degraded slot、public projector 三处被分别决定，未共享同一个以 current generation 为输入的只读投影。 | **生产端：**checkpoint service、configured owner slot、公开 `projectRecoveryBackupStatus`、CLI `backup status`、`server.info`。**类型组合：**verified/unverified、target 在线/离线、paired runtime 缺失、进程重启/重连、root/chain/target generation 变化、配置/绑定不可解析。**消费者：**CLI、认证 RPC 与用户恢复判断。**异常终态：**同一耐久备份被在线路径报 ready、离线路径报 not ready；身份矛盾仍须 fail-stop。**受影响审查项：**IR33-22、IR33-23、IR33-28、IR33-33、IR33-34、IR33-36。 | 从现有 service `status()` 抽取唯一只读 readiness projector，输入限定为 authority log、本地 ArtifactStore、current trust/anchor 与 current target generation；service 和 slot 共用它。配置与身份可解析但 target/runtime unavailable 时，slot 返回 `state:unavailable` 同时保留 projector 的 `fullBackupReady`；公开 projector 原样保留该布尔值而不再硬编码 false。无配置、绑定不可解析、generation 不匹配、缺 verified/full envelope 时为 false，trust/root/member 矛盾维持 fail-stop。验收覆盖在线→离线→重启→重连、runtime 缺失、未验证代、root/chain/target 变化，并证明 CLI/server 对 readiness 同源、availability 独立降级、公开 exact keys 与错误隔离不回退。 | 已验证 |
| U33-11 | **P1/小。**`createConfiguredCheckpointOwner` 在 server ready 前解析目标并创建 paired adapter；binding 缺失、坏配置或缺 mesh runtime 会抛出，使可选备份故障阻断普通 serve，离线 target 也没有可持续的 unavailable owner 状态。价值裁决保留 P1/小。 | 可选 target/config 的可用性错误与 home trust/root 身份破坏共用组合根异常通道。 | **生产端：**single-machine/current-anchor 与 anchor+executor 两根、backup runtime/config、paired target。**组合：**未配置、坏配置、target 离线、runtime 缺失、trust/root/member 损坏、reload。**消费者：**普通会话与 backup 命令/status。**异常终态：**可选故障使全服务不可用或静默无状态。**直接证据：**IR33-23/34。 | 在现有 CLI 组合根建窄 backup runtime slot：`disabled | available(owner) | unavailable(code)`，只包装 checkpoint owner，不做通用插件框架。无配置为 disabled；配置解析、target 离线或 paired runtime 暂不可用进入 unavailable，普通 server 继续 ready；slot 在 startup recovery、daily/forced、verify/status 与重试 turn 前重载配置并周期重试，`backup setup` 自身完成新 binding 的首次创建/复制，不新增唤醒通道。backup 命令/status返回稳定 action。home trust 不可重放、issuer/member/root key 身份矛盾仍在 server ready 前 fail-stop，禁止降级。验收覆盖两生产根的三类可用性故障与恢复、普通会话仍可用、下一既有入口 reload 生效，以及 trust/root 损坏仍阻断。 | 已验证 |
| U33-12 | **P1/中。**S7 `recovery-backup` 组只从 Commander 捕获 setup/verify/status；daily/forced 与 paired put/get/retire 没有生产 descriptor，owner/receiver 仅被 token/字符串启发式检查。直接测试也没有真实 lifecycle index 的 U33-01 retention 分叉与 U33-02 root/chain readiness，故门禁可在两个 P0 存在时保持绿色。**价值裁决记录：**原方案“覆盖 P33-01～P33-11”可能扩成重复矩阵，现收窄为实际入口 exact-set 与 P0 必要证据，维持 P1/中；重开扩面条件为新增生产入口或现有直接证据无法覆盖另一个阻断根因。 | 标签/happy path 代替有限生产注册源 exact-set 与两个核心恢复不变量，结构门禁和提交证据没有同一来源。 | **生产端：**setup/verify/status、owner daily/forced、paired put(begin/progress/append/commit)/get(get/range)/retire、onboarding/active receiver、两生产根。**组合：**角色、顺序、删除、重复、错 owner、绕过。**消费者：**S7 lint/golden与直接验收。**异常终态：**入口漂移或 P0 数据缺口不被拒绝。**直接证据：**IR33-30/33/36。 | 保留现有 S7 lint：Commander CLI 继续由真实注册捕获；checkpoint owner 与 paired receiver 各导出并实际驱动一个冻结窄 descriptor，分别声明 daily/forced 和 put/get/retire 的 wire phase exact-set、owner/role与顺序，S7 只解析这些有限 literal并与架构 row/golden 双向全等，删除/重复/错角色/错序/旁路均失败。直接证据只增加两张小表：真实 log/store/index 的六类 retention+删除，以及 directory/paired 两生产 profile 的 root/chain rotate readiness；其余 codec/target/TTY/status 场景复用各问题直接测试。验收要求实际生产变异 fail-closed、合法拓扑零误杀；不建新 lint/runner、全问题复制矩阵或配置×故障笛卡尔积。 | 已验证 |

| U33-13 | **P2/小。**`checkpoint-superseded` 已在 verification 同一 CommitEnvelope 内使 source-local `checkpoint:<id>` owner 死亡，`ArtifactLifecycleIndex` 可于通用 24 小时 GC 后释放本地 CAS；独立 target 仍由 service 依据同一 superseded fact 保留 27 天。当前 `cleanupExpired`却在 target retire 后再查本地 retention并追加 `local-released`，该晚到事实不控制实际释放。**价值裁决记录（2026-08-08）：**原 P33-16 以“本地与 target 都须保留 27 天”评 P1/小～中；生产事实证明 source-local 只是同设备缓存，独立 target 才是恢复副本，故降为 P2/小。只有证明 source-local 是唯一独立恢复源，或 target 可在 27 天前消失且只能靠它恢复，才重开 P1。**本次收敛记录（2026-08-08）：**原方案在“superseded 或同 envelope 即时 local-released”之间留了两种实现；现唯一确定 `checkpoint-superseded` 为 source-local release fact，历史 `local-released`只兼容读取、当前不再生产。 | 同一 source-local 所有权存在 superseded、GC 和 27 天后 local-released 三个不同时间点；独立 target retention 与本地 cache release 被错误共用一个 progress 阶段。 | **生产端：**checkpoint verification/cleanup、checkpoint reducer、`ArtifactLifecycleIndex` classifier与通用 GC。**组合：**verified→superseded、24 小时 local GC、27 天 target retire、共享业务 ref、丢响应和连续重启。**消费者：**cleanup/status、审计与恢复判断。**异常终态：**恢复副本安全但 lifecycle 对本地释放时间陈述失真。**直接证据：**`deletedConversationOf(checkpoint-superseded)`、`cleanupExpired`及 IR33-25/32/33/36。 | 同步总纲/规格与 reducer：`checkpoint-superseded`是唯一当前 source-local release fact并继续驱动 LifecycleIndex；`cleanupExpired`删除 local retention 查询和新 `local-released`写入，只在满 27 天后按 created.targetId 幂等 retire target并写 `target-retired`。为已有日志保留 `local-released` decoder/record key，但将其视为兼容 no-op，不参与 retention、status或完成判断。验收逐格覆盖 F33-27～F33-29：supersede 后 24 小时本地 GC、27 天前 target 仍可读、离线 retire 重试、共享业务 ref零误删、verification/retire 丢响应与连续重启；本地与 target 各自恰一事实且不新增清理器。 | 已验证 |

## U33-04、U33-05、U33-10 重开收敛固定矩阵

| 编号 | 问题与直接变体 | 生产 owner / 捕获输入 | 稳定身份与耐久事实 | 零副作用边界与消费终态 | 直接验收 |
| ---- | -------------- | -------------------- | -------------------- | -------------------------- | -------- |
| F33-30 | U33-04：已有配对设备、无 root、v2 首次 setup | backup command 的包生成/无回显回读；source root-establishment bootstrap；target active assembly | 严格解码后的 `{homeId,currentIssuer,targetId,checkpointId,rootKeyId,recipientKeyId}`；首个 begin 写入既有私有 staging；签名 root event/record 双端提交 | 连接前冻结包内 identity；仅 current issuer 可建立有限 transport；target 根事实耐久前普通 mesh/business service 关闭 | 真实 source/target 生产装配完成 v2 首份复制、回读、source coordinator 与 target trust 提交；临时生成 identity 与回读不一致稳定拒绝 |
| F33-31 | U33-04：v1 legacy package、第二 root-activation | 同一 backup setup reader/codec、legacy checkpoint source、既有 coordinator | v1 包内 legacy checkpoint/root/recipient 为唯一身份，不使用预生成 v2 候选；streamed legacy 正文仅在既有有界兼容边界物化 | v1 只驱动既有 S2 trust-only replay；错 checkpoint/recipient 零 staging/progress/root fact | 正确 v1 双端恰一激活；错 recipient、坏签名、异载荷 replay 均在 checkpoint 或 root 副作用前失败 |
| F33-32 | U33-04：source/target 无根可达、receiver 缺失/建立/退役 | 既有 `ProductionMeshControlPlane`、service registry、paired receiver/staging、S7 descriptor | active member + current issuer + no-root mode；正常 active receiver 与 root-establishment receiver 复用同一 strict command/result identity | 有限模式只暴露 checkpoint service；签名激活应答完成后退役并重载正常 topology；正常 ready gate 不放宽 | 无 root 时普通 session/业务 RPC 不可达而 checkpoint strict command 可达；激活后有限分支消失，active receiver 只接受 exact terminal replay，S7 对缺失/重复/错角色失败 |
| F33-33 | U33-04：断连、并发 begin、响应丢失、重启与 terminal replay | target 私有 staging 的 begin/progress/append/commit/get/range/activate-root；source setup 重试 | staging 首次耐久绑定 `{homeId,source,targetId,checkpointId,recipientKeyId}`；双端 terminal 由 source/target 各自 trust log 判定 | 同身份 exact replay；冲突 begin/activation 稳定拒绝；部分 I/O 不激活；效果后丢响应由 active receiver 零副作用复核 | begin/commit/双端 activation 各效果前后注错，双并发与连续重启最终恰一副本/双端根事实，无孤儿公开状态 |
| F33-34 | U33-04：目录 setup 与新设备 onboarding 回归边界 | directory adapter、现有 onboarding pairing socket/receiver | 各自既有 target binding 与 onboarding request identity | 新有限模式不替代目录或首次配对，不创建第二 receiver/coordinator | 两既有生产链行为与状态全等；无新增 IPC/watcher/reload RPC，cleanup 仍为后台 |
| F33-35 | U33-10：current generation 已 verified，target 在线/离线/runtime 缺失/重连 | `AuthorityCheckpointService.status`、owner slot、public projector、CLI status | current `{rootKeyId,chainHead,targetId}` + log 中 created/replicated/verified + 本地 full envelope | availability 可为 unavailable；durable readiness 始终由同一投影为 true | 同一日志在线、断连、进程重启、runtime 缺失、重连的 CLI/server readiness 全等，state 仅按操作可用性变化 |
| F33-36 | U33-10：unverified、配置/绑定坏、root/chain/target 变化 | 同一只读 projector 与 slot reload | current generation 是唯一查询键；旧 verified 不计当前 ready | 无 verified/full envelope 或 generation 不匹配为 false；trust/root/member 矛盾 fail-stop | 未验证代、旧 root/chain/target、坏配置和身份矛盾逐项得到稳定 false/fail-stop，无 raw error/内部身份泄漏 |
| F33-37 | U33-10：CLI/server 同源与 public unavailable 映射 | metadata-only CLI service、configured slot、`projectRecoveryBackupStatus` | projector 输出的 `fullBackupReady` 为唯一耐久布尔；public state 是独立可用性投影 | public mapper 不覆盖 readiness；DTO exact keys、稳定 code/nextAction 保持 | 直接变异 mapper 硬编码、slot 绕过 projector、service 分叉均失败；合法 unavailable+ready 不误杀 |
| F33-38 | U33-05：backup setup paired client | `backup-command.ts` 的 `context.capacity.storage` 与 target constructor | 当前设备唯一 storage governor 实例 | 网络 range 先完成；permit 只包 `network-range-decode`/消费并释放 | 构造参数 exact identity；容量拒绝零 decode、取消稳定退出、成功释放 permit |
| F33-39 | U33-05：首次 pairing paired client | `mesh-pair-command.ts` 的 `input.storageMaintenance` 与 target constructor | pairing 所在设备同一 governor 实例 | 与 runtime owner 已正确构造点全等；不改 wire/chunk/source-sink | 三个生产 client 构造对账，仅两遗漏点发生修正；并发 range 受同一容量上界 |
| F33-40 | U33-05：网络等待、固定 range buffer、并发消费 | `PairedRecoveryCheckpointTarget.#decodeRange` 及现有 maintenance step | 每次 part/request identity + 固定 range limit | 网络、authority/store/lifecycle 锁期间零 permit；decode/交付完成或异常均释放 | 在真实 transport 边界注入网络挂起、拒绝、取消、decode 失败和并发成功，permit 轨迹符合边界且不恢复 O(total) 主张 |

## U33-04、U33-05、U33-10 重开收敛反证账

| 编号 | 首次反证与归属 | 耐久处置 |
| ---- | -------------- | -------- |
| C33-C36 | U33-04：只把 package readback 提前仍无法连接，因为 source 正常 mesh bootstrap 在无 root 时先拒绝 | 保留正常 ready gate；在现有 control plane/registry 上增加 current-issuer、checkpoint-only 的有限 root-establishment bootstrap |
| C33-C37 | U33-04：只修 source 仍无消费者，target active assembly 仅在已有 recovery key 时注册 receiver | 复用同一 paired receiver/staging 增加 no-root mode，首个 begin 耐久绑定 package identity，激活后退役；现有 S7 有限门禁反绑该分支 |
| C33-C38 | U33-04：v1 package 若在连接后才解码，连接仍绑定无关的预生成 v2 recipient/checkpoint | v1/v2 均先严格解码再连接；后续 transport、staging 与 coordinator 全程只用包内真实 identity |
| C33-C39 | U33-10：仅让 owner slot 计算 readiness 仍会被公开 mapper 对 unavailable 强制改回 false | service/slot 共用唯一只读 projector，public mapper 原样保留 projector 布尔值，availability 仅决定 state/code |
| C33-C40 | U33-05：paired target 共有三个生产 client owner，宽泛按类修正无法证明遗漏闭合 | exact-set 对账定位 backup command 与首次 pairing 两处缺参，runtime owner 保持；直接测试反绑各自现有 governor |
| C33-C46 | U33-04：v1 legacy 包复制到 paired target 后，真实回读返回有界 `ChunkSource`；coordinator 若仍只接受 materialized chunks，会在真解封处失败 | 在既有 bootstrap 兼容边界逐块读取并临时物化 trust-only checkpoint，finally 清零；transport/staging/coordinator 仍只消费包内 checkpoint/root/recipient，不改变 full checkpoint 有界 source/sink |
| C33-C47 | U33-04：source coordinator 原子激活只更新 source trust，target 没有耐久 root fact；进程重启后 target 仍停留无根有限 topology | strict service 新增与已存 checkpoint plan 全等的签名 root-activation command；target 复用 `FileMeshBootstrapStore` 原子验真提交，source/target 各自以同一 event/record 达到唯一终态 |
| C33-C48 | U33-04：target 提交根后若应答丢失，普通 active receiver 原先拒绝 activation；有限 control 的 trust watcher还会抢先断开，应答后 topology也不会自动切回业务服务 | 仅有限 source/target connection 禁用 trust watcher并在应答后等待 issuer 断开；active receiver 只允许本地 trust 的 exact terminal replay；serve 重载 bootstrap 后进入原正常 topology，普通业务在 target 根提交前始终关闭 |
| C33-C49 | U33-04：实现和新增边界段已声明 `activate-root`，但 S9 总述与规格 descriptor exact-set 仍只列到 retire，文档与生产门禁可能再次分叉 | 同步两处现行措辞为 begin/progress/append/commit/get/range/retire/activate-root，并限定 finite commit/active exact replay；现有 S7 17/17 与 golden 在最终输入复核通过 |

## U33-04、U33-05、U33-10 四路冷启动对抗复审

> 基线为上方同一份未修改问题列表、F33-30～F33-40 与 C33-C36～C33-C40；本轮抛开此前审查结论，从权威合同和当前生产源码重新构造反例，不修改实现、不运行构建或测试。

| 冷启动角色 | 独立推导与主动反例 | 结论 |
| ---------- | ------------------ | ---- |
| paired 首次 root establishment 与 v1/v2 coordinator 边界 | 从“无 root 时 business mesh 必须关闭、但已有配对设备必须能建立首份副本”同时推导 source bootstrap 与 target receiver 两个必要有限分支；重造临时 v2 identity、v1 legacy identity、错 issuer/recipient、receiver 缺失、并发 begin、断连/丢响应/重启及激活后迟到命令，并与目录 setup、新设备 onboarding 双向对账 | 通过。U33-04 已命中前置 transport/receiver 与 package identity 的共同 lifecycle 根因；方案只复用现有 control plane/registry/receiver/staging/coordinator，正常 ready gate与普通业务关闭不变，全部反例有稳定终态 |
| target availability 与 durable readiness 投影 | 从 AuthorityCommitLog 的 created/replicated/verified 和本地 full envelope独立推导 readiness；重造 target 在线→离线、paired runtime 缺失、slot 重启/重连、未验证代、root/chain/target 变化、坏配置及 public mapper 硬编码 | 通过。U33-10 已同时覆盖 service、degraded slot 和 public mapper 三个分叉点；availability 与 readiness 分层，CLI/server 同源，既有 DTO/错误隔离不回退 |
| paired capacity admission 与 permit 生命周期 | 枚举全部三个生产 `PairedRecoveryCheckpointTarget` 构造，确认仅 backup command 与首次 pairing 缺 governor；重造容量拒绝/取消/成功、网络挂起、decode 失败与并发 range，检查 permit 是否跨网络或外层锁 | 通过。U33-05 精确闭合两个遗漏点与现有 target step；工作量 P2/小有事实依据，未恢复 O(total)、wire/chunk 或通用 streaming 方案 |
| 产品体验、范围价值与历史裁决边界 | 反向比较保持现状、删除 paired 首次恢复、复用现有机制和新增框架；核查 U33-04↔U33-10 的激活后 readiness、U33-04↔U33-05 的有限 transport 容量、U33-10↔U33-05 的独立事实源，以及三项↔EX33-01/第34～38单元 | 通过。两个 P1 分别阻断明确受支持路径或持续误报核心恢复能力，P2 仅消除必要容量合同分叉；cleanup 启动门禁、O(total)、内部状态泄露、路径表与后继 transfer/恢复/同步/生命周期能力均未恢复或提前并入 |

- **交界差异审计**：U33-04 激活成功后由 U33-10 的同一 current generation 投影 readiness；U33-04 的有限 paired transport 复用 U33-05 已受治理的 target client；U33-10 不以 target buffer 可用性决定耐久事实。C33-C36～C33-C40 均已同根合并，无未处置反证。
- **同一版本结论**：问题列表无需再修改即可交付执行；U33-04、U33-10 保持 P1/中、P1/小，U33-05 保持 P2/小，三项状态均为待修复。

## U33-04、U33-05、U33-10 修复后专项收口（2026-08-09）

> 本节只证明三项问题在同一份未修改交付物上完成实现、最小必要验证和专项对抗；不计入全单元冻结终审、独立功能审查或单元提交验证。

- **冻结指纹**：`92953a6e3f7d5cd179f9c5c5a933f844487036541d5710b2d4effaab7a4e488e`；22 个非工作台交付文件，算法见“当前状态”。
- **实现落点**：U33-05 将 backup setup、首次 pairing 与 runtime owner 三个 paired client 精确反绑同一设备 governor；U33-10 抽取 current-generation 耐久 readiness projector，并由 service、unavailable slot 与 public mapper 共用；U33-04 将 v1/v2 包内 identity 冻结提前到连接前，以既有 control plane、strict receiver/staging 与 coordinator 建立 current-issuer-only 的无根有限通道，并用与已存 checkpoint plan 全等的签名 event/record 让 target 复用既有 bootstrap store 耐久激活；效果后丢响应由 active receiver exact replay，有限连接应答后退役并重载正常 topology，激活前普通业务仍关闭。
- **范围复用**：其余 U33 问题与 EX33-01 未重开；cleanup 启动门禁、O(total) 驻留和内部状态泄露主张未恢复；第 34～38 单元能力未进入生产装配。

### F33-30～F33-40 修复后事实矩阵

| 矩阵 | 修复后事实与直接证据 | 结论 |
| ---- | -------------------- | ---- |
| F33-30～F33-34 | package readback/strict decode 先于 paired connection；v1 legacy checkpoint/root 与 v2 recipient 全程成为唯一身份；无根 topology 仅含 `mesh.endpoint`、`recovery.checkpoint`，target receiver 只授权 current issuer；staging 耐久发布五元 binding，source/target 用同一签名 event/record 提交根事实，active receiver 只接受 exact terminal replay；同载荷 replay、冲突拒绝、应答后有限 topology 退役与正常 topology 重载由真实双设备场景和 S7 变异覆盖 | 通过；已有配对设备首次副本与双端根事实可达，错误/并发/丢响应/重启保持可重驱，目录 setup 与新设备 onboarding 未被替代 |
| F33-35～F33-37 | projector 只读 current trust/anchor/target generation、AuthorityCommitLog 与本地 full envelope；available service 与 unavailable slot 共用，public mapper 保留 projector 布尔；真实 verified checkpoint 在 paired runtime 缺失时仍为 unavailable+ready，target/root/chain 改代为 false | 通过；availability 与 durable readiness 分层，CLI/server 同源，坏 binding 与身份矛盾边界不放宽 |
| F33-38～F33-40 | 三个生产 `PairedRecoveryCheckpointTarget` 构造 exact-set 分别使用 `context.capacity.storage`、`input.storageMaintenance`、`input.storageMaintenance`；网络响应先完成，固定 range decode/消费才申请 permit，成功/失败均释放 | 通过；容量拒绝/取消/网络挂起/并发消费闭合，不恢复 O(total) 或改动 wire/chunk/source-sink |

### 修复中新增反证与耐久处置

| 编号 | 新反证 | 耐久处置 |
| ---- | ------ | -------- |
| C33-C41 | 将 package readback 提前但仍用正常 mesh assembly，会在无 root gate 或普通业务 service 上产生错误放宽 | 增加独立有限 topology，精确 service set 与 current-issuer receiver 由 S7 反绑；正常 assembly 不变 |
| C33-C42 | 仅校验 begin recipient 不能保证后续 progress/commit 与首个 checkpoint 同身份 | 首个 begin 在私有 staging 耐久发布五元 binding，后续命令逐次重读反绑，冲突稳定拒绝 |
| C33-C43 | unavailable slot 即使计算出 true，public mapper 仍可二次覆盖为 false | mapper 原样保留 `status.fullBackupReady`，S7 同时核对 service/slot/mapper 三个消费者 |
| C33-C44 | 历史 root-activation `checkpoint-created` 缺 current generation/request，若直接 canonicalize 会让新 projector 与候选查询抛错 | current projector 与候选只消费显式 generation/request 记录，旧记录既不冒充 current ready，也不破坏查询 |
| C33-C45 | 只补两个遗漏构造不能证明未来同类 owner 不再分叉 | S7 枚举三个生产 client owner、精确 initializer 与数量，删除、替换或新增构造均 fail-closed |
| C33-C46 | v1 legacy checkpoint 从 paired target 真回读后只有 `ChunkSource`，coordinator 的旧 materialized-only 分支会在真解封处失败 | 仅在既有 trust-only 兼容边界逐块临时物化并清零；full checkpoint 的有界 source/sink、wire 与存储合同不变 |
| C33-C47 | source coordinator 已提交但 target 未持有 root，target 重启仍回到无根有限 topology | strict activation 反绑已存 checkpoint plan，target 用同一签名 event/record 原子写既有 trust store，提交后本地可重启验证 |
| C33-C48 | target 激活效果后丢响应会被 active receiver 拒绝，trust watcher与有限 topology 生命周期又会提前断链或停留有限态 | 有限连接关闭 trust watcher直至应答/issuer 断开；active receiver只做 exact terminal replay；serve 重载 bootstrap并进入原正常 topology |
| C33-C49 | S9 总述和规格 descriptor 行遗漏新 strict `activate-root`，即使实现/S7 绿色也会留下权威文档 exact-set 分叉 | 两处同步完整 phase 集及 finite/active 边界，最终输入 `pnpm s7:lint` 17/17 与 canonical golden 通过 |

### 同一指纹四路冷启动对抗

| 角色 | 主动重造的反例与交界 | 结论 |
| ---- | -------------------- | ---- |
| paired 首次 root establishment / v1-v2 | 无根 source/target、v1/v2 identity、错 issuer/recipient、receiver 缺失、并发 begin/activation、断连/丢响应/连续重启、active terminal replay；核对 target trust 落盘、有限 topology 退役、目录 setup 与 onboarding | 通过；唯一有限 strict transport 可达，双端根事实全等且可重驱，普通业务 gate 未放宽 |
| availability / durable readiness | verified/unverified、在线/离线、runtime 缺失、重启/重连、root/chain/target generation 变化、坏配置；核对 CLI/server mapper | 通过；current generation 耐久事实单源，availability 只改变 state/code |
| paired capacity / permit | 三构造点、准入拒绝/取消/成功、网络挂起、decode 失败、并发；核对 U33-04 有限 transport | 通过；网络零 permit，固定 decode buffer 受唯一 governor 约束 |
| 产品体验 / 范围价值 | 比较保持现状、删除支持、复用现有机制与新增框架；核对三项交界、EX33-01 和第 34～38 单元排除 | 通过；两个 P1 与一个 P2 的处理均必要且成比例，历史裁决边界未改变 |

- **直接验证**：CLI 无根 paired 真实双设备 v1/v2、target 激活与进程重启 terminal replay 2/2；CLI recovery-root/bootstrap/owner 支撑场景 9/9；mesh strict codec/有界恢复 2/2（其余 12 项按过滤跳过）；mesh `tsc --noEmit` 零错误；CLI `tsc --noEmit` 仅保留 8 个既有 config-editor/startup credential 类型错误且零触及文件错误；`pnpm s7:lint` 17/17 与 canonical golden 通过；同输入 `pnpm build` 17/17 workspace 成功；`git diff --check` 无错误。
- **差异审计**：C33-C36～C33-C49 只能且均已按“修复后复核通过”关闭；U33-04↔U33-10 以 target 已耐久激活后的同一 current generation 衔接，U33-04↔U33-05 共用受治理 paired client，U33-10 不以 target buffer 或在线性改写耐久事实；无未处置同根反证。
- **专项结论**：U33-04、U33-05、U33-10 均为“已验证”；后续仅按变更范围执行独立审查，不得把本专项当作全单元终审或提交验证。

## U33-04～U33-06、U33-13 重开收敛固定矩阵

> 本矩阵只固定四项重开范围；U33-01～U33-03、U33-07～U33-12 与 EX33-01 直接复用。每格同时绑定稳定身份、耐久事实、零副作用边界、终态和直接验收。

| 编号 | 固定变体与生产入口 | 稳定身份与唯一耐久事实 | 零副作用边界与消费终态 | 直接验收 |
| ---- | ------------------ | ---------------------- | -------------------------- | -------- |
| F33-17 | directory/paired setup；有/无 recovery root；select、连接、create、replicate/verify 各步前后失败与丢响应 | binding.targetId + generation + `backup-setup:<targetId>:<chainHead>`；created/replicated 或 root-activation verified | 既有 root 的 success 线性化于 replicated，无 root 的 success 线性化于 activation verified；此前只留可 exact replay 的 binding/candidate，不报成功 | 两类真实 setup × 有/无 root 注入各边界故障；重试/重启恰一副本，paired 离线不得空成功 |
| F33-18 | current/历史 target；fresh verify、terminal replay、current paired 离线 | created `{checkpointId,targetId,recipient,generation}` + 同 target replicated/verification | 候选先从日志选 `{checkpointId,targetId}`；错 binding/root/chain 零 verified，既有有限 failure fact也反绑 created.targetId；合法历史 adapter可打开 | 先切换 binding 再验证旧副本、当前目标离线但历史目录可验、错字段与响应丢失 |
| F33-19 | startup 的无记录、created、replicated、target unavailable、连续重启 | durable config + checkpoint stream；available/unavailable slot | 监听前 reload+recover；未恢复 owner不发布 available；可选目标离线不阻普通 serve，identity 矛盾 fail-stop | 首次 status 与并发管理入口、离线重连、效果前后失败、连续重启；cleanup不作启动门禁 |
| F33-20 | 零/多 record page、共享/嵌套/外置/单个大/海量小 retained artifact 的 capture | 冻结 source-head/retention snapshot + 受 1 MiB header 预算约束的 page/artifact length/digest 目录 | 第一遍每次追加前核对预算且只留有界元数据，第二遍正文逐块；超限/头变化/坏件在 created 前零副作用 | 总量远大于 permit、单个大与海量小 ref，核对两遍同前缀、坏件/删除/重冻及峰值 O(chunk/header×concurrency) |
| F33-21 | full create/encrypt/local CAS/directory write 与 exact replay | checkpointId、固定 header、seq/digest/bytes、CAS ref与 envelope | 每块 permit 内加密→put→清零；envelope签名/created在全部 CAS 块后，directory sink不收整包 | 零/大 payload、容量等待/磁盘满/取消/stop、效果后丢响应和重启，wire/envelope全等 |
| F33-22 | paired begin/progress/append/commit/read，网络挂起与部分上传 | envelope exact-set、seq/offset/digest、receiver durable progress | 网络等待无 permit；decode/append/read各一块；commit逐块交 target sink，不构造 chunks 数组 | 大包部分上传、乱序/重复、饱和/取消、commit/read丢响应及连续恢复 |
| F33-23 | directory/paired verification、bootstrap store reload、首次 pairing/root activation 与 owner/service完成值 | envelope signature/ref、verification nonce、声明 length+digest 状态机 | bootstrap/owner只传轻量描述+source；增量 decrypt/hash仅持 header+当前块/摘要，未验完整目标绝不 verified/activate | daily 与 root-activation 真实大包、坏中间/末块、声明跨 chunk、响应丢失；峰值有界且 verification 全等 |
| F33-24 | configured root 不存在/已存在、owned checkpoint/staging parent；建立或绑定后被 symlink/junction/reparse/rename 替换 | filesystem root→逐组件 handle + 最终 lexical path/dir handle/volume/dev/fileId/ino | root 建立和所有 child lookup均相对已打开 handle；替换路径不能改写目标对象，漂移零新 progress | POSIX symlink/rename 与 Windows junction/reparse 在 root 建立及每个 child 调用前注入，根外零创建/正文 |
| F33-25 | child create/open/read/write、最终文件替换与越根 | validated single component + opened child handle identity/nlink/type | no-follow/beneath 相对 open；同 handle I/O/fsync/stat，坏 identity 在正文消费/发布前失败 | envelope/manifest/chunk 正反例、final replace、读写中 replace，合法路径零误杀 |
| F33-26 | staging mkdir/publish rename、retire rename、exact-set recursive remove、目录 sync与重启 | checkpoint/envelope/supersession 稳定名 + source/destination dir handles | rename/remove 只经 handle-relative OS 操作；只枚举已知 exact-set且不跟链接；完成后才 progress | parent 双向替换、部分 publish/retire、丢响应与连续重启，根外零发布/删除 |
| F33-27 | verified→superseded、verification 响应丢失、24 小时 local GC | verification 同 envelope 的 `checkpoint-superseded` = source-local release | superseded 前 retained；之后仅通用 GC 可删且共享 owner仍保护；不写当前 local-released | 新旧 full verify、terminal replay、24 小时前后、共享 ref和重启 |
| F33-28 | 27 天前后、current/历史 target、离线 retire与丢响应 | superseded.at + created.targetId + `target-retired` | 27 天前 target零删除；到期失败保留义务，成功后恰一 target-retired | directory/paired、26d23h/27d、离线重连、retire效果后丢响应与连续重启 |
| F33-29 | 历史 `local-released` 记录、status/audit、U33-04 target cleanup交界 | current事实只认 superseded/target-retired；legacy local-released = no-op | 兼容读取不改变 retention/status/完成；不删 binding直至其 target义务终态 | 含/不含 legacy 记录的同日志投影全等；旧 binding 与 target retire重驱 |

## U33-04～U33-06、U33-13 重开收敛反证账

| 编号 | 首次反证与归属 | 耐久处置 |
| ---- | -------------- | -------- |
| C33-C17 | U33-04：先连接 current target 再选 candidate 会使 current paired 离线遮蔽历史 directory 副本 | candidate 从 checkpoint stream先返回 checkpointId+targetId，CLI随后按 binding 打开精确 target |
| C33-C18 | U33-04/U33-11：await startup recovery 若把 paired 离线上抛，会破坏可选备份不阻普通业务 | 只有 recovered owner发布 available；可用性故障发布 unavailable并重试，trust/root/member矛盾仍 fail-stop |
| C33-C19 | U33-05：单遍 capture 在 payload header 已冻结前无法既不保留正文又先发 header chunk | 固定为两遍同 source-head：首遍目录，复核后第二遍加密；任一头变化整轮重冻 |
| C33-C20 | U33-05：只把 target 改成 chunk sink，service 本地 CAS重载与 full open仍会重建整包 | envelope+seq source贯穿 local CAS/两 target/activation；verification按声明增量验真，不保留全部内容 |
| C33-C21 | U33-06：Node 22 fs没有 directory-handle-relative create/rename/unlink，TypeScript 事后复核不能撤销根外副作用 | 唯一方案含 mesh 内专用 POSIX/Windows native bridge；工作量改为大，接口禁止任意路径 |
| C33-C22 | U33-06：路径被替换后即使最终 `O_NOFOLLOW` 成功，也可能已在错误父目录创建/删除 | 每个 child系统调用锚定冻结 dirfd/handle，最终 file identity只作第二层复核 |
| C33-C23 | U33-13：在 superseded 与“同 envelope local-released”间二选一会让执行者自行决定事实源 | 唯一定为 superseded；legacy local-released兼容只读 no-op，当前停止生产 |
| C33-C24 | U33-05：只修 service/target 仍会由 `FileMeshBootstrapStore.loadCheckpointPackage`、activation coordinator 和 owner完成值重建/保留整包 | 同一轻量 envelope/ref + chunk source/sink贯穿 daily 与 root activation，所有生产完成值禁止携带 materialized chunks |
| C33-C25 | U33-06：只把已冻结 root 下的 child 改为 handle-relative，`ensureDurableDirectory` 首次创建 configured root仍可被祖先替换导向根外 | 专用桥从 filesystem/drive root逐组件 no-follow 创建/打开 configured root；路径版 root create也从两 adapter移除 |
| C33-C26 | U33-05：两遍 capture 若第二遍仍用 `ArtifactStore.get(ref)`，单个超大 retained artifact本身即可超过 permit | 复用现有 `readRange`按固定块读取并增量验 digest；不新增 ArtifactStore/streaming 接口 |
| C33-C27 | U33-05：第一遍只留 descriptors 仍可能先积累海量小 ref，再在最终 header 检查时 OOM | 每次追加 descriptor/ref 前增量核对既有 1 MiB header 预算，超限在 created 前稳定失败，元数据峰值同 wire 上界 |
| C33-C28 | U33-05↔U33-08：full checkpoint 改为轻量 source 后，历史 trust-only package 若也只返回 source，会使既有 S2 activation 在首次配对或 bootstrap store 重载中拿不到兼容正文 | full scope 保持全链逐块；非 full 的 legacy package 仅在 File target 与 bootstrap store read-back 处按声明总量不超过 16 MiB 有界物化并逐块验 digest，坏块失败时清零已读正文，不恢复 full 整包驻留；deferred target 对已物化 legacy 原样返回 |
| C33-C29 | U33-04↔U33-06：冻结 root handle 若随 status/setup/slot reload 或 deferred paired wrapper 泄漏，会让长期 serve 累积 OS 资源且旧 root 身份继续存活 | target 增加可选 close；setup/verify/onboarding finally 关闭，slot 替换关闭旧 target，重复 fingerprint 关闭新副本；deferred paired 每次操作独立打开关闭，range source 每次读取重新绑定 |
| C33-C30 | U33-04：root rotate 后若历史 created 与当前配置具有相同 targetId，`#target` 仅按 targetId 快捷复用当前 recipient adapter，会把旧代恢复/清理误绑新 recipient；历史 resolver target 未关闭还会累积资源 | 当前 target 快捷路径同时全等 targetId+recipientKeyId；否则按 created 冻结 recipient 解析历史 adapter，并在 verify/recover/retire 完成后关闭；CLI 与 slot 对目录物理 identity 漂移失败前也先关闭 handle |
| C33-C31 | U33-04↔U33-06：durable directory binding 在启动/verify 时若仍以 create 模式打开，离线卷或被移除 root 会在旧 lexical path 静默创建新目录，既污染挂载恢复又制造错误物理代际 | `FileRecoveryCheckpointTarget.open` 显式区分初次 setup create 与 durable binding reopen；setup 才允许逐组件创建，startup/verify/history resolver 一律 existing-only 并对缺失发布 unavailable/失败 |
| C33-C32 | U33-05：首遍 capture 仍先把一个 record page 或注册 root 内的全部 retained refs 加入 `Map`，随后才核对 1 MiB header；单页即可越过冻结 header 上界，未满足 F33-20/C33-C27 的“每次追加前”约束 | 以 checkpoint 专用增量 header budget 在每个 page descriptor 与每个新 ref 写入集合前计算规范 JSON 的精确候选长度；超过 1 MiB 时零 created 失败，最终完整 header 仍二次全等校验 |
| C33-C33 | U33-06：Windows helper 从 volume root 逐组件创建 configured root，但最初打开的 volume handle 未申请 `FILE_ADD_SUBDIRECTORY`；目标恰为卷根下一层且不存在时会在第一步稳定失败 | 只补齐 frozen volume-root handle 的子目录创建权限；后续仍以 `RootDirectory` 相对打开、逐组件 reparse 检查和最终 handle identity 驱动，不回退路径版创建 |
| C33-C34 | U33-05：capture 两遍都以 64 个 commit 调用 `readTail`，单个 WAL frame 可达 16 MiB，故一次返回可驻留约 1 GiB，且与声明的 16 MiB governor step 不全等；总量虽不随 checkpoint 总长增长，仍违反固定生产页上界 | 保持 wire 中每页最多 64 commit，但两遍都按单 commit `readTail(..., 1)` 顺序读取；首遍增量计算同一规范数组的 page digest/bytes 与 retention，第二遍按相同分隔逐 commit 推入 1 MiB chunker，每次只驻留一个受 WAL 上限约束的 commit，最终 descriptor/digest/wire 全等 |
| C33-C35 | U33-05/core 直接交界：versioned `AuthorityCommitLog.readTail` 在 limit 截断时把部分 `lastLsn/prefixDigest` 与整份 WAL 的 `frameEndOffset` 组合成返回 checkpoint，下一页必以 `commit-log-corrupt` 失败；既有 64-commit capture 因小日志未分页而掩盖 | `readTail` 只有扫描到真实 tail 才更新 verified tail；limit 截断时直接返回 `scanLogFrom` 已证明的 frame boundary/LSN/prefix，新增真实 versioned WAL 逐条分页测试，capture 两遍可复用同一耐久 cursor且不修改 authority log 格式 |

### 实施进度账（2026-08-08）

| 阶段 | 当前事实与证据 | 状态 |
| --- | --- | --- |
| U33-13 source-local release | `checkpoint-superseded` 已是唯一 source-local release fact并驱动 LifecycleIndex；生产停止写 `local-released`，历史记录兼容 no-op；27 天只按 created.targetId 写 `target-retired` | 已验证：mesh 13/13 直接场景含共享 ref、legacy no-op、旧 target retire 与重放 |
| U33-04 setup/verify/startup | candidate 先冻结 `{checkpointId,targetId}`，setup 同步形成首份耐久副本，历史 verify 全程反绑 created target；owner slot 在公开准入前 await reload+recover，optional target 故障只发布 unavailable | 已验证：CLI 14/14 定向场景、mesh 13/13 与同指纹 lifecycle 冷启动对抗通过 |
| U33-05 bounded checkpoint residency | 两遍冻结 capture、逐项 1 MiB header 预算、单 commit durable pagination、ArtifactStore.readRange 与窄 ChunkSource/Sink 已贯穿 CAS/target/activation；完成值不携带 materialized chunks | 已验证：core pagination 1/1、core/mesh 类型检查、mesh 13/13、17 项 workspace build 通过 |
| U33-06 physical parent-child identity | checkpoint 专用 POSIX/Windows 句柄桥从 filesystem/drive root 逐组件建立 frozen root，directory/paired 的 child create/read/write/rename/unlink/sync 全部 handle-relative；Windows volume-root 创建权限已补齐 | 已验证：Windows helper 构建与 mesh 13/13 通过，POSIX/Windows 原语只读对抗无新反证 |

## U33-04～U33-06、U33-13 四路冷启动对抗复审

> 基线为上方同一份未修改问题列表、F33-17～F33-29 与 C33-C17～C33-C27；本轮只重建事实链和反例，不修改实现，不运行构建或测试，也不复用先前十二项专项收口结论代替判断。

| 冷启动角色 | 主动重造的反例与交界 | 独立结论 |
| ---------- | -------------------- | -------- |
| target setup / verify / startup lifecycle | directory/paired、无 root/已有 root、current/历史 target、created/replicated、效果前后失败、当前 paired 离线、公开准入和连续重启；并核查 U33-04↔U33-13 的旧 binding/target retire 及 EX33-01 | 通过。candidate 必须先由 checkpoint stream 冻结 `{checkpointId,targetId}` 再解析 binding；setup 成功、verify 写入与 startup available 均由该 created 代际的 durable progress 判定。可选目标不可用只形成 unavailable 并重试，身份矛盾 fail-stop，cleanup 保持后台；没有恢复已否定的 cleanup 启动门禁。 |
| checkpoint 总量资源上界 | 空载、单个超大 artifact、海量小 ref、record/artifact/chunk 总量、两遍间 source/index 漂移、daily 与 root activation、local CAS/bootstrap/owner 完成值、directory/paired get-range-commit、容量/磁盘、取消/stop 和丢响应；并核查 U33-04↔U33-05 | 通过。首遍逐项增量执行既有 1 MiB header 预算，第二遍复用 `readRange`；轻量 envelope/ref 与 checkpoint-only source/sink 贯穿所有生产消费者，permit 与 buffer 同寿命且不跨网络/外层锁。现有 envelope、1 MiB chunk 与 wire 字节可保持不变，无需新增通用 streaming 框架。 |
| directory / paired parent-child 物理身份 | configured root 不存在/已存在，POSIX symlink/rename 与 Windows junction/reparse/rename 在 root 建立及每个 child 系统调用前替换，最终文件替换、publish/read/retire/remove、越根和重启；并核查 U33-05↔U33-06 | 通过。Node 路径 API 与事后复核无法提供零根外副作用；唯一完整方案是 mesh 内 checkpoint 专用跨平台句柄桥，从 filesystem/drive root 到 child 操作始终相对冻结 handle。接口只接受固定操作和单组件名，不构成通用文件系统框架；额外文件主张未重开。 |
| local / target retention 事实与范围价值 | verified→superseded、24 小时 source-local GC、27 天独立 target retire、共享业务 ref、legacy local-released、响应丢失和连续恢复；并核查 U33-04↔U33-13、四项↔EX33-01 及第 34～38 单元边界 | 通过。`checkpoint-superseded` 唯一表达 source-local release，`target-retired` 唯一表达独立目标终态；legacy `local-released` 仅兼容 no-op。U33-13 保持 P2/小，U33-04/05/06 分别保持 P1/中、P1/大、P1/大；未恢复单源 27 天本地保留，也未并入 planned/disaster transfer、恢复应用、全局同步或生命周期能力。 |

- **交界差异审计**：U33-04↔U33-13 以 created.targetId 和 target-retired 维持历史 target 义务；U33-04↔U33-05 以轻量 checkpoint source 贯穿 setup/verify/startup；U33-05↔U33-06 以句柄桥承载有界 source/sink 的真实 I/O。C33-C17～C33-C27 均已“同根合并”，无未处置反证。
- **同一版本结论**：四项事实、根因、影响、评级、工作量、最优方案与 F33-17～F33-29 验收条件闭合；记录无需再次修改即可交由执行者一次实施。

## U33-04～U33-06、U33-13 修复后冻结专项收口（2026-08-08）

> 本节只证明四项正式问题在同一未修改交付指纹上完成实现、最小必要验证、专项事实链与四路冷启动对抗；不替代、不计入全单元两轮冻结终审、正式独立功能审查或单元提交验证。

- **冻结指纹**：`8156307a701608189b5e97d0badba4c773900bd1edef92cce793f17f3b14e23b`；27 个非工作台交付文件，算法见“当前状态”。
- **边界复用**：U33-01～U33-03、U33-07～U33-12 与 EX33-01 未重开；cleanup 启动门禁、额外文件及 source-local 27 天保留主张未恢复；第 34～38 单元能力未进入实现。

### F33-17～F33-29 修复后事实矩阵

| 矩阵 | 修复后事实与直接证据 | 结论 |
| --- | --- | --- |
| F33-17 | directory/paired setup 均先耐久 select；无 root 走既有 activation，有 root 以稳定 request 同步 create+replicate；失败只留可重驱 binding/candidate | 通过 |
| F33-18 | candidate 在连接前从 stream 冻结 checkpointId+targetId；历史 adapter按 created target/recipient 打开并关闭，verify/failed/verified 均反绑该代 | 通过 |
| F33-19 | slot start 在公开监听前 await reload+recover；optional target 离线发布 unavailable并重试，identity 矛盾 fail-stop，cleanup仍后台 | 通过 |
| F33-20 | 首遍逐 commit/逐 retained ref 在追加前执行精确 1 MiB header 预算，第二遍同 source-head 逐块重读；越界在 created 前失败 | 通过 |
| F33-21 | plaintext/ciphertext/CAS/target 均以固定块和 governor permit推进，envelope与created晚于全部 chunk，完成值仅保留轻量 source | 通过 |
| F33-22 | paired 网络读取先取得有界 part，append/read/commit逐块且网络等待不持 permit，断点与响应丢失复用耐久 progress | 通过 |
| F33-23 | bootstrap、owner、directory/paired verify与 activation 只传 envelope/ref/source，增量 decrypt/hash在完整验真前不推进 verified/activate | 通过 |
| F33-24 | configured root 从 filesystem/drive root 逐组件 no-follow 建立；运行中 lexical parent替换不改变 frozen handle | 通过 |
| F33-25 | child 名称先限为单组件，create/open/read/write均相对 frozen handle并在同 handle复核 type/link/identity | 通过 |
| F33-26 | publish、retire、exact-set remove与目录 sync均使用 handle-relative rename/unlink/fsync，完成后才写 progress | 通过 |
| F33-27 | verification 同 envelope 的 checkpoint-superseded 唯一释放 source-local owner，24 小时 GC继续保护共享 ref | 通过 |
| F33-28 | 独立 target 自 superseded 起保留 27 天，到期只按 created.targetId 幂等 retire并写 target-retired，失败保留义务 | 通过 |
| F33-29 | 历史 local-released 仅兼容解码且 reducer no-op，不参与 retention/status/完成；旧 binding 保留至 target义务终态 | 通过 |

### 同一指纹四路冷启动对抗

| 角色 | 主动反例与直接交界 | 结论 |
| --- | --- | --- |
| target setup/verify/startup lifecycle | 两类 setup、current/历史 target、created/replicated、效果前后失败、离线、公开准入与连续重启；U33-04↔U33-13 | 通过：同一 created target代际贯穿 setup成功、verify与startup recovery；optional故障不阻普通业务 |
| checkpoint 总量资源上界 | 零/大 payload、单个超大 artifact、海量小 ref、record/artifact/chunk驻留、容量/磁盘/取消/stop；U33-04↔U33-05 | 通过：驻留仅随单 commit、1 MiB header/chunk及固定并发增长；C33-C32/C34/C35已耐久处置 |
| directory/paired parent-child 物理身份 | configured root建立、parent/child/final替换、publish/read/retire/remove、越根与重启；U33-05↔U33-06 | 通过：POSIX dirfd与Windows RootDirectory均把副作用锚定冻结物理对象，路径版 child副作用已退出两 adapter |
| local/target retention与范围价值 | superseded、24小时 local GC、27天 target retire、共享 ref、legacy fact、丢响应与恢复；U33-04↔U33-13、EX33-01与后继边界 | 通过：本地释放与独立目标终态各恰一事实；U33-13保持 P2/小且未扩面 |

### 反证与验证差异审计

- C33-C17～C33-C35 均以“修复后复核通过”关闭：C17～C31 的 lifecycle、轻量 source/sink、handle owner与历史 target直接变体已由生产链及定向场景复核；C32 逐项 header预算、C33 Windows volume-root权限、C34 单 commit驻留、C35 durable pagination均有当前源码和直接测试。
- 最小必要验证：core/mesh `tsc --noEmit` 通过；core versioned WAL pagination 1/1；mesh full-authority 13/13；Windows bridge构建通过；CLI 受影响定向场景14/14；S7 17/17与 canonical golden 在未变化输入上复用；当前输入 `pnpm build` 17/17，163.8 秒通过。
- **专项结论**：U33-04、U33-05、U33-06、U33-13 均为“已验证”；四项专项范围内不存在未处置同根反证。

## U33-01～U33-12 收敛固定矩阵

> 本矩阵固定修复边界、唯一事实源、拒绝副作用和直接验收；执行阶段发现同根反证时先更新对应 U33 行及本矩阵，不得借此引入第 34～38 单元能力。

| 编号 | 固定变体与生产入口 | 稳定身份与耐久事实 | 零副作用边界与用户终态 | 直接验收 |
| ---- | ------------------ | ------------------ | -------------------------- | -------- |
| F33-01 | 六类 retained 内容、会话删除、checkpoint stream | 冻结 source-head vector；注册型 classifier + 同头 lifecycle snapshot | 不可分类/deferred/缺 ref 在 created 前失败；成功载荷与该前缀 retention 全等且不自递归 | 真实 log/store/index 的六类正反例、删除前后与重启 |
| F33-02 | 共享、嵌套、外置、>8 MiB、index 落后/损坏/越头 | ArtifactRef digest/bytes；typed root closure；index checkpoints | 禁止通用 JSON 扫描；越头丢弃本轮重冻，损坏 rebuild 后重取 | ref 共享/传递闭包、坏件、并发追加/删除与前缀复核 |
| F33-03 | 同日 rotate、同 root chain 变化、daily/forced、source prefix | generation(root ids+chain+target)、request key、created source、checkpointId | 旧 generation 永不计 current ready；fresh/terminal replay不混代 | root/chain 双变化、效果后丢响应、连续重启 |
| F33-04 | daily↔forced 同 key/异 key、stop | `{candidateKey,promise,abort}` + lifecycle exact replay | 同 key join；异 key稳定 busy且零新 candidate；不建队列 | 双序、并发、响应丢失、stop/restart |
| F33-05 | current/历史 target、setup 切换、created/replicated | durable binding map + record.targetId + checkpoint stream | 新任务只取 current；旧任务按原 target重驱；setup自身完成新目标创建，owner各既有入口前重载 | 切换、setup返回终态、旧 target 离线/恢复、各步丢响应 |
| F33-06 | superseded、27 天、target/local cleanup | supersededAt、target/local cleanup progress、lifecycle retention fence | 任一步失败保留同义务；旧 binding 有引用不删；共享 CAS零误删 | 27 天边界、双段清理、重放与连续重启 |
| F33-07 | 零/大资产、容量/磁盘、网络挂起、取消 | checkpointId+physical step、同一 governor与 lifecycle signal | permit 不跨网络/authority/store/lifecycle 锁；取消后零新 progress | 有界内存/并发、饱和、满盘、stop与恢复 |
| F33-08 | directory root/file link、绑定/写读中替换、越根 | configured root、owned root、opened file dev/ino | 同 handle fsync+路径复核后才发布；漂移零根外 I/O | root/file/reparse/替换、崩溃、响应丢失 |
| F33-09 | paired begin/progress/append/commit 及乱序 | 同 root/file binding、envelope/chunk exact-set与 durable progress | envelope同 handle fsync、目录fsync后才 begun；乱序零推进 | begin 崩溃、部分上传、错序、连续恢复 |
| F33-10 | 全部 paired result、普通 mesh/pairing socket | 唯一 strict result decoder + originating command identity | 错 keys/state/id/seq/offset/progress/digest零推进 | 两 transport 参数化正反例 |
| F33-11 | v1/v2/未知包、backup/pairing root activation | package version、candidate root、activation checkpointId/plan | v1只走 S2 trust-only replay且 full-ready=false；v2无 legacy | fresh/terminal replay、响应丢失、readiness隔离 |
| F33-12 | 两处秘密回读、TTY/非TTY/取消 | recovery input buffer；decoder消费后清零 | 除有意首次展示外零回显/日志；非TTY稳定拒绝 | key/paste/backspace/Enter/Ctrl-C与输出扫描 |
| F33-13 | status 四态、verification失败 | 内部 status/lifecycle + 公开 stable code/nextAction | 公开无内部 id/LSN/digest/raw error；异常不静默消失 | server.info/CLI exact keys与错误映射 |
| F33-14 | disabled/bad config/offline/missing runtime/trust-root损坏 | backup runtime slot；trust/root authority | 可用性故障不阻塞普通业务；身份损坏仍 fail-stop | 两生产根启动、reload与普通会话 |
| F33-15 | setup/verify/status、daily/forced、paired put/get/retire | 实际 Commander/owner/receiver descriptor exact-set | 删除/重复/错 owner/phase/旁路使既有 S7 fail-closed | golden、AST变异及合法角色/顺序 |
| F33-16 | 两个 P0 必要证据与后继边界 | 两张真实生产小表；第34～38单元排除条件 | 不用组件自报代替生产事实，不启用 transfer/restore/云/多目标 | retention+generation两表及排除符号/装配核对 |

## U33-01～U33-12 收敛反证账

| 编号 | 反证与归属 | 耐久处置 |
| ---- | ---------- | -------- |
| C33-C01 | U33-01：当前 index 查询不能证明先前冻结 log prefix；同根，不是新问题 | 方案改为 exact source-head snapshot；index 越头时整轮重冻，禁止用 current-head 代替 |
| C33-C02 | U33-02：daemon 无恢复秘密，status 不能靠重新解密 payload核准 current chain；同根 | generation/source 全等写入 created，verify 时与已解 payload核准，status 只比较耐久 binding与当前 trust |
| C33-C03 | U33-03：“有界串行或稳定拒绝”给执行者留下两种架构 | 唯一确定为异 key 返回稳定 retryable busy；不建队列 |
| C33-C04 | U33-04：仅删除远端 target 不能释放本地 envelope/chunks，且旧 binding 不能在目标切换时丢失 | 在现有 checkpoint stream 分别记录 target/local cleanup progress，binding 零引用后才可删 |
| C33-C05 | U33-05：target transport已有 signal 形参但 target/service未透传，且 open 的整包聚合独立于 governor | target/service/crypto/CAS 共用 owner signal与 governor step，production open改为增量消费 |
| C33-C06 | U33-06：额外文件只构成空间健壮性，未满足既有重开条件 | 不恢复额外文件 retention/删除主张；只以 exact-set 作为 durable progress 前置核对 |
| C33-C07 | U33-08：`RecoveryActivationCoordinator` 已能分派 full 与 trust-only open，无需新兼容框架 | 两入口把 `legacyCheckpoint` 直接送现有 coordinator，v1不参与 full readiness |
| C33-C08 | U33-09：不存在现成无回显 reader | 只在现有 stdin ownership/raw-mode/key-event 上增加 recovery-package 专用窄 reader |
| C33-C09 | U33-10：认证 RPC 且字段非恢复秘密，未触发 P1 重开 | 维持 P2，只做公开 DTO/stable code 分层，不改认证或新增状态框架 |
| C33-C10 | U33-11：把所有装配异常降级会掩盖 trust/root 身份破坏 | 仅 target/config/runtime 可用性进入 unavailable；trust/root/member矛盾仍 fail-stop |
| C33-C11 | U33-12：把十二项全部复制进两根矩阵会扩张证据成本 | 只补生产入口 exact-set和两个 P0小表，其余复用各自直接合同 |
| C33-C12 | U33-04/U33-11：独立 `backup setup` 进程不存在可复用的 owner 管理唤醒 facade，原方案无法直接实施 | setup 自身完成新 binding 首次创建/复制；owner slot 在 startup recovery、daily/forced、verify/status与重试 turn前重载配置，不新增 IPC、watcher或reload RPC |
| C33-C13 | U33-05：paired append 若在持有 governor permit 的 operation 内调用 progress，会嵌套申请第二个 permit并可在饱和设备上自锁；同根，不是新问题 | append 的写/fsync 与后续 progress/验真拆成相邻叶步骤，前一 permit 释放后才申请下一步；直接代码复核与 paired 场景复验通过 |
| C33-C14 | U33-04/U33-06：随机 staging/retired 路径在 rename 后崩溃无法由 exact replay 定位，目录/paired target 会遗留不可重驱私有目录；同根，不是新问题 | 临时与 retired 路径改为 checkpoint/envelope/supersession 稳定身份；每次 fresh/exact replay 先以冻结 owned identity 清理同键残留，再写入或退役；直接场景覆盖手工注入的中断目录 |
| C33-C15 | U33-06：retired 路径摘要直接截取 `sha256:` 前缀在 Windows 含冒号，恢复清理路径不可创建；同根，不是新问题 | 只使用摘要 hex 段生成文件名；Windows 定向场景先失败取证、修正后复验通过 |
| C33-C16 | U33-05：删除整包 `Buffer.concat` 后，open 路径仍先持有全部解密 chunks 再复制声明内容；paired 下载端的 governor 注入也未覆盖网络返回后的 bounded decode；同根，不是新问题 | full open 已改为逐密文块解密、按声明目录增量复制并立即清零输入块；paired range 在网络返回后、有限校验通过前以独立 governor 叶步骤解码，permit 不跨网络等待；mesh 类型检查、受影响直接测试 5/5 与当前输入构建通过 |

## U33-01～U33-12 四路冷启动对抗复审（历史专项指纹）

> 基线为交付指纹 `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a` 上同一份未修改问题列表与 F33-01～F33-16；四路分别从当前架构、规格和生产源码重新构造反例，不复用其他路结论。本表是十二项专项修复对抗记录，不计全单元冻结终审或独立功能审查轮次。

| 路线 | 冷启动反例与双向对账 | 结论 |
| ---- | -------------------- | ---- |
| A full capture/retention 与 generation readiness | 从当前源码重造删除后仍有 ref、注册型大资产、index 落后/越头、同日 root rotate、同 root chain 推进、source prefix 响应丢失及同/异 candidate key；核对 index snapshot、generation created binding、readiness 与 single-flight | 通过；U33-01/02/03 的 source/generation/candidate 身份唯一，C33-C01～C03 已同根闭合 |
| B candidate/target lifecycle 与物理身份 | 从当前源码重造旧 target pending、独立 setup 切换、27 天双段清理、directory/paired root/file 替换、begin 崩溃、随机中断目录及 Windows retired 路径；核对 target resolver、稳定 staging、no-follow handle 与 cleanup progress | 通过；U33-04/06 边界清晰，C33-C04/C06/C12/C14/C15 已同根闭合，额外文件主张未恢复 |
| C 资源/兼容/秘密/状态与普通业务隔离 | 从当前源码重造整包 plaintext、网络返回后未治理 decode、嵌套 permit、网络挂起 stop、v1 旧包、TTY 泄密、raw error、坏配置/缺 runtime 与 trust 损坏；核对 governor 叶步骤、增量 open、现有 coordinator、CLI reader、公开 DTO 与 slot | 通过；C33-C05/C07～C10/C13/C16 已复核，P2 边界未升级，optional unavailable 不削弱 trust fail-stop |
| D production exact-set/必要证据与范围价值 | 删除/重复/错角色/错 phase owner/receiver 入口并让 token 仍存在，重造组件绿但两个 P0 仍坏；核对生产 descriptor、S7 literal exact-set、真实 retention/readiness 小表及第 34～38 单元排除符号 | 通过；C33-C11 与 U33-12 已闭合，不复制十二项矩阵、不建新 lint/runner，后继范围未提前实现 |

**历史交界差异审计：**`U33-01↔U33-02` 以同一 source-head/generation created binding 衔接；`U33-02↔U33-03` 共用 candidate key；`U33-04↔U33-05↔U33-06` 共用 targetId、owner signal、governor、root/file identity 与 cleanup progress；`U33-07～U33-11↔U33-12` 仅共享有限 descriptor 与直接证据，不把 P2 升级为门禁扩面。C33-C01～C33-C16 在该历史专项指纹上均以“同根合并”关闭；最新独立审查已以 P33-18～P33-20 重开 U33-04、U33-05、U33-10，本段不得作为现行通过结论复用。

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX33-01 | **原主张：**修复后交付路径反向表仍停在旧 42 路径口径，漏列 8 个功能文件和 2 个流程文件，应以 P2/小登记并在冻结后重建 exact-set。**已验证事实：**本轮独立审查已经直接核查全部漏列路径，未发现由旧计数导致的产品错误、必要合同违例或未审功能链；工作台已同步当前 `dd50eec8..HEAD` 的 52 路径（46 功能、6 流程）。 | 路径表是审查输入维护账，不是产品生产合同；旧计数在本轮没有隐藏任何未判定路径，后续交付物变化时按工作台常规维护原则同步即可。适用边界仅限当前第33单元已经完成实际归项的路径集合，不代表相邻功能或未来 diff 自动通过。 | 当前 `HEAD 7d63b0e3`；`git diff --name-only dd50eec8..HEAD` 与独立审查清单“交付路径反向覆盖”逐项对账；P33-17 反向价值裁决。 | 冻结清单声称完整，但出现未被任何审查项判定的功能路径，并因此遗漏可达失败或必要合同违例。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V33-01 | full capture/index、generation/single-flight、target lifecycle/governor/physical identity、strict codec 与稳定错误码 | mesh 直接文件 12 项；物理与 staging 修改后只复验受影响项；C33-C16 后补 mesh 类型检查与 5 个直接用例 | core retention/contracts；mesh checkpoint/full/service/owner/directory/paired；真实 log/store/index 测试 | 修复直接验证；合并证据 + C33-C16 28.71s | 历史命令通过，但 P33-20 证明 paired client governor 注入变体未覆盖；U33-05 修复后仅补该失效闭包 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 失效 |
| V33-02 | v1 trust-only replay、恢复秘密零回显、runtime slot 与 pairing 兼容 | CLI 4 个直接文件 | mesh runtime bootstrap、backup owner、TTY reader、pairing production command | 修复直接验证；24.34s | 历史 4 files / 16 tests passed，但未穿过 active paired + 无恢复根及 unavailable slot 的耐久 readiness 分支；U33-04/U33-10 修复后补证 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 失效 |
| V33-03 | 公开 recovery status exact keys 与 raw identity 隔离 | server status 定向单例 | server context/info method 与公开 DTO | 修复直接验证；5.14s | 1/1 passed | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-04 | owner/receiver descriptor exact-set、实际分支反绑及 golden | `pnpm s7:lint` | S7 validator/tests、mesh owner/receiver descriptor、架构 recovery-backup 行 | 派生资产/合同预检；55s | 17/17 Node tests + canonical golden passed | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-05 | 受影响包类型闭包 | build 后 mesh/server `tsc --noEmit`；CLI 同命令作基线诊断 | mesh/server/CLI 当前源码与已完成 dist | 修复直接验证；约 37s + C33-C16 mesh tsc | mesh/server 0 error；C33-C16 后 mesh 再次 0 error；CLI 仅 8 个既有 config-editor/startup credential 类型错误，零触及文件错误 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-06 | 当前生产源码和跨包导出可消费 | `pnpm build` | 17 个 workspace 项目当前生产输入 | 最终构建证据；154.4s | C33-C16 修复后 exit 0，17/17 workspace build succeeded | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-07 | 交付差异卫生 | changed TS/MJS Biome 诊断；`git diff --check` | 当前变化路径 | 交付预检；<3s | diff check 通过；C33-C16 两个生产文件 Biome 通过；direct test 原有 `mkdtemp/tmpdir` 两条基线限制未扩散 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-08 | F33-01～F33-16 事实链、四路专项对抗与范围边界 | 同一指纹上只读重建 A～D 四路并审计 C33-C01～C33-C16 | 32 个交付文件、架构/规格、正式问题/矩阵/反证账 | 专项只读复审；不计全单元终审 | 四路通过；16 个反证均同根关闭；第 34～38 单元能力未进入生产装配 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |

| V33-09 | U33-04 setup/verify/startup 与 U33-13 retention 终态 | CLI owner/pairing/bootstrap 14 项 + mesh full-authority 13 项 | CLI setup/slot/serve；mesh service/target/lifecycle 当前输入 | 修复直接验证；复用当前有效定向证据 | 历史 CLI 14/14、mesh 13/13 仍可复用未受影响部分；P33-18/P33-19 证明无根 paired setup 与 degraded readiness 两格缺证，当前证据失效 | `8156307a701608189b5e97d0badba4c773900bd1edef92cce793f17f3b14e23b`（27 文件） | 失效 |
| V33-10 | U33-05 单 commit pagination 与 checkpoint 固定驻留上界 | core durable pagination 单例、core/mesh类型检查、mesh full-authority 直接文件 | core commit-log；mesh full capture/crypto/source-sink | 修复直接验证 | core pagination 1/1，core/mesh tsc 0 error，mesh 13/13 | `8156307a701608189b5e97d0badba4c773900bd1edef92cce793f17f3b14e23b`（27 文件） | 有效 |
| V33-11 | U33-06 checkpoint-child bridge 与 adapter物理身份 | Windows helper构建、mesh物理替换直接场景、POSIX/Windows源码对抗 | native bridge、TS wrapper、directory/paired adapters | 修复直接验证与只读专项 | helper build、mesh 13/13通过；两平台句柄语义无新反证 | `8156307a701608189b5e97d0badba4c773900bd1edef92cce793f17f3b14e23b`（27 文件） | 有效 |
| V33-12 | 当前生产源码、跨包导出、派生门禁与差异一致性 | `pnpm build`；S7/golden复用；指纹与diff检查 | 17个workspace项目、未变化S7输入、27文件清单 | 当前专项最终构建；163.8s | workspace 17/17；S7 17/17+golden有效；交付指纹冻结 | `8156307a701608189b5e97d0badba4c773900bd1edef92cce793f17f3b14e23b`（27 文件） | 有效 |
| V33-13 | U33-04 无根 paired 首次恢复根、双端 root fact、有限 receiver 与 durable binding | CLI 真实双设备 v1/v2 setup/active replay；CLI recovery-root runtime/bootstrap/owner；mesh strict codec/有界恢复 | backup setup、有限 control plane/service exact-set、paired receiver/staging、source coordinator、target bootstrap store 与 normal topology reload | 修复直接验证 | v1/v2 2/2、CLI 支撑 9/9、mesh 过滤 2/2；包内身份、双端根事实、current issuer、exact replay/conflict、响应丢失/重启与普通业务关闭均有直接证据 | `92953a6e3f7d5cd179f9c5c5a933f844487036541d5710b2d4effaab7a4e488e`（22 文件） | 有效 |
| V33-14 | U33-10 current-generation 耐久 readiness 与 unavailable/public 消费 | mesh generation readiness + CLI owner unavailable 真实日志/目标场景 | projector、AuthorityCommitLog、本地 full envelope、slot/public mapper | 修复直接验证 | mesh 2/2；CLI 真实 verified checkpoint 在 runtime unavailable 时仍 ready，改 target generation 为 false；本轮后续代码未触及 projector 输入 | `92953a6e3f7d5cd179f9c5c5a933f844487036541d5710b2d4effaab7a4e488e`（22 文件） | 有效 |
| V33-15 | U33-05 三个 paired client governor exact-set 与 range permit 生命周期 | mesh paired governor 定向场景 + S7 真实构造变异 | backup command、首次 pairing、runtime owner、paired range decode | 修复直接验证/派生预检 | 网络挂起零 permit、decode 受准入并释放；三个构造删除/替换/新增由单一 S7 gate fail-closed；本轮后续代码未改变 permit 边界 | `92953a6e3f7d5cd179f9c5c5a933f844487036541d5710b2d4effaab7a4e488e`（22 文件） | 有效 |
| V33-16 | 受影响类型、S7/golden、workspace 构建与差异卫生 | mesh/CLI `tsc --noEmit`；`pnpm s7:lint`；`pnpm build`；`git diff --check` | 22 个交付文件及直接依赖 | 修复直接验证与当前输入构建 | mesh 零错误；CLI 仅 8 个既有 credential 类型基线且零触及文件错误；S7 17/17+golden；workspace 17/17；diff check 通过 | `92953a6e3f7d5cd179f9c5c5a933f844487036541d5710b2d4effaab7a4e488e`（22 文件） | 有效 |
| V33-17 | F33-30～F33-40 与四路冷启动对抗、历史裁决和后继边界 | 同一指纹只读重建四路并审计 C33-C36～C33-C49 | 22 个交付文件、权威架构/规格、三项正式记录与 EX33-01 | 专项只读复审；不计全单元终审 | 四路通过；十四个反证均修复后复核通过；历史否定项与第 34～38 单元边界未改变 | `92953a6e3f7d5cd179f9c5c5a933f844487036541d5710b2d4effaab7a4e488e`（22 文件） | 有效 |

## U33-01～U33-12 专项修复收口记录（历史）

> 本节只证明十二项正式问题在同一交付指纹上完成实现、直接验证与四路冷启动对抗；不替代、不计入全单元两轮冻结终审、独立功能审查或单元提交验证。

- **冻结指纹**：`c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`；32 个非工作台交付文件，算法见“当前状态”。
- **固定矩阵**：F33-01～F33-16 全部逐格绑定 source-head、generation/request/candidate、target/checkpoint/file、package/result/status 身份及耐久线性化点、零副作用边界和直接证据。
- **直接验证**：V33-01～V33-07 有效；当前输入 workspace build 17/17 通过，C33-C16 后 mesh 类型检查及 5 个直接用例通过，S7/golden 与差异卫生通过。
- **四路冷启动对抗**：A～D 均在同一冻结指纹上通过；C33-C01～C33-C16 只能且均已按“同根合并”关闭，无当前源码证伪后仍悬置的主张。
- **范围审计**：价值裁决对 U33-01/U33-06/U33-12 的方案收窄及 U33-03/U33-07/U33-10 的 P2 边界保持有效；第 34～38 单元 planned/disaster transfer、恢复应用、全局同步与生命周期能力未进入生产装配。
- **历史专项结论**：在该指纹上 U33-01～U33-12 曾均为“已验证”；最新独立审查已重开 U33-04、U33-05、U33-10，当前状态以文件顶部和正式问题列表为准。本节不得作为现行冻结终审或问题清零结论复用。

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |
| IF33-01 | full capture、retention 与 root generation 安全 | core/mesh capture、index、lifecycle、readiness；当前专项指纹 `c66cd68d…` | 失效 | U33-01/U33-02 已专项修复；输入变化后尚未执行正式独立功能审查 | capture/index/root/chain/readiness 任一变化 |
| IF33-02 | target 生命周期、物理路径与资源故障 | config/binding、directory/paired adapter、governor/abort；当前专项指纹 `92953a6e…` | 失效 | U33-04/U33-05 已专项修复并通过直接验证；输入变化后须执行正式独立功能审查 | binding、I/O、root/file identity 或 stop 变化 |
| IF33-03 | compatibility、秘密输入、状态与可选 owner 隔离 | recovery codec、CLI TTY、status、两生产根；当前专项指纹 `92953a6e…` | 失效 | U33-04/U33-10 已专项修复并通过直接验证；既有秘密/raw error 裁决未恢复，输入变化后须正式独立审查 | codec、输入、DTO、装配错误边界变化 |
| IF33-04 | wire 严格性、single-flight 与产品范围价值 | paired result、daily/forced owner；当前专项指纹 `c66cd68d…` | 失效 | U33-03/U33-07 已专项修复，P2 价值边界保持；待正式独立功能审查 | candidate consumer或任一推进字段变化 |
| IF33-05 | 生产入口 exact-set 与必要证据 | S7 descriptor/golden、真实 log/store/index 与两生产根；当前专项指纹 `c66cd68d…` | 失效 | U33-12 已专项修复且直接门禁通过；待正式独立功能审查 | 入口、角色、门禁或必要证据变化 |
| IF33-06 | 跨区组合核查 | IF33-01～IF33-05 当前边界、输入与结论；当前专项指纹 `92953a6e…` | 失效 | 三条前置风险已在专项四路对抗闭合；任一前置风险输入变化使本项等待正式独立组合审查 | 任一前置风险面边界、输入、状态或结论变化 |

<!-- registration-complete: unit-33.gen-1 -->
