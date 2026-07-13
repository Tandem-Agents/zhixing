# 开发单元审查与修复工作台

> **静态区**：本区记录固定问题、收敛规则和提示词，未经用户明确要求不得修改或清理。

## 一、问题描述及分析

第 8 单元主体开发约用 40 分钟。随后以“修复到本单元没有问题为止，并连续两轮审查无新增问题”为目标进入审查修复，约 3 小时后仍未完成：第一轮无新增问题审查尚未通过，最新修改仍待验证。

实际过程中，先后围绕秘密存储、迁移、并发与崩溃恢复、安全边界、凭据最小投影、启动流程及其消费者发现问题；每发现一处便进行修复和局部验证，再继续审查，后续又发现其他问题并重复该过程。实际工作循环是“审查发现问题 → 立即修复 → 局部验证 → 继续审查”，没有先形成一份完整问题清单再集中处理。

## 二、目标模式协作协议

### 1. 唯一目标与完成条件

在不降低审查深度、测试覆盖或最终质量的前提下，高效完成当前单元的审查与修复：必要影响面达到最优架构、不留已知债务；同一份未修改交付物的全部验收与必要验证通过，并连续两轮完整审查无新增真实问题后立即结束。

后续单元、无关重构和架构未要求的无限防御不在范围内；确需改变边界时先重新确认，禁止静默扩面。

### 2. 执行闭环

| 阶段             | 完成门禁                                                                                                     | 下一步                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 边界锁定         | 来源、范围、不变量、验收、精确交付物、既有证据及关键原语清单齐全                                           | 问题盘点                                                 |
| 问题盘点         | 整轮只读；关键原语五项检查与九类核查面全部完成，问题一次收齐                                               | 有问题进入问题裁决；零问题进入冻结准备                   |
| 问题裁决         | 按根因去重；每项写清事实、完整影响面、最优方案、共同验证范围和验收条件                                     | 集中修复                                                 |
| 集中修复         | 全部问题一次修完；同根风险反查无遗漏，只做一次合并后的直接验证                                             | 冻结准备                                                 |
| 冻结准备         | 交付物文件集全部计入派生产物闭包表且结论通过/不适用；事实包完整，计算并冻结交付物指纹                     | 冻结终审                                                 |
| 冻结终审         | 冻结指纹与事实包；两轮共享机械事实但独立裁决，分别审功能边界及并发、崩溃、安全、资源上界、测试盲区，均零新增 | 最终验证；任一轮有问题则回问题裁决                       |
| 最终验证         | 受影响包全测、必要构建及导出、golden、安全/结构门禁按依赖顺序各执行一次，全部通过且未修改交付物             | 完成；失败需修改则回问题裁决                             |
| 完成             | 两轮终审与全部必要验证属于同一份未修改交付物                                                               | 立即结束                                                 |

### 3. 五条核心规则

1. **关键原语查透**：对每个状态变化、耐久写、并发竞争或外部副作用，逐项核对唯一事实源、生效/线性化点、崩溃与竞争插点、全部生产者/消费者、时间与空间上界；存在缓存、索引、增量计算、短路或其他快速路径时，以权威事实源上的完整计算为正确性基准，列明成立与失效条件，并用正反例差分验证等价，无法证明则不得冻结；再映射九类核查面。缺一项，问题盘点不得结束。
2. **先审完再修**：问题盘点整轮只读，只登记问题；全部扫完后按根因合并，一次覆盖生产端、类型组合、消费者、异常终态和测试，再集中修复。
3. **闭包先于冻结**：问题盘点零问题或集中修复完成后，都必须进入冻结准备。交付物文件集中的每个文件或同类组必须在派生产物闭包表中落账，覆盖其 lockfile、golden、schema/快照及结构/导出基线；无派生项须写明依据。存在未归类项、待核查项或未同步项不得冻结，也不得提前运行包级全测、全量构建或最终门禁。
4. **昂贵验证只跑一次**：同一冻结指纹两轮终审零新增后，才执行受影响包全测、必要构建及最终门禁；同一目标已有相同输入的有效证据时禁止重跑，失败先归因再决定最小补证。
5. **指纹与事实包决定收敛**：冻结时把架构边界、文件与指纹、关键原语、跨边界消费者、派生产物映射和有效证据组成事实包。两轮终审共享这些机械事实但独立形成结论；交付物变化使结论归零，证据仅按输入闭包失效。最终验证不修改交付物，达到完成条件立即结束。

### 4. 动态区维护

- 动态区是唯一状态源。每次开始、目标续跑或历史压缩后先完整读取本文；阶段转换前写完当前结果，转换后立即更新状态。
- 本文和构建产物不属于交付物；暂存状态不影响指纹。动态区格式固定，只维护字段值和表格内容；已解决问题保留到完成。
- 冻结前，架构来源与边界、文件集与指纹、派生产物闭包、关键原语、覆盖矩阵、问题清单和证据账本必须共同构成完整事实包；终审可复用其中事实，不得复用另一轮的裁决。
- 问题盘点结论保留到单元完成，交付物变化只复位终审一、终审二；开始下一单元时清空单元字段值、派生产物闭包行、关键原语行、问题行和证据行，并复位三列结论。各表说明与表头、九类核查面及两轮终审属于固定骨架；第一部分及其他静态内容未经用户要求不得修改。

### 5. Codex 目标模式提示词

```text
/goal 完成当前开发单元的审查与修复：不降低审查深度、测试覆盖或最终质量，在锁定边界内达到最优架构、不留已知债务。

首个动作，以及每次续跑或历史压缩后的首个动作，都是完整读取 `research/design/workbench/development-unit-review-workbench.md`。严格执行其执行闭环和五条核心规则，把动态区作为唯一状态源；门禁未满足不得转换阶段。

先把关键原语五项检查逐项写入动态区，再结合九类核查面一次收齐问题；表格未填完不得修复。集中修复只做一次合并后的直接验证。无论问题盘点零问题还是修复完成，都必须进入冻结准备：把交付物文件集中的每个文件或同类组写入派生产物闭包表，逐项记录派生关系、同步项和低成本检查结果；无派生项写明依据。存在未归类或待核查项不得冻结。

冻结时，动态区的架构边界、文件与指纹、关键原语、消费者、派生产物和有效证据共同组成事实包；两轮终审共享事实但必须独立裁决。两轮零新增后，受影响包全测、必要构建和最终门禁各执行一次。

按动态区状态持续推进；每次阶段转换前先更新动态区。只有需要用户改变范围、授权高风险动作或作出无法由项目事实确定的产品决策时才暂停，其余情况自主推进。

唯一完成条件：同一份未修改交付物的全部验收与必要验证通过，并连续两轮完整审查无新增真实问题；达到后立即结束，未达到不得宣称完成。
```

---

## 动态区

> 以下标题、说明、字段、表头、九类核查面行和两轮终审行是固定骨架；只维护字段值、单元相关表格行及固定行的待填列。

### 当前状态

- **单元**：第 11 单元（conversation assignment 与执行账本）
- **架构来源**：`research/design/modules/distributed-runtime/specification.md` 的端口、日志、派发纪律及执行计划第 11 项
- **当前状态**：完成
- **连续无新增问题轮数**：2 / 2
- **交付物是否冻结**：是
- **交付物文件集**：`packages/core/src/authority/{commit-log.ts,artifact-retention.ts}`；`packages/core/src/protocol/{assignment.ts,index.ts}`；`packages/owner-kernel/{package.json,tsup.config.ts,src/index.ts,src/conversation-assignment.ts}`；`packages/executor/{package.json,tsup.config.ts,src/index.ts,src/assignment-ledger.ts,src/__tests__/assignment-ledger.test.ts}`；`packages/server/src/__tests__/{distributed-runtime-structure.test.ts,__goldens__/distributed-runtime-structure.golden.json}`；`scripts/check-runtime-package-exports.mjs`；`pnpm-lock.yaml`
- **当前交付物指纹**：`sha256:4cac282fc17a0e908893fd1c1724a02c475b1a515eb1280b7dae51097b324199`

### 固定边界

- **功能范围**：conversation run journal、耐久派发 outbox、ActivationProof、assignment 账本及 received/started/interaction/bundle_sealed/acked 生命周期、幂等重投与进程内适配边界
- **架构不变量**：artifact 先于引用耐久；assigned 才能派发、received 才能启动；assignmentId 为幂等键；重签同载荷等价、异载荷冲突；账本 recordSeq 与链摘要单调且可重建；新路径不接管生产执行
- **验收条件**：无日志执行、重复 assignment、同载荷重签、异载荷 conflict、started 上报丢失、交互恢复、账本链与重启重驱测试通过
- **必要上下游**：AuthorityCommitLog、ArtifactStore、冻结 contracts、协议规范化与签名边界；为后续 conversation 提交和取消收束提供耐久事实
- **明确不属于本单元**：conversation 提交 CAS 与 staged 发布、取消/重派/uncertain、job、资源治理、mesh 传输、生产切换

### 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行；派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用：依据”；存在未归类文件或待核查项不得冻结。

| 交付物变化（文件或同类组） | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core protocol 的 assignment 实现与 barrel | 公共运行时符号必须同步运行时导出门禁；不产生 lockfile 或结构拓扑变化 | core 类型检查、构建及运行时导出门禁通过；新增校验函数已列入门禁 | 通过 |
| core authority 的已注册 artifact 保留解析 | GC 必须从 run/job assigned 与 assignment received 的 `dispatchRef` 解析 DispatchEnvelope 引用闭包；不新增公共导出 | core 类型检查与构建通过；owner/executor 双根、缺件与并发 GC 正反测试通过 | 通过 |
| owner-kernel 的 package/tsup/barrel/conversation-assignment | 子路径与根导出、workspace 依赖、结构拓扑及 lockfile 必须同步 | package/tsup/barrel 已登记子路径；结构断言/golden 与 lockfile 已覆盖依赖边 | 通过 |
| executor 的 package/tsup/barrel/assignment-ledger | 子路径与根导出、workspace 依赖、结构拓扑及 lockfile 必须同步 | package/tsup/barrel 已登记子路径；结构断言/golden 与 lockfile 已覆盖依赖边 | 通过 |
| executor assignment 集成测试 | 无生成产物；必须覆盖协议证明、串行派发、交互资源边界与既有验收 | 直接测试 7/7 通过，含 proof 验签/链摘要及新增正反边界 | 不适用：无派生产物 |
| server 结构测试与 structure golden | 结构断言和 golden 必须成对反映新包依赖与源码拓扑 | 更新差异仅为 core/authority→core/protocol 引用数 2→3；普通模式复验通过 | 通过 |
| runtime package export 门禁脚本 | 必须覆盖 core/owner/executor 新公共运行时符号与子路径一致性 | 脚本语法检查及实跑通过 | 通过 |
| `pnpm-lock.yaml` | 必须与 owner-kernel/executor 新 workspace 依赖闭合；本轮无外部依赖 | importer 已同步且开发阶段安装/构建成功 | 通过 |

### 关键原语核查

> 表头固定，每个关键原语一行；五项必须落到具体事实，结论只允许“待核查”“通过”或“有问题：编号”。任一行未通过，问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| 协议信封与 ActivationProof | 签名 DispatchEnvelope artifact、assigned 所在 CommitEnvelope | assigned fsync 后由其 commit 元数据确定性重建 proof；executor 验签与全字段绑定 | 签发、artifact put、assigned fsync、proof 生成、发送任一点崩溃均由 artifact GC 或 outbox 重驱收敛 | owner journal 生产；executor dispatch/重放消费 | 信封大内容经 ArtifactRef；dependencyArtifacts 规范排序 | 通过 |
| 派发 artifact 的耐久保留闭包 | run assigned / assignment received 是 `dispatchRef` 的权威保留根；DispatchEnvelope 是已注册复合 artifact | 提交时根与全部内嵌引用共同受 ArtifactStore 锁保护；提交后 GC 从根按注册 schema 恢复引用闭包 | 在场检查后至 fsync 前并发 GC 只能先删后拒或先提交后全保留；缺件 sweep 在删除前失败 | owner assign、executor dispatch 生产；outbox、ledger replay、执行输入消费；AuthorityCommitLog GC 回收 | 闭包按 digest 去重；缺件/错字节 fail-closed，父/root/dependency 同生存期 | 通过 |
| run 准入与状态投影 | `run:<conversationId>` 的 admitted/state 记录 | admitted+queued 同一 CommitEnvelope | artifact 前写、commit 前后、响应丢失、并发同 ingress/run 由日志临界区线性化 | Control 准入结果生产；assignment/outbox/状态查询消费 | 大输入外置；assignment 仅接受仍 queued、队首且无其他 active 的 run | 通过 |
| assigned 与耐久派发 outbox | run 流 assigned、state、dispatch-acked | dispatch artifact 先落；assigned+dispatched 单 CommitEnvelope；ACK fsync 停止 outbox | artifact/assigned/send/accepted/ACK 各点均可重驱；并发 assign 由事务复验 | journal 生产；进程内 dispatcher 与后续 mesh adapter 消费 | outbox 仅选择当前 dispatched、未 ACK 的唯一 active assignment | 通过 |
| executor dispatch 与 received | `assignment:<assignmentId>` 首条 received 或 dispatch-rejected | 全验通过后 received fsync 是唯一激活点 | 并发重复、响应丢失、重签、异载荷均由 assignment 流首事实线性化 | owner outbox 生产；executor ledger 与本地执行 guard 消费 | artifact 先落；冲突零追加；单 assignment 重放有界于日志 | 通过 |
| assignment 生命周期与链 | assignment 流连续 recordSeq 与摘要链 | 每次 CommitEnvelope 追加；bundle_sealed 为完成胜负点，acked 后收束 | start/seal/ack 重复与崩溃按耐久前缀回放；封包原子补齐 pending 终态 | executor runtime 生产；owner query/recovery、证据页消费 | 证据页至多 256 条；pending 默认 32 且可配置；单记录服从权威字节上限 | 通过 |
| allow-once 交互与审计镜像 | assignment 流 requested-finished 差集；owner mirror 仅审计 | requested/finished 各自 fsync；owner mirror fsync 后 executor 再推进 watermark | 应答/镜像响应丢失可按 requestId、seq 重放；终态时补 cancelled | executor/交互面生产；数据面、owner journal、恢复器消费 | 完整 executor/owner 记录均受 32 KiB 上限；pending 有界，镜像按可承载批次推进 | 通过 |
| 进程内 adapter 与能力开关 | owner/executor 两侧耐久事实，不持第二事实源 | enabled=true 才调用派发/查询；started 先落 executor 再上报 owner | disabled 零副作用；started 上报丢失由 queryLedger 恢复 | 单机组合根未来生产；两端窄端口消费 | 无监听、无循环重试；当前生产代码零消费者 | 通过 |

### 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试；核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过：证据”“不适用：依据”或“有问题：编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 总纲/状态机 | 输入准入串行、queued→dispatched→running | 状态 | run journal、assignment ledger | 有问题：U11-01；单会话可同时写入多条 dispatched assignment | 通过：队首 queued、唯一 active、received 后启动均由权威日志守卫 | 通过：重放、重签、越序与并发竞争均收敛到单一状态前缀 |
| 执行计划 11 | run journal、派发 outbox、交互生产端 | 入口与生产端 | admit/assign/dispatch/request/finish/seal | 有问题：U11-01、U11-02、U11-06；派发当前性、耐久体积与复合 artifact 保留闭包未封死 | 通过：入口均在耐久事务内复验；派发父件及完整引用集同锁提交 | 通过：恶意自报、缺件、超限和竞争均在追加前拒绝或形成完整事实 |
| 端口/导出 | owner/executor/protocol 消费者与继承面 | 消费端与继承面 | 进程内 adapter、包根/子路径、后续 mesh 端口 | 通过：生产代码零挂载；导出与依赖方向单向且结构基线已同步 | 通过：全仓反查仅定义与导出，无生产装配或旁路消费者 | 通过：必达消费者可承载，恢复与镜像均从唯一日志重建 |
| 记录合同 | received/started/interaction/bundle_sealed/acked | 生命周期 | 两本日志投影、outbox、mirror watermark | 有问题：U11-02、U11-06；大交互或积压可越日志上限，且派发复合 artifact 的子引用可先于父被回收 | 通过：两本日志可重建；父/root/dependency 同保留；交互和镜像均有界 | 通过：父件规范解析，子引用缺失或字节冲突在 sweep 前 fail-closed |
| 不变量/故障矩阵 | artifact→assigned→received→started | 并发与崩溃点 | assign/dispatch/ACK/started/mirror 各 fsync 边界 | 有问题：U11-01、U11-06；日志事务保证局部线性化，但复合 artifact 子引用未与提交及 GC 同锁闭合 | 通过：各 fsync 形成单一可重驱前缀，提交与 GC 共用 artifact→log 锁序 | 通过：GC 先胜则提交拒绝，提交先胜则完整闭包保留；零悬空日志 |
| 状态机/产品终态 | rejection/conflict/expired/run-end/backpressure | 异常路径与终态 | rejection proof、conflict proof、interaction recovery | 有问题：U11-02；backpressure 终态存在于合同但未用于限制 pending | 通过：拒收、冲突、过期、run-end 与背压均有唯一耐久终态 | 通过：finish×seal、重签×冲突和响应丢失均由首个耐久终态裁决 |
| 凭证/对抗矩阵 | 签名、绑定、授权、离线 received proof | 安全边界 | envelope/lease/capability/activation、owner-control/assignment principal | 有问题：U11-02；conversation 交互 outcome 未在运行时封死字段与 surface-ticket 分支 | 通过：签名、全字段绑定、principal 方法及 conversation 应答联合均封闭 | 通过：注册解析只读规范内容寻址字节，不执行数据；错 schema/绑定拒绝回收 |
| 包结构/顺序 | core protocol、owner-kernel、executor | 模块边界 | package graph、subpath、structure golden、生产装配 | 通过：owner 不依赖 executor；executor 不依赖 server；无 listener、无生产切换 | 通过：结构 golden 仅增加既有层内方向计数，无新包边或公共面 | 通过：无新外部依赖、监听、公共导出或生产切换，边界未扩张 |
| 执行计划验收 | 七项验收与回归证据 | 测试与验收 | assignment-ledger 集成测试、包测试、baseline | 有问题：U11-03、U11-06；主要路径已覆盖，但签名 proof、资源边界及派发闭包 GC 缺少机械断言 | 通过：9 项直接测试及三包 2211 项回归覆盖当前完整交付物 | 通过：双根、缺件零 sweep、GC 竞态及七类验收均有正反机械断言 |

### 问题清单

> 每个根因只保留一行；“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试；状态只允许“待裁决、待修复、修复中、待验证、已验证”。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U11-01 | `assign` 只检查目标 run 已 admitted 及 ID 幂等，未要求目标仍 queued、队首且不存在其他 dispatched/running；与对话输入串行和 assignment 当前性冲突 | 只实现了单 run 幂等，遗漏 conversation 级调度不变量 | 生产端：assign；类型组合：同会话多 queued run；消费者：outbox/executor；异常终态：双 active；测试：并发/越序派发 | 在同一 run 流事务内要求目标 state=queued、无其他 active assignment、目标为当前最早 queuedPosition；同一 active queuedPosition 拒绝。验收：越序、并行第二 assignment 零追加，首 run 仍可正常重投 | 已验证 |
| U11-02 | requested 允许约 128 KiB display，超过 AuthorityCommitLog 单记录 32 KiB；finished outcome 无运行时闭合校验；pending、mirror 批次与 recovery 历史结果无上界 | 交互合同按字段校验，未以耐久记录和积压闭包作为资源边界 | 生产端：request/finish/recover/seal/mirror；类型组合：超大/非法 outcome、积压；消费者：assignment replay、owner mirror、数据面；异常终态：日志拒写/恢复内存尖峰/镜像卡死；测试：边界与分批 | 建 conversation 专型 outcome/mirror 运行时校验；按规范字节限制 requested/finished；限制同时 pending，超限原子写 requested+cancelled(backpressure)；镜像按规范字节分批且 owner 拒绝超限；恢复只返回真实 pending 与本次新增终态。验收：任一记录不越 32 KiB、积压可分批推进、封包 pending 有界 | 已验证 |
| U11-03 | 现有测试只检查 rejection/conflict proof 外形，未验签或逐项核对 activation/ledger 摘要；U11-01/U11-02 边界无测试 | 测试覆盖了行为结果，但未把证明身份和资源/串行不变量机械化 | 生产端与消费者均不改；测试盲区覆盖 proof、会话串行、大小、backpressure、镜像分批与恢复 | 增加 proof 验签/摘要断言，并为 U11-01/U11-02 的正反边界补直接集成测试；全部新增测试与既有验收共同通过 | 已验证 |
| U11-04 | 修复把交互记录硬限为权威 32 KiB 的 1/4、镜像批次限为 1/2，并硬编码 pending=16、TTL=24h、reason=2000；这些数值不来自架构或存储合同，且现有 ConfirmationBroker 默认队深为 32 | 把协议形状校验、物理记录上限与产品背压策略混在同一组常量中 | 生产端：request/finish/mirror；类型组合：合法大展示/理由、长 TTL；消费者：确认 UI 与迁移影子；异常终态：过早 backpressure；测试：阈值与等价性 | 以完整 `AssignmentEntry`/owner mirror 记录的规范字节精确服从 32 KiB 权威上限；TTL 只校验正整数与 expires 等式，文本只校验形状并由记录总长约束；pending 上限改为构造选项、默认 32 对齐现有 broker。验收：上限内数据不被任意分数拒绝，越界零追加，可配背压且默认语义等价 | 已验证 |
| U11-05 | finished outcome 按 executor `AssignmentEntry` 的 32 KiB 上限验收，但同一 outcome 投影为 owner `interaction-mirror` 时会增加 assignmentId、时间和数组包装；临界载荷可在 executor 成功、在 owner 永久拒写 | 只按生产记录计算物理上限，遗漏其必达耐久消费者的最小包装 | 生产端：finish/自动终结；消费者：pendingInteractionMirrors、owner mirror；异常终态：审计水位永久卡住；测试：临界字节载荷 | 对 finished 同时计算最大 recordSeq 下的 executor 记录与单条 owner mirror 记录，任一超过 32 KiB 即在追加前拒绝；replay 同样复验。验收：不存在“生产可写、最小镜像不可写”的 outcome，临界反例零追加 | 已验证 |
| U11-06 | `assigned` 与 `received` 只直接引用 `dispatchRef`；GC 只扫描日志直接引用。实测父派发 artifact 保留而其内嵌依赖被删除；两侧在场检查与 fsync 之间也未共同持有依赖保护 | 把复合协议 artifact 当成 GC 叶节点，且事务候选只保护父 ref，遗漏其 schema 定义的耐久引用闭包 | 生产端：owner assign、executor dispatch；类型组合：WindowInput root 与 dependencyArtifacts；消费者：outbox、ledger replay、执行输入；异常终态：父在子失、重启/重投 missing-base；测试：owner/received 两种保留根及 GC 竞态 | 建集中、可扩展的已注册 artifact schema 保留解析：GC 识别 run/job assigned 与 assignment received 的 DispatchEnvelope 根并从规范 artifact 提取全部引用；两侧提交把父 ref 与完整引用集共同列为 candidateReferences，使在场检查到 fsync 全程受同一 ArtifactStore 锁保护。验收：未来截止 sweep 后父/root/dependency 全在；任一缺件时 GC/提交 fail-closed；owner 与独立 executor 日志均有直接测试 | 已验证 |
| U11-07 | 冻结指纹上的构建、导出及行为 golden 均通过，最终 structure 门禁因新增 `artifact-retention.ts` 导致源码拓扑与旧 golden 不一致 | 集中修复新增 core 内部文件后未重新生成并审查其机械派生拓扑快照 | 生产端/类型/消费者/异常终态：均不变；派生产物：server structure golden；测试：唯一结构门禁 | 仅以更新模式运行 structure 测试，审查差异必须精确等于新增 core authority 文件及其既有层内导入；无额外包边或公共导出变化后接受，再以普通模式复验 | 已验证 |

### 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口，输入闭包必须具体到可重复计算指纹；执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| D1 | core 新共享合同类型与实现可编译 | `pnpm --filter @zhixing/core exec tsc --noEmit` | core protocol 当前源码 | 直接 / 低 / 16.1s | 通过 | 当前 core 文件哈希 | 有效 |
| D2 | owner/executor 对共享合同及本地实现类型闭合 | 两包 `tsc --noEmit` | 当前 core 构建声明、owner/executor 源码 | 直接 / 低 / 约 20s | 通过 | 当前相关文件哈希 | 有效 |
| D3 | Unit 11 行为、故障与新增边界闭合 | executor 定向 `assignment-ledger.test.ts` | 当前 core/owner 构建与 executor 源码/测试 | 直接 / 中 / 12.2s | 7/7 通过 | 当前相关文件哈希 | 有效 |
| D4 | 修改文件格式与补丁完整性 | 目标 Biome、`git diff --check` | 当前修改源码/测试 | 直接 / 低 / 3.6s | 通过 | 当前相关文件哈希 | 有效 |
| D5 | 公共导出实际可达且门禁同步 | core/owner 构建、`node scripts/check-runtime-package-exports.mjs`、`node --check` | 当前构建产物与导出脚本 | 冻结准备 / 中 / 约 100s | 通过 | 当前 core/owner/脚本哈希 | 有效 |
| D6 | U11-04 的权威大小边界、长 TTL 与可配背压 | core/executor 类型检查、core 构建、同一定向测试、目标 Biome | 当前 core/executor 源码与测试 | 直接 / 中 / 约 72s | 类型通过；7/7 测试通过；格式通过 | 新冻结指纹相关文件哈希 | 有效 |
| D7 | U11-05 的跨日志单条可消费容量闭包 | executor 类型检查、同一定向测试、目标 Biome | 当前 executor 源码与测试、core 权威上限 | 直接 / 中 / 27.8s | 类型通过；临界反例在追加前拒绝；7/7 通过 | 新冻结指纹相关文件哈希 | 有效 |
| D8 | 最终构建、导出与行为/结构基线在冻结交付物上成立 | `pnpm runtime:baseline:update` | 冻结交付物、构建配置、导出与 golden 门禁 | 最终 / 高 / 205.7s | 构建及全部 runtime baseline 通过 | `sha256:4e8bb66ac6161ce3eb289aaab7cf476c37cc9d915ba768183b7da04c642c6b75` | 有效 |
| D9 | 受影响包完整回归通过 | 依次运行 core、owner-kernel、executor 全量测试 | 冻结交付物及当前依赖构建产物 | 最终 / 高 / 93.5s | core 132 文件 2187 测试、owner 10 测试、executor 12 测试全部通过 | `sha256:4e8bb66ac6161ce3eb289aaab7cf476c37cc9d915ba768183b7da04c642c6b75` | 有效 |
| D10 | 最终验证未改写交付物，补丁完整 | 复算交付物指纹、`git diff --check`、`git diff --cached --check` | 最终验证后的工作区与暂存区 | 最终 / 低 / 3.4s | 指纹不变；两类补丁检查通过 | `sha256:4e8bb66ac6161ce3eb289aaab7cf476c37cc9d915ba768183b7da04c642c6b75` | 有效 |
| D11 | 复合 artifact 传递引用是否受当前 GC 保留 | 临时 FileArtifactStore/AuthorityCommitLog：日志只引用父 artifact，父 JSON 内引用子 artifact，未来截止 sweep | 当前 authority GC 实现 | 诊断 / 低 / 2.5s | `retained=1, deleted=1`；父在、子丢，确认 U11-06 | `sha256:4e8bb66ac6161ce3eb289aaab7cf476c37cc9d915ba768183b7da04c642c6b75` | 诊断 |
| D12 | U11-06 的提交保护、双耐久根保留与 fail-closed | core/owner/executor 类型检查；core/owner 定向构建；executor assignment 定向测试；目标 Biome 与 diff check | authority 保留解析、两侧提交、assignment 集成测试及直接依赖构建 | 修复直接验证 / 中 / 约 137s | 三包类型通过；构建通过；9/9 测试通过，含双根、缺件零 sweep 与 GC 竞态；格式通过 | `sha256:b075a0871fa8d6d2559a5f6bc12535fa4bbb3bbfe7709f2253fe962a09c33e9d` | 有效 |
| D13 | 实现源码的包回归、必要构建、导出与行为基线 | 三包全测；runtime baseline 在 structure 步骤前的构建/导出/server 行为/CLI 步骤 | 实现源码、依赖声明、构建配置、导出脚本及行为/CLI golden；不含 structure golden | 最终 / 高 / 约 280s | core 2187、owner 10、executor 14 全绿；必要构建、导出、server 行为与 CLI golden 通过 | 实现文件哈希与当前交付物一致 | 有效 |
| D14 | U11-07 的 topology 派生差异与当前普通门禁 | structure 更新模式、差异审查、普通模式复验、交付物指纹与 diff check | structure 测试/源码扫描/golden；其余实现文件与 D13 相同 | 修复直接验证 / 低 / 约 25s | 差异仅 core authority 层内既有方向引用数 2→3；普通门禁 1/1 通过；补丁完整 | `sha256:4cac282fc17a0e908893fd1c1724a02c475b1a515eb1280b7dae51097b324199` | 有效 |
| D15 | 完成态交付物未变化且文件闭包完整 | 复算指纹、工作区/暂存区 diff check、交付文件并集核对 | 当前全部交付文件，不含工作台与构建产物 | 最终 / 低 / 约 4s | 指纹不变；两类补丁检查通过；17 个交付文件全部已归类 | `sha256:4cac282fc17a0e908893fd1c1724a02c475b1a515eb1280b7dae51097b324199` | 有效 |

### 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 是 | 无 | `sha256:4cac282fc17a0e908893fd1c1724a02c475b1a515eb1280b7dae51097b324199` | 通过 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | 无 | `sha256:4cac282fc17a0e908893fd1c1724a02c475b1a515eb1280b7dae51097b324199` | 通过 |
