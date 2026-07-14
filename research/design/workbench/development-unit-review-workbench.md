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
| 冻结准备         | 交付物闭包、事实包与最终验证计划完整；计算并冻结交付物指纹                                                   | 冻结终审                                                 |
| 冻结终审         | 冻结指纹与事实包；两轮共享机械事实但独立裁决，分别审功能边界及并发、崩溃、安全、资源上界、测试盲区，均零新增 | 最终验证；任一轮有问题则回问题裁决                       |
| 最终验证         | 受影响包全测、必要构建及导出、golden、安全/结构门禁按依赖顺序各执行一次，全部通过且未修改交付物             | 完成；失败需修改则回问题裁决                             |
| 完成             | 两轮终审与全部必要验证属于同一份未修改交付物                                                               | 立即结束                                                 |

### 3. 五条核心规则

1. **关键原语查透**：对每个状态变化、耐久写、并发竞争或外部副作用，逐项核对唯一事实源、生效/线性化点、崩溃与竞争插点、全部生产者/消费者、时间与空间上界；存在缓存、索引、增量计算、短路或其他快速路径时，以权威事实源上的完整计算为正确性基准，列明成立与失效条件，并用正反例差分验证等价，无法证明则不得冻结；再映射九类核查面。缺一项，问题盘点不得结束。
2. **先审完再修**：问题盘点整轮只读，只登记问题；全部扫完后按根因合并，一次覆盖生产端、类型组合、消费者、异常终态和测试，再集中修复。
3. **闭包先于冻结**：问题盘点零问题或集中修复完成后，都必须进入冻结准备。交付物文件集中的每个文件或同类组必须在派生产物闭包表中落账，覆盖其 lockfile、golden、schema/快照及结构/导出基线；无派生项须写明依据。存在未归类项、待核查项或未同步项不得冻结，也不得提前运行包级全测、全量构建或最终门禁。
4. **昂贵验证只跑一次**：冻结前将最终验证展开为精确命令、输入闭包、依赖顺序和复用证据；组合命令须先展开，剔除已有同输入证据覆盖或范围外的子项，存在“待确定/待计算”不得冻结。两轮终审零新增后按计划执行一次，失败先归因再决定最小补证。
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

- **单元**：第 12 单元（conversation 提交、staged 发布与最终性）
- **架构来源**：`research/design/modules/distributed-runtime/specification.md` 的提交、发布收敛、终态投递及执行计划第 12 项
- **当前状态**：单元完成；两轮终审与本单元最终验证通过
- **连续无新增问题轮数**：2 / 2
- **交付物是否冻结**：是
- **交付物文件集**：core 提交协议/合同/保留注册/导出与 transcript 投影，executor assignment ledger，owner journal/manager，cli 装配，三组定向测试及运行时导出门禁（共 17 个产品文件）
- **当前交付物指纹**：`f8092b2ace4f3d088801bc337ba20e45c4fc3d75`

### 固定边界

- **功能范围**：executor staged mutation 与不可变封包、owner conversation 栅栏 CAS、publish-decision/续做、内容索引、FinalOutbox 与历史补读
- **架构不变量**：artifact 先于引用；assignment/ownerEpoch/baseRevision/executor/digest 全字段栅栏；提交、内容索引、发布决定与 final pending 同 envelope 生效；重复/迟到合法提交返回原 revision；发布和通知可从耐久事实续做
- **验收条件**：字段污染、重复/迟到、缺件、发布崩溃、final 响应丢失、provisional→final 与旧新提交结果等价测试通过
- **必要上下游**：第 9 单元 AuthorityCommitLog/ArtifactStore、第 11 单元 run journal/assignment ledger、冻结 SealedBundle/MutationBatch/RunSubmissionPort 合同
- **明确不属于本单元**：取消/重派/uncertain、job、delivery、mesh 资产传输、run stream、生产总切换

### 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行；派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用：依据”；存在未归类文件或待核查项不得冻结。

| 交付物变化（文件或同类组） | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core 提交协议、合同与类型别名 | SealedBundle/MutationBatch/TranscriptRunRecord 的严格校验、导出与类型不变量 | 源码逐字段对照；四包类型检查及两包构建通过 | 通过 |
| core artifact 保留注册 | bundle、batch、内容资产及传递依赖均由权威记录接管 | 注册表与提交闭包逐项对照 | 通过 |
| executor assignment ledger | staged 记录、封包胜负点、artifact 先写后引用、提交/ACK 消费链 | 源码与 D2 定向测试 | 通过 |
| core transcript 投影与等价测试 | `runId/runIndex` 幂等追加、读侧兼容、窗口折叠与旧路径逐项等价 | shard 21 项、窗口持久化 5 项通过 | 通过 |
| owner conversation journal | CAS、发布、内容索引、final/history、投影与重放消费者 | U12-01～U12-05 全链修复；D2 通过 | 通过 |
| owner manager、cli 装配与 server 定向测试 | committed fact 物化到旧 transcript/window/snapshot 读路径 | manager 投影定向测试通过；cli 回调与类型闭合 | 通过 |
| assignment-ledger 定向测试 | 执行计划 12 的状态、崩溃、污染、跳序和等价验收 | 17/17 通过 | 通过 |
| 运行时导出门禁 | 新增协议函数必须从声明的包出口可达 | 源导出、构建声明与门禁清单已同步；最终门禁待统一执行 | 通过 |

### 关键原语核查

> 表头固定，每个关键原语一行；五项必须落到具体事实，结论只允许“待核查”“通过”或“有问题：编号”。任一行未通过，问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| SealedBundle 与 MutationBatch | executor assignment 流的 staged 记录与 bundle_sealed；不可变 artifact | bundle_sealed 同 assignment 事务提交 | stage/seal 竞争在事务内复核；artifact 先落、候选引用保护 GC | executor 生产；owner CAS、发布器、history 消费 | inline 记录 32 KiB；大对象 artifact；assignment 封包后禁止继续增长 | 通过 |
| conversation 栅栏 CAS | 当前 owner 的单物理 AuthorityCommitLog | committed、内容索引、发布决定、state、final 同 envelope | artifact 候选引用保护；当前 epoch/base/runIndex/session 写由同前缀 authority 端口裁决；提交后投影可重驱 | executor 提交；owner journal、manager/transcript 与历史消费者 | 单次 envelope 有 32 KiB/记录上界；revision 严格前进；重放按日志前缀 | 通过 |
| staged 发布决定与续做 | publish-decision/progress 逻辑流 | CAS envelope 冻结逐条 outcome；幂等 apply 后逐项推进 progress | sidecar 逐字段绑定 committed bundle；apply 前后崩溃可重入；启动可扫描全部 pending | owner CAS 生产；publisher 与 conflict/final 投影消费 | batch 为 artifact；进度只能走下一 granted 项；未结项随日志保留 | 通过 |
| 内容资产索引 | committed bundle 的 contentAssets | 与 committed 同 envelope | reducer 逐项对照 bundle；缺件在 CAS 前拒绝 | owner CAS 生产；内容治理/GC 消费 | 内容只存引用；artifact 生命周期由日志保留注册约束 | 通过 |
| FinalOutbox 与历史补读 | RunJournal committed 为最终事实；outbox 为通知桥 | pending 与 commit 同 envelope；published/expired 单调转移 | pending 逐字段绑定 committed bundle；发布成功、状态落盘前崩溃会幂等重发 | owner CAS 生产；observer publisher 与 last-seen history 消费 | 无逐 surface ACK；published 24h 过期；历史按 revision 补读 | 通过 |

### 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试；核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过：证据”“不适用：依据”或“有问题：编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 总纲/状态机 | conversation 提交与最终性 | 状态 | dispatched/running→committed、started 乱序、final/history | 有问题：U12-01 | 通过：合法双入口、迟到吸收与终态补读闭合 | 通过：状态单调、重复与乱序均落入既定终态 |
| 执行计划 12 | 封包、CAS、发布与通知生产端 | 入口与生产端 | ledger seal→RunSubmissionPort→owner CAS | 有问题：U12-02、U12-03 | 通过：先 artifact、同 envelope CAS、投影后置且可重驱 | 通过：入口验权、候选引用与原子提交点完整 |
| 端口/导出 | 提交消费者与继承面 | 消费端与继承面 | publisher、会话持久化/窗口、history、observer | 有问题：U12-03、U12-05 | 通过：端口边界、旧读路径与启动扫描闭合 | 通过：全仓消费者反查无悬空或双写路径 |
| 记录合同 | bundle/batch/publish/final 生命周期 | 生命周期 | stage→seal→commit→publish/final→retention | 有问题：U12-04、U12-05 | 通过：全生命周期唯一事实与保留根完整 | 通过：各阶段事实、保留根与回收边界闭合 |
| 不变量/故障矩阵 | artifact→CAS→publish→final | 并发与崩溃点 | GC 竞态、commit 后崩溃、apply/final 响应丢失 | 有问题：U12-03、U12-05 | 通过：各插点均由耐久事实幂等续做 | 通过：并发重驱、响应丢失及各提交间隙均可收敛 |
| 状态机/产品终态 | conflict/retry/history | 异常路径与终态 | stale epoch/revision、全局冲突、断线补读 | 有问题：U12-01、U12-02 | 通过：冲突终态、重试与 last-seen 补读闭合 | 通过：拒绝、冲突、历史补读均有唯一可达终态 |
| 凭证/对抗矩阵 | assignment 提交权限与字段污染 | 安全边界 | authorizer、全字段 fence、严格 DTO、sidecar 篡改 | 有问题：U12-02、U12-04 | 通过：当前权威裁决、严格 schema 与 sidecar 绑定 | 通过：未授权、旧权威、自报字段与污染 sidecar 均 fail-closed |
| 包结构/顺序 | core/owner/executor | 模块边界 | core 纯合同、executor 不持权威、owner 唯一提交 | 通过：依赖方向正确；缺口均在 owner 合同闭环 | 通过：core→owner→executor/cli 依赖与职责未反转 | 通过：职责与依赖保持单向，未侵入后续单元 |
| 执行计划验收 | 七项验收与回归证据 | 测试与验收 | 污染、重复/迟到、缺件、两类崩溃、终态、旧新等价 | 有问题：U12-01～U12-05；现有 3 个提交用例未覆盖完整验收 | 通过：D1、D2、D4、D6 覆盖直接验收 | 通过：测试逐项覆盖风险面，未发现结构性盲区 |

### 问题清单

> 每个根因只保留一行；“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试；状态只允许“待裁决、待修复、修复中、待验证、已验证”。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U12-01 | `submitBundle` 只接受 running；状态 reducer 不允许 dispatched→committed；late `reportStarted/reconcileStarted` 在 committed 后抛错，与状态机“started 丢失/乱序仍提交”冲突 | started 被误当成提交前置事实，而非可丢失的观测事实 | owner 状态转移、started 两入口、重复/迟到提交、重放 reducer、状态/提交测试 | 允许 dispatched 或 running 的合法 bundle 原子进入 committed；committed 后 started/reconcile 幂等吸收；补 started 丢失、提交后迟到上报与重启重放测试 | 已验证 |
| U12-02 | CAS 只把 bundle 与旧 assignment 回显对照；未校验 journal 当前 `ownerEpoch`，baseRevision/TranscriptRunRecord.runIndex 也未由当前会话权威投影裁决 | CAS 缺少“当前会话权威快照”的单一决策端口，以历史 assignment 代替当前 epoch/revision/序号事实 | owner CAS、SessionMeta revision、TranscriptRunRecord 顺序、session staged 预检、旧 owner/旧基线攻击面及测试 | 引入同步的会话提交决策端口，在同一 AuthorityCommitLog prefix 上一次裁决当前 ownerEpoch、baseRevision、下一 transcript runIndex、session staged 写并分配严格前进的 commitRevision；旧 epoch/旧基线/错 runIndex 零写入 | 已验证 |
| U12-03 | committed 后仅发布 mutation/final；没有把 RunRecord、windowCompact、会话元数据投影到旧读路径，也没有可重启重驱的幂等投影入口；“旧新结果等价”测试只比较 bundle 字段 | 把权威 CAS 与派生投影割开后只实现了事实落盘，遗漏提交后投影闭环 | transcript 分片、ConversationManager 窗口/快照、session meta/content 读侧、commit 后崩溃、旧新 golden | 以幂等 `ConversationCommitProjection` 物化 transcript/window/snapshot；journal 枚举重驱 committed；run 严格要求非空且首项为用户；补投影崩溃、重复重驱及真实旧新持久化/窗口逐项等价测试 | 已验证 |
| U12-04 | publish-decision 重放只校验同 envelope 有 committed，未对照 committed bundle 的 batch ref/计数/outcomes；progress 可越过实际 granted 项；FinalOutbox pending 未核 digest 等于 committed bundle | 跨流 sidecar reducer 只校验共存，不校验与唯一 committed 事实的内容绑定 | publish/conflict/final 读取、重启重放、日志损坏 fail-closed、通知摘要与测试 | 统一从同 envelope 唯一 committed bundle/MutationBatch 复算 sidecar；校验所属 run stream、ref/计数/seq/outcome/digest，progress 只能推进到下一 granted 项；污染立即判坏日志 | 已验证 |
| U12-05 | `resumePublishing(assignmentId)` 只能由已知 assignment 驱动；commit 后进程退出且 executor 不重投时，没有从日志枚举全部未 settled decision 的恢复入口 | 发布恢复依赖提交调用栈/外部记忆，而非耐久 publish 流自身 | owner 启动恢复、session/global apply、progress、publish 冲突、崩溃测试 | 从 publish projection 按 commit 顺序枚举并重驱全部 pending assignment；单 assignment 内核幂等；测试重启不重投仍 settled、重复恢复零副作用 | 已验证 |

### 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口，输入闭包必须具体到可重复计算指纹；执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| D1 | core/owner/executor/server 新实现类型闭合 | 四包定向 `tsc --noEmit` | 当前 17 个产品文件 | 直接 / 低 / 16.6s（并行墙钟） | 四包通过 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 有效 |
| D2 | Unit 12 提交、发布、最终性行为闭合 | executor assignment-ledger 定向测试 | 当前 17 个产品文件 | 直接 / 中 / 26.48s | 17/17 通过 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 有效 |
| D3 | 冻结交付物完整回归与必要构建/门禁 | 五个受影响包全测；executor/cli build；server/cli golden；结构与安全门禁 | 冻结交付物 | 最终 / 高 / 284.4s | 五包全测、两包构建、golden 4/4、结构 1/1、三道安全门禁通过；全仓 Biome 唯一失败来自本单元未改的既有测试文件，本单元定向检查通过 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 有效 |
| D4 | core 与 owner 构建产物可生成 | 两包按依赖顺序定向 build | 当前 17 个产品文件 | 直接 / 高 / 49.6s | 两包通过 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 有效 |
| D5 | 新协议函数可从运行时公开导出 | `pnpm runtime:package-exports` | 当前导出面、构建产物与导出门禁 | 最终 / 高 / 已执行 | 通过 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 有效 |
| D6 | committed 投影与旧读路径等价且幂等 | core shard/window 两文件 + server manager 定向测试 | transcript、manager、cli 投影闭包 | 直接 / 中 / 15s | core 26/26；server 1/1 通过 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 有效 |

### 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 是 | 0 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 通过 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | 0 | `f8092b2ace4f3d088801bc337ba20e45c4fc3d75` | 通过 |
