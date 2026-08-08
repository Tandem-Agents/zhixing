# 单元登记:第 33 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:33
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-08
- **登记来源**:用户要求将第 33 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U33-01～U33-12 十二项专项方案已全部落地并绑定同一交付指纹；直接验证、四路冷启动对抗及反证差异审计已闭合，未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅本轮十二项专项修复冻结；不代表全单元终审）
- **交付物文件集**:`git diff HEAD --name-only -- . ':!research/design/workbench/**'` 排序所得 32 个生产实现、直接测试、S7 门禁及架构/规格文件；另有 3 个 `research/design/workbench/` 流程账本路径，不参与功能指纹
- **当前交付物指纹**:`c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`；算法为对排序后的 32 个非工作台路径逐文件计算 SHA-256，以 `path<TAB>hash`、LF 与末尾 LF 形成 UTF-8 清单后再计算 SHA-256
- **架构来源**:`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`，以及已定稿开发清单 D33-01～D33-08

## 固定边界

- **功能范围**:同一 `CheckpointEnvelope.v1` 下的全量 authority payload、每日与迁居前强制 checkpoint 接缝、独立目录或 active paired device 单目标 adapter、恢复包真解封、`fullBackupReady`、新代替换与 27 天回收，以及两生产根的唯一 owner、生命周期、管理入口、S7 门禁和直接证据
- **架构不变量**:current anchor 的唯一 `AuthorityCommitLog` / `ArtifactStore` / `ArtifactLifecycleIndex` / storage governor 是权威事实源；full coverage 与 retention 使用同一分类谓词；root/chain/source generation、target binding 和物理文件身份必须冻结且可重驱；秘密不回显，路径与 wire 边界 fail-closed；可选备份故障不得阻断普通业务
- **验收条件**:U33-01～U33-12 均达到“已验证”；P0/P1 清零；full capture、generation readiness、target lifecycle、资源与物理边界、兼容/秘密/状态/可用性及 S7 必要证据在两生产根取得成比例直接证据
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
| target binding 与 checkpoint lifecycle | 耐久 target binding map + lifecycle facts | owner 按 targetId 解析并重驱至终态 | 目标切换、旧 target 离线、效果后丢响应、重启/到期 | setup/owner/service → verify/cleanup/status | 旧 binding 只保留未终态义务，27 天回收有界 | 通过 |
| storage governor 与 lifecycle abort | current anchor storage governor + owner abort signal | 每个物理 I/O step 前取得 permit | 大资产、容量/磁盘不足、网络挂起、stop | capture/CAS/target/transport → owner lifecycle | 流式有界；permit 不跨网络或 authority/store 锁 | 通过 |
| directory/paired root 与文件身份 | 冻结 root binding、opened handle identity、durable progress | no-follow open、同 handle fsync、exact-set 核对后推进 | root/file 替换、begin 崩溃、乱序/丢响应 | 两 target adapter → owner/service | staging/文件集合有界且可重驱 | 通过 |
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
| R33-04 | target binding、重驱与 retention | binding config、target resolver、owner/service、setup/status/cleanup | `c66cd68d…`（32 文件内容清单） | target 配置、resolver、lifecycle/cleanup 输入变化 | 失效 | 0/2 | U33-04 专项修复通过；C33-C12/C14 已同根闭合 |
| R33-05 | I/O 资源治理与 stop | governor、capture/CAS、directory/paired transport、lifecycle signal | `c66cd68d…`（32 文件内容清单） | 物理 I/O、permit 或 stop 顺序变化 | 失效 | 0/2 | U33-05 专项修复通过；C33-C05/C13/C16 已同根闭合 |
| R33-06 | root/file identity 与 durable progress | directory/paired adapter、staging、fsync/progress、故障测试 | `c66cd68d…`（32 文件内容清单） | root binding、open/fsync/progress 输入变化 | 失效 | 0/2 | U33-06 专项修复通过；C33-C06/C14/C15 已同根闭合 |
| R33-07 | paired result 严格解码 | result codec、pairing socket/client 与命令关联断言 | `c66cd68d…`（32 文件内容清单） | codec 或任一推进字段变化 | 失效 | 0/2 | U33-07 专项修复通过；P2 价值边界未扩大 |
| R33-08 | v1 recovery package 兼容 | recovery codec、backup/pairing 入口、S2 mesh-ready replay | `c66cd68d…`（32 文件内容清单） | v1/v2 codec 或旧 replay 消费路径变化 | 失效 | 0/2 | U33-08 专项修复通过；v1 仍只产生 S2 mesh-ready |
| R33-09 | 恢复秘密输入边界 | backup verify/pairing CLI、TTY reader、输出与错误路径 | `c66cd68d…`（32 文件内容清单） | 输入 reader 或 CLI 输出路径变化 | 失效 | 0/2 | U33-09 专项修复通过；两入口共用无回显 reader |
| R33-10 | 公开状态与稳定错误 | owner status、server.info、CLI status、verification failure | `c66cd68d…`（32 文件内容清单） | DTO、认证边界或错误映射变化 | 失效 | 0/2 | U33-10 专项修复通过；P2 与认证边界价值裁决不变 |
| R33-11 | 可选 backup owner 与普通业务隔离 | CLI/server 两生产根、配置解析、paired runtime 与 unavailable 状态 | `c66cd68d…`（32 文件内容清单） | 组合根装配或错误边界变化 | 失效 | 0/2 | U33-11 专项修复通过；availability 与 trust/root fail-stop 分层 |
| R33-12 | 入口 exact-set 与必要恢复证据 | S7 capture/validator/golden、实际 owner/receiver/CLI descriptor、两生产根小表 | `c66cd68d…`（32 文件内容清单） | 生产入口、角色、门禁或必要证据变化 | 失效 | 0/2 | U33-12 专项修复、S7 与两个 P0 小表通过；待后续正式独立审查 |
| R33-13 | 跨项组合推演 | R33-01～R33-12 当前输入、结论及交界 | `c66cd68d…`（R33-01～R33-12 当前输入汇总） | 任一前置项边界、输入或结论变化 | 失效 | 0/2 | 四路专项对抗已核对直接交界；不计正式冻结终审深审次数 |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U33-01 | **P0/中。**`captureFullAuthorityCheckpoint` 把冻结前缀内全部非 checkpoint record 原样纳入，又以“≤8 MiB canonical JSON 通用 ref 递归”自行推断资产；当前 `ArtifactLifecycleIndex` 只在 surface-asset authority 内拥有真正的删除/保留投影，capture 没有读取同一冻结 source-head 的窄端口。因此已删除会话资产可被带入，非通用 JSON 或大于阈值但仍受保留的注册资产可被漏掉，随后仍能真解封并宣告 full verified。**价值裁决记录：**原 P0/大命中根因，但“需要新 capture 规划”被现有分类与 lifecycle 原语证伪；方案收窄为复用接入，改为 P0/中，重开扩面条件为现有原语无法表达任一当前必备内容类。**收敛记录（2026-08-08）：**“取当前 index”仍会与先前冻结前缀错代；必须由现有 index 提供精确 source-head 快照，若 index 已越过该头则整次 capture 以新前缀重试，禁止回退或猜测历史状态。 | coverage 标签、注册型 retention 分类和删除投影没有共享一个精确 source-head vector；通用爬取因此成为第二套保留谓词。 | **生产端：**core retention/index、current-anchor assembly、mesh capture/owner/service。**组合：**六类权威内容、会话删除、共享/嵌套/外置/大资产、index 落后/损坏/越代、缺 ref、checkpoint 防递归。**消费者：**verify/readiness及第 34 单元只读窄接缝。**异常终态：**缺类或携带已删除内容却 full-ready。**直接证据：**真实 `AuthorityCommitLog`/`ArtifactStore`/`ArtifactLifecycleIndex`，并发追加/删除与连续重启；IR33-06/07/33/36。 | 在现有 `ArtifactLifecycleIndex` 增加只读 checkpoint-retention 端口并由 current-anchor 组合根注入 capture：先冻结 index 全部 source heads，按主 `DurableLogCheckpoint` 读取恰好该前缀；只用 `classifyRetainedRecordReferences`、`collectRegisteredArtifactRoots` 及其注册型解析器生成候选传递闭包，再由 index 在同一 source-head vector 过滤 live retention。index 落后则追平到该头，损坏则既有 rebuild 后重试，已越头/任一源变化则丢弃本轮并冻结新头；禁止通用 JSON 扫描。所有 ref 逐项验 digest/bytes，checkpoint stream 不入候选；任何不可分类、deferred、缺失或损坏均在 `checkpoint-created` 前零副作用失败。验收覆盖六类、删除、共享/嵌套/外置/>8 MiB、index 落后/损坏/越代、缺 ref、并发与重启，载荷 retention 与冻结快照全等。 | 已验证 |
| U33-02 | **P0/中。**daily ID 只含 home/issuer/target/date，不含 recovery root 与 trust chain；`checkpoint-created` 未耐久冻结完整 root/chain/source identity，`status()` 又只看 recipient、verification 签名和 full envelope，不打开/反绑加密 payload 的 `trustChainHead`。同日 rotate 会复用旧 ID 冲突，同一 root 下 chain 推进后旧 verified 仍可投影 current ready。价值裁决保留 P0/中。 | root generation、chain generation、source prefix 与 request identity 没有成为 created→verified→readiness 共用的稳定代际键。 | **生产端：**owner candidate、service/lifecycle records、recovery payload/status。**组合：**同日 root rotate、同 root chain 变化、daily/forced、source prefix、fresh/exact replay。**消费者：**verify、status、`fullBackupReady`、第 34 单元窄接缝。**异常终态：**旧代误报 ready或新代无法创建。**直接证据：**响应丢失、并发、连续重启；IR33-17/22/26/29。 | 在现有 checkpoint lifecycle 定义唯一 generation binding：`rootKeyId + recipientKeyId + trustChainHead + targetId`；入口 request key 固定为 `daily:<UTC day>` 或 `forced:<requestId>`。service 先按二者 exact replay，fresh 才冻结 U33-01 的 source checkpoint，并以 `generation + request + source(logId/lsn/prefixDigest/frameEndOffset)` 派生最终 checkpointId；`checkpoint-created` 耐久写齐这些字段并与 envelope/payload 全等。verify 在同一日志事务核对 created/replicated、当前 root/chain、source 与已解 payload后写 terminal；readiness 只接受当前 root/chain 的全等 created+verified，不需持秘密重新解封。root/chain 变化使旧代只留历史，不计 current ready、不 rewrap、不提前误删。验收覆盖同日 rotate、同 root chain 推进、daily/forced、效果后丢响应、terminal replay和连续重启，新旧代及 source prefix 不混用。 | 已验证 |
| U33-03 | **P2/小。**owner 只有无 key 的全局 `#active`，forced 在 daily 运行时会加入并返回 daily checkpoint；当前没有公开 forced consumer，损失限于内部请求关联。**价值裁决记录：**原 P1 以第 34 单元未来消费者为当前损失，举证不足，降为 P2/小；重开条件为本单元出现实际 forced consumer或第 34 单元启用该接缝。 | single-flight 未绑定 U33-02 的 generation/request candidate key，不同请求被错误当成同一执行。 | **生产端：**daily/forced owner。**组合：**同 key/不同 key、daily→forced/forced→daily、响应丢失、stop/restart。**消费者：**内部 forced 接缝。**异常终态：**返回非 originating candidate但当前无公开数据损失。**直接证据：**双序与 replay；IR33-09/10/19。 | 将 `#active` 收为 `{candidateKey,promise,abort}`；candidateKey 直接复用 U33-02 的 generation+request key。同 key 加入同 promise；不同 key 立即返回稳定、可重试的 `checkpoint-candidate-busy`，不排队、不串行代替、不新增队列。完成/失败只清同 key，stop 只取消当前 key；后续同 request 由 lifecycle exact replay。验收覆盖双入口双序、同/异 key、响应丢失、stop 与重启，绝不把一个 candidate 作为另一个返回，且不启用第 34 单元消费者。 | 已验证 |
| U33-04 | **P1/中。**`FileBackupTargetConfiguration` 耐久保留旧 binding，但 `createConfiguredCheckpointOwner`/`AuthorityCheckpointService` 只实例化当前 target；启动不按 lifecycle 枚举旧 target 的 created/replicated/superseded/cleanup，`setup` 切换也不通知运行中 owner。本地 envelope/chunks 没有 target/local 两段耐久回收进度。价值裁决保留 P1/中。**收敛记录（2026-08-08）：**`backup setup` 是独立 CLI 进程，仓库不存在可复用的 checkpoint-owner 管理唤醒 facade；原“setup 唤醒运行中 owner”不可执行，方案改为 setup 自身完成新 binding 的首次创建/复制，owner 在每个既有入口前重载耐久配置，不新增 IPC、watcher 或 reload RPC。 | binding map、按 targetId 的 adapter 解析和 checkpoint lifecycle 没有归属同一 owner/recovery loop。 | **生产端：**backup config/setup、owner/service/target resolver、checkpoint stream与 lifecycle index。**组合：**当前/历史 target、setup 切换、created/replicated/superseded、target/local cleanup。**消费者：**verify/status/retention。**异常终态：**旧 target pending 永不续做或 27 天后本地/远端密文永久滞留。**直接证据：**效果后丢响应、离线目标、连续重启、27 天；IR33-11/18/20/23/25/26/28。 | 把 service 的固定 target 改为复用 durable binding map 的窄 `resolveTarget(targetId)`：新 candidate 只取当前 binding；任何既有 record 必须按其冻结 targetId 打开当前或历史 adapter。owner 在 startup recovery、每次 daily/forced、verify/status 与重试 turn 前重载 durable config并扫描 checkpoint stream，按 checkpointId 重驱 created→replicated及到期 superseded；target retire 成功、local envelope/chunks 经既有 lifecycle 引用栅栏回收后，分别在同一 checkpoint stream 写幂等 target/local cleanup progress，任一步失败保留原义务。旧 binding 仅在零未终态引用后可删；`backup setup` 自身在返回前按新 binding 完成首次创建/复制，运行中 owner 最迟在下一既有入口采用新 current binding。验收覆盖切换前后、setup 返回终态、无新增进程通信、昨日 pending、target/local 清理各步丢响应、旧 target 离线再恢复、27 天边界和连续重启，恰一收敛且共享资产零误删。 | 已验证 |
| U33-05 | **P1/中。**本地 checkpoint CAS put/get 与首次 pairing capture 绕过 governor；`openFullAuthorityCheckpoint` 解出全部 chunks 后再 `Buffer.concat` 整份 records/artifacts；directory/paired target 接口不接收 owner signal，paired transport 虽支持 signal但调用方不传。价值裁决保留 P1/中。 | `authority-checkpoint` 资源义务只覆盖部分 source/target step，没有贯穿 CAS、crypto、网络与 owner 生命周期。 | **生产端：**capture、checkpoint crypto、local CAS、directory/paired target/transport、cleanup。**组合：**零/大资产、并发、容量饱和、磁盘满、网络挂起、取消/stop。**消费者：**owner lifecycle及同进程普通业务。**异常终态：**内存随备份线性增长、限额绕过、stop 无界或错误推进。**直接证据：**各物理步骤、响应丢失与重启；IR33-08/16/28/32。 | 将现有 target `write/read/retire` 与 service/capture/open 内部 step 统一接收 owner lifecycle signal；log page、artifact `readRange/putVerifiedStream`、加解密块、local CAS、directory 文件、paired append/range/retire、cleanup 均以稳定 checkpointId+step identity 进入现有 governor。网络读取先取得有界 chunk，permit 不跨网络、authority log、artifact-store 或 lifecycle 锁。把现有 crypto open 改为逐块解密、按 payload 目录增量验 hash/length并及时清零，不再聚合整份 plaintext；取消后零新 lifecycle progress，恢复复用同 checkpointId。验收证明零/大资产内存与并发有界，容量不足、磁盘满、网络挂起、取消/stop、效果后丢响应及连续重启均不假成功、不泄 permit。 | 已验证 |
| U33-06 | **P1/中。**directory adapter 用 `writeFile(wx)` 创建后按路径重新 `open(r+)` fsync，无法证明 fsync 的仍是创建 inode；`FilePairedCheckpointStaging` 不冻结 configured/checkpoint root 的 link/reparse/物理身份，`begin` 只写 envelope 后 sync 目录便确认。**价值裁决记录：**原结论还把额外文件与 staging retention 作为 P1 主张；复核证明其仅影响健壮性/空间，P1 只保留错 inode 与虚假 durable progress，评级/工作量仍 P1/中；重开扩面条件为额外文件可影响当前读取或安全删除。 | configured root、owned checkpoint root、最终 file handle 与 durable progress 没有绑定同一物理快照。 | **生产端：**directory adapter、paired staging/receiver。**组合：**root/file symlink或reparse、绑定/写读中替换、越根、乱序、begin/append/commit。**消费者：**owner/service 的续传与验证。**异常终态：**根外读取/写入、fsync 错 inode或 begin 已确认却不可续做。**直接证据：**崩溃、丢响应、连续重启；IR33-12/13/15/31/32。 | 复用 directory root binding：两 adapter 初始化时以 `lstat→realpath→lstat+canonical stat` 冻结 configured root，拒绝 root 自身 link/reparse/非目录；每个 checkpoint owned root 同样冻结并逐步复核 containment/dev/ino。最终文件以 `O_CREAT|O_EXCL|O_NOFOLLOW` 一次打开，在同一 handle 写入、`sync`、stat，再与路径 lstat/realpath 全等复核后关闭；目录 fsync 与 exact-set 核对完成后才返回 begun/stored progress。读取沿用 no-follow handle 前后 identity，任何漂移在根外正文/新 progress 前失败。验收覆盖两 adapter 的 root/file 替换、越根、begin 崩溃、乱序/丢响应和连续重启，根外/错 inode零副作用；不恢复“额外文件 retention”主张。 | 已验证 |
| U33-07 | **P2/小。**普通 mesh transport 会调用 `assertPairedResult`，pairing socket 只核对外层 frame 后把内部 result 强转；现有 target 客户端随后已逐命令反绑 type、checkpointId、seq/offset/progress、bytes/digest，因此当前额外字段不会错误推进 activation。**价值裁决记录：**原 P1 的“跨命令结果可推进”被现有断言证伪，降为 P2/小；重开条件为发现任一未手工反绑字段可影响 durable/activation。 | 同一 wire 联合在普通 mesh 与 onboarding pairing socket 走了不同 decoder，严格 exact keys 形成双实现。 | **生产端：**paired result codec、Mesh transport、pairing socket transport。**组合：**begun/progress/appended/stored/manifest/range/retired、额外/缺失字段及错关联。**消费者：**paired target client。**异常终态：**当前仅严格性分叉，无错误 activation。**直接证据：**IR33-04/05/14/31。 | 从现有 paired module 导出唯一严格 result decoder；普通 mesh 与 pairing socket 都在返回给 client 前调用它，client 继续反绑 originating command 的 checkpointId/seq/offset/progress/bytes/digest/supersededBy。验收覆盖全部合法 state、额外/缺失字段、错 command/checkpoint/seq/offset/progress/digest，非法结果零 progress、合法两 transport 零误杀。 | 已验证 |
| U33-08 | **P1/小。**v1 recovery package 的 `legacyCheckpoint` 已由 codec 严格解出，但 backup 初次 root 与 pairing root-activation 都只取 `decoded.root`，随后另造 full checkpoint；旧包内 S2 trust-only checkpoint 从未交给已经能同时打开 full/trust-only 的 `RecoveryActivationCoordinator`。价值裁决保留 P1/小。 | 兼容 payload 停在 codec，未接回现有 S2 root-activation replay 线性化点。 | **生产端：**recovery codec、backup initial-root、pairing onboarding。**组合：**v1 legacy、v2 secret-only、未知版本、fresh/exact replay。**消费者：**既有 S2 mesh-ready 投影。**异常终态：**旧包解码成功却效果丢失或被错误当 full。**直接证据：**响应丢失/连续重放及 readiness 隔离；IR33-03/34。 | 新 encoder 继续只产 v2。两个 root-activation 入口解码后：存在 `legacyCheckpoint` 时校验其 root-activation plan、issuer、candidate root 与当前 chain，直接把该 checkpoint 交给现有 `RecoveryActivationCoordinator.activatePrepared`，使用当前受限 directory/onboarding target 做幂等 write/read/commit；不存在时才走新 full capture。legacy terminal 只维持既有 mesh-ready，绝不产生 `fullBackupReady`，普通 periodic `backup verify` 也不得把 v1 当 full。验收覆盖 v1 fresh/效果后丢响应/terminal replay、v2 无 legacy、未知版本拒绝和 mesh-ready/full-ready 隔离。 | 已验证 |
| U33-09 | **P1/小。**backup verify 与 pairing 回读均用 `readline.question`；backup 虽先检查 TTY，输入仍回显，pairing 连非 TTY 也未 fail-closed。价值裁决保留 P1/小。**收敛记录（2026-08-08）：**仓库没有可直接复用的成品 secret-line reader；可复用的是现有 stdin ownership/raw-mode/key-event 原语，故方案收窄为一个 recovery-package 专用 reader，不能假定不存在的机制。 | 高熵恢复秘密没有共享一个无回显、可取消、可清零的 TTY 输入边界。 | **生产端：**backup verify/initial root 与 pairing root 回读。**组合：**TTY/非 TTY、paste/backspace/enter、取消/异常。**消费者：**recovery decoder。**异常终态：**用户粘贴秘密进入屏幕、录屏或终端缓冲。**直接证据：**IR33-21/31。 | 在 CLI 现有 stdin ownership、raw-mode 与 key-event 原语上实现单一窄 `readRecoveryPackageFromTty`：只接受 TTY，提示不渲染字符，支持 paste/backspace/Enter/Ctrl-C，累计到有界可变 buffer并直接交 recovery decoder，finally 清零；两入口共用，非 TTY/取消返回稳定可行动错误。验收覆盖 TTY 成功、非 TTY、取消、异常及两入口，除创建流程有意的一次性展示外，输入秘密不进入 stdout/stderr/错误/日志且 buffer 清零。 | 已验证 |
| U33-10 | **P2/小。**内部 `RecoveryBackupStatus` 含 checkpointId/targetId/upToLsn并被 `server.info` 原样透传；status 异常被 catch 成字段缺失，`checkpoint-verify-failed` 又耐久化原始 `error.message`。**价值裁决记录：**原 P1 将内部术语暴露等同核心安全失守；RPC 为已认证第一方边界且值非恢复秘密，降为 P2/小；重开条件为未认证 consumer 可达，或错误可含恢复秘密/可利用绝对路径。 | owner 内部恢复身份、用户状态 DTO 与耐久错误分类没有单一投影边界。 | **生产端：**service verify/status、CLI runtime、server.info。**组合：**not-configured/pending/recoverable/unavailable、各验证失败。**消费者：**认证 RPC 与 CLI status。**异常终态：**状态消失、内部身份或原始路径/错误暴露。**直接证据：**IR33-23/24/31/34。 | 保留 mesh 内部 status 供 owner 使用，在 CLI/server 边界投影唯一公开联合 `{state:not-configured|pending-verification|recoverable|unavailable,fullBackupReady,nextAction?}`；不得带 checkpoint/target/LSN/digest。将 verify 失败在写日志前映射为有限 code（target-unavailable/package-invalid/checkpoint-mismatch/verification-failed），原始异常不进 lifecycle；`server.info` 不再吞成 undefined，CLI 按相同 code 输出可行动文案。验收覆盖全部状态与失败类，公开 exact keys稳定、无原始错误/内部身份，内部 replay 信息不丢且不建新状态框架。 | 已验证 |
| U33-11 | **P1/小。**`createConfiguredCheckpointOwner` 在 server ready 前解析目标并创建 paired adapter；binding 缺失、坏配置或缺 mesh runtime 会抛出，使可选备份故障阻断普通 serve，离线 target 也没有可持续的 unavailable owner 状态。价值裁决保留 P1/小。 | 可选 target/config 的可用性错误与 home trust/root 身份破坏共用组合根异常通道。 | **生产端：**single-machine/current-anchor 与 anchor+executor 两根、backup runtime/config、paired target。**组合：**未配置、坏配置、target 离线、runtime 缺失、trust/root/member 损坏、reload。**消费者：**普通会话与 backup 命令/status。**异常终态：**可选故障使全服务不可用或静默无状态。**直接证据：**IR33-23/34。 | 在现有 CLI 组合根建窄 backup runtime slot：`disabled | available(owner) | unavailable(code)`，只包装 checkpoint owner，不做通用插件框架。无配置为 disabled；配置解析、target 离线或 paired runtime 暂不可用进入 unavailable，普通 server 继续 ready；slot 在 startup recovery、daily/forced、verify/status 与重试 turn 前重载配置并周期重试，`backup setup` 自身完成新 binding 的首次创建/复制，不新增唤醒通道。backup 命令/status返回稳定 action。home trust 不可重放、issuer/member/root key 身份矛盾仍在 server ready 前 fail-stop，禁止降级。验收覆盖两生产根的三类可用性故障与恢复、普通会话仍可用、下一既有入口 reload 生效，以及 trust/root 损坏仍阻断。 | 已验证 |
| U33-12 | **P1/中。**S7 `recovery-backup` 组只从 Commander 捕获 setup/verify/status；daily/forced 与 paired put/get/retire 没有生产 descriptor，owner/receiver 仅被 token/字符串启发式检查。直接测试也没有真实 lifecycle index 的 U33-01 retention 分叉与 U33-02 root/chain readiness，故门禁可在两个 P0 存在时保持绿色。**价值裁决记录：**原方案“覆盖 P33-01～P33-11”可能扩成重复矩阵，现收窄为实际入口 exact-set 与 P0 必要证据，维持 P1/中；重开扩面条件为新增生产入口或现有直接证据无法覆盖另一个阻断根因。 | 标签/happy path 代替有限生产注册源 exact-set 与两个核心恢复不变量，结构门禁和提交证据没有同一来源。 | **生产端：**setup/verify/status、owner daily/forced、paired put(begin/progress/append/commit)/get(get/range)/retire、onboarding/active receiver、两生产根。**组合：**角色、顺序、删除、重复、错 owner、绕过。**消费者：**S7 lint/golden与直接验收。**异常终态：**入口漂移或 P0 数据缺口不被拒绝。**直接证据：**IR33-30/33/36。 | 保留现有 S7 lint：Commander CLI 继续由真实注册捕获；checkpoint owner 与 paired receiver 各导出并实际驱动一个冻结窄 descriptor，分别声明 daily/forced 和 put/get/retire 的 wire phase exact-set、owner/role与顺序，S7 只解析这些有限 literal并与架构 row/golden 双向全等，删除/重复/错角色/错序/旁路均失败。直接证据只增加两张小表：真实 log/store/index 的六类 retention+删除，以及 directory/paired 两生产 profile 的 root/chain rotate readiness；其余 codec/target/TTY/status 场景复用各问题直接测试。验收要求实际生产变异 fail-closed、合法拓扑零误杀；不建新 lint/runner、全问题复制矩阵或配置×故障笛卡尔积。 | 已验证 |

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

## U33-01～U33-12 四路冷启动对抗复审

> 基线为交付指纹 `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a` 上同一份未修改问题列表与 F33-01～F33-16；四路分别从当前架构、规格和生产源码重新构造反例，不复用其他路结论。本表是十二项专项修复对抗记录，不计全单元冻结终审或独立功能审查轮次。

| 路线 | 冷启动反例与双向对账 | 结论 |
| ---- | -------------------- | ---- |
| A full capture/retention 与 generation readiness | 从当前源码重造删除后仍有 ref、注册型大资产、index 落后/越头、同日 root rotate、同 root chain 推进、source prefix 响应丢失及同/异 candidate key；核对 index snapshot、generation created binding、readiness 与 single-flight | 通过；U33-01/02/03 的 source/generation/candidate 身份唯一，C33-C01～C03 已同根闭合 |
| B candidate/target lifecycle 与物理身份 | 从当前源码重造旧 target pending、独立 setup 切换、27 天双段清理、directory/paired root/file 替换、begin 崩溃、随机中断目录及 Windows retired 路径；核对 target resolver、稳定 staging、no-follow handle 与 cleanup progress | 通过；U33-04/06 边界清晰，C33-C04/C06/C12/C14/C15 已同根闭合，额外文件主张未恢复 |
| C 资源/兼容/秘密/状态与普通业务隔离 | 从当前源码重造整包 plaintext、网络返回后未治理 decode、嵌套 permit、网络挂起 stop、v1 旧包、TTY 泄密、raw error、坏配置/缺 runtime 与 trust 损坏；核对 governor 叶步骤、增量 open、现有 coordinator、CLI reader、公开 DTO 与 slot | 通过；C33-C05/C07～C10/C13/C16 已复核，P2 边界未升级，optional unavailable 不削弱 trust fail-stop |
| D production exact-set/必要证据与范围价值 | 删除/重复/错角色/错 phase owner/receiver 入口并让 token 仍存在，重造组件绿但两个 P0 仍坏；核对生产 descriptor、S7 literal exact-set、真实 retention/readiness 小表及第 34～38 单元排除符号 | 通过；C33-C11 与 U33-12 已闭合，不复制十二项矩阵、不建新 lint/runner，后继范围未提前实现 |

**交界差异审计：**`U33-01↔U33-02` 以同一 source-head/generation created binding 衔接；`U33-02↔U33-03` 共用 candidate key；`U33-04↔U33-05↔U33-06` 共用 targetId、owner signal、governor、root/file identity 与 cleanup progress；`U33-07～U33-11↔U33-12` 仅共享有限 descriptor 与直接证据，不把 P2 升级为门禁扩面。C33-C01～C33-C16 均以“同根合并”关闭；专项审查与四路记录一致，十二项与第 34～38 单元排除边界全等，无未处置反证。

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
| V33-01 | full capture/index、generation/single-flight、target lifecycle/governor/physical identity、strict codec 与稳定错误码 | mesh 直接文件 12 项；物理与 staging 修改后只复验受影响项；C33-C16 后补 mesh 类型检查与 5 个直接用例 | core retention/contracts；mesh checkpoint/full/service/owner/directory/paired；真实 log/store/index 测试 | 修复直接验证；合并证据 + C33-C16 28.71s | 原合并证据 12/12；staging/retired、root replacement、hardlink、old target、27 天双段清理、响应丢失均通过；C33-C16 后 mesh tsc 0 error、直接测试 5/5 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-02 | v1 trust-only replay、恢复秘密零回显、runtime slot 与 pairing 兼容 | CLI 4 个直接文件 | mesh runtime bootstrap、backup owner、TTY reader、pairing production command | 修复直接验证；24.34s | 4 files / 16 tests passed | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-03 | 公开 recovery status exact keys 与 raw identity 隔离 | server status 定向单例 | server context/info method 与公开 DTO | 修复直接验证；5.14s | 1/1 passed | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-04 | owner/receiver descriptor exact-set、实际分支反绑及 golden | `pnpm s7:lint` | S7 validator/tests、mesh owner/receiver descriptor、架构 recovery-backup 行 | 派生资产/合同预检；55s | 17/17 Node tests + canonical golden passed | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-05 | 受影响包类型闭包 | build 后 mesh/server `tsc --noEmit`；CLI 同命令作基线诊断 | mesh/server/CLI 当前源码与已完成 dist | 修复直接验证；约 37s + C33-C16 mesh tsc | mesh/server 0 error；C33-C16 后 mesh 再次 0 error；CLI 仅 8 个既有 config-editor/startup credential 类型错误，零触及文件错误 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-06 | 当前生产源码和跨包导出可消费 | `pnpm build` | 17 个 workspace 项目当前生产输入 | 最终构建证据；154.4s | C33-C16 修复后 exit 0，17/17 workspace build succeeded | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-07 | 交付差异卫生 | changed TS/MJS Biome 诊断；`git diff --check` | 当前变化路径 | 交付预检；<3s | diff check 通过；C33-C16 两个生产文件 Biome 通过；direct test 原有 `mkdtemp/tmpdir` 两条基线限制未扩散 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |
| V33-08 | F33-01～F33-16 事实链、四路专项对抗与范围边界 | 同一指纹上只读重建 A～D 四路并审计 C33-C01～C33-C16 | 32 个交付文件、架构/规格、正式问题/矩阵/反证账 | 专项只读复审；不计全单元终审 | 四路通过；16 个反证均同根关闭；第 34～38 单元能力未进入生产装配 | `c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`（32 个非工作台交付文件） | 有效 |

## U33-01～U33-12 专项修复收口记录

> 本节只证明十二项正式问题在同一交付指纹上完成实现、直接验证与四路冷启动对抗；不替代、不计入全单元两轮冻结终审、独立功能审查或单元提交验证。

- **冻结指纹**：`c66cd68d588f72caf4893573056077d7f9f921e22308e81aeed31a923638467a`；32 个非工作台交付文件，算法见“当前状态”。
- **固定矩阵**：F33-01～F33-16 全部逐格绑定 source-head、generation/request/candidate、target/checkpoint/file、package/result/status 身份及耐久线性化点、零副作用边界和直接证据。
- **直接验证**：V33-01～V33-07 有效；当前输入 workspace build 17/17 通过，C33-C16 后 mesh 类型检查及 5 个直接用例通过，S7/golden 与差异卫生通过。
- **四路冷启动对抗**：A～D 均在同一冻结指纹上通过；C33-C01～C33-C16 只能且均已按“同根合并”关闭，无当前源码证伪后仍悬置的主张。
- **范围审计**：价值裁决对 U33-01/U33-06/U33-12 的方案收窄及 U33-03/U33-07/U33-10 的 P2 边界保持有效；第 34～38 单元 planned/disaster transfer、恢复应用、全局同步与生命周期能力未进入生产装配。
- **专项结论**：U33-01～U33-12 均为“已验证”；P0/P1/P2 当前问题全部闭合。后续若进入全单元流程，仅从下方“失效”的正式审查项继续，不得把本节当作冻结终审轮次复用。

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
| IF33-02 | target 生命周期、物理路径与资源故障 | config/binding、directory/paired adapter、governor/abort；当前专项指纹 `c66cd68d…` | 失效 | U33-04～U33-06 已专项修复；输入变化后尚未执行正式独立功能审查 | binding、I/O、root/file identity 或 stop 变化 |
| IF33-03 | compatibility、秘密输入、状态与可选 owner 隔离 | recovery codec、CLI TTY、status、两生产根；当前专项指纹 `c66cd68d…` | 失效 | U33-08～U33-11 已专项修复；输入变化后尚未执行正式独立功能审查 | codec、输入、DTO、装配错误边界变化 |
| IF33-04 | wire 严格性、single-flight 与产品范围价值 | paired result、daily/forced owner；当前专项指纹 `c66cd68d…` | 失效 | U33-03/U33-07 已专项修复，P2 价值边界保持；待正式独立功能审查 | candidate consumer或任一推进字段变化 |
| IF33-05 | 生产入口 exact-set 与必要证据 | S7 descriptor/golden、真实 log/store/index 与两生产根；当前专项指纹 `c66cd68d…` | 失效 | U33-12 已专项修复且直接门禁通过；待正式独立功能审查 | 入口、角色、门禁或必要证据变化 |
| IF33-06 | 跨区组合核查 | IF33-01～IF33-05 当前边界、输入与结论；当前专项指纹 `c66cd68d…` | 失效 | 四路专项对抗已通过但不计独立功能审查；待前置风险面正式覆盖后重审 | 任一前置风险面边界、输入、状态或结论变化 |

<!-- registration-complete: unit-33.gen-1 -->
