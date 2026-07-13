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

1. **关键原语查透**：对每个状态变化、耐久写、并发竞争或外部副作用，逐项核对唯一事实源、生效/线性化点、崩溃与竞争插点、全部生产者/消费者、时间与空间上界；再映射九类核查面。缺一项，问题盘点不得结束。
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

- **单元**：第 10 单元（S3）：控制请求与准入幂等
- **架构来源**：`research/design/modules/distributed-runtime/distributed-runtime-charter.md` §6 控制面入口幂等、§13 不变量 17；`research/design/modules/distributed-runtime/specification.md` §4.1–4.3、§5.1、§14 提交 10
- **当前状态**：完成
- **连续无新增问题轮数**：2 / 2
- **交付物是否冻结**：是
- **交付物文件集**：`packages/core/src/{authority/{interfaces.ts,commit-log.ts,index.ts,__tests__/authority-storage.test.ts},persistence/index.ts}`；`packages/owner-kernel/{package.json,tsup.config.ts,src/index.ts,src/control-admission.ts,src/__tests__/control-admission.test.ts}`；`packages/server/src/__tests__/{distributed-runtime-golden.test.ts,__goldens__/distributed-runtime-{behavior,structure}.golden.json}`；`scripts/check-runtime-package-exports.mjs`；`pnpm-lock.yaml`
- **当前交付物指纹**：`eb3757fb2f532221f5a85ed6ddbaab22c5068b3905453ecf1f90c3b87a65a942`

### 固定边界

- **功能范围**：落 `ControlEnvelope` 的 session-create/input 初始子集、control 流 `received → applied`、requestId 与 `(surfacePrincipal, ingressId)` 双幂等、原结果回放、进程内影子准入；扩充 AuthorityCommitLog 的跨实例原子投影事务。
- **架构不变量**：同一入口键至多一次准入和稳定结果；applied、权威变更与响应载体同一 CommitEnvelope；可信身份和完整 IngressContext 由 owner 派生；超限对象先 artifact 后引用；旧执行路径仍是唯一生产路径。
- **验收条件**：并发重投、响应丢失、权威重启、渠道至少一次重投均只产生一次准入/变更；收到未 applied 可恢复；原成功/拒绝结果可回放；超限对象可重启恢复；旧入口 behavior golden 不变；包导出和结构门禁通过。
- **必要上下游**：上游为 Unit 2 冻结 contracts、Unit 9 AuthorityCommitLog/ArtifactStore；下游为 owner-kernel 组合与 Unit 11 conversation assignment；现有 server/CLI 入口只作为等价 golden，不接管生产。
- **明确不属于本单元**：cancel/session-write/global-write/job/resolve/allow-once；RunJournal、assignment、执行账本、提交/取消/uncertain；跨机控制面和 S6 artifact 传输；生产入口切换。

### 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行；派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用：依据”；存在未归类文件或待核查项不得冻结。

| 交付物变化（文件或同类组） | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core authority/persistence 源码、导出与测试 | authority/persistence 子路径导出、声明产物及 package export 基线；U10-07 仅改私有 cursor 与同文件测试，无新增公开声明/schema/golden | core typecheck、authority 17 项、core 全测、全量构建及 export gate 全部通过 | 通过 |
| owner-kernel control 源码、测试、index、package、tsup | owner 根/子路径导出、lockfile importer、包依赖图与结构 golden | lockfile、export 脚本及 structure golden diff 对账；V10-01/V10-05 通过 | 通过 |
| server distributed-runtime 测试与 behavior/structure golden | 旧入口行为快照、RPC/包拓扑结构快照 | 更新 diff 仅含预期行为与 owner-kernel 拓扑；普通模式 V10-04/V10-05 通过 | 通过 |
| `scripts/check-runtime-package-exports.mjs`、`pnpm-lock.yaml` | 分别是 owner 导出和 package 清单的闭包承载，不再派生仓库内文件 | export gate 与 lockfile importer 对账已纳入 V10-05 | 不适用：无下一级仓库派生产物 |

### 关键原语核查

> 表头固定，每个关键原语一行；五项必须落到具体事实，结论只允许“待核查”“通过”或“有问题：编号”。任一行未通过，问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| AuthorityCommitLog 原子投影事务 | `authority.log` 的 CommitEnvelope | 文件锁内单次 append + fsync | fsync 前零事实；后为整 envelope；跨实例由同一文件锁串行；任何文件快照变化均全扫并核对旧前缀 | `ControlAdmissionJournal`、core 测试；下游全部增量权威投影 | 文件 size/mtime/ctime 未变化才走尾偏移快路；变化或重启全扫，candidate 集保护新引用 | 通过 |
| ControlEnvelope 入站快照与可信来源校验 | 规范化 envelope、payloadDigest 与 owner 可信 source | `received` 耐久后请求身份成立 | 构造/校验失败零写；查重后仅 pending 调用惰性 prepare | 构造器、journal、未来 RPC/channel owner 适配器 | 全部索引与路由标识统一限制为 480B，错误消息限制为 4KiB | 通过 |
| requestId received/applied 状态机 | control 流 `received`、`applied` | 第一事务单独落 received；第二事务原子落权威项与 applied | prepare 前崩溃留下可重驱 received；applied 重投零 prepare、回放原结果 | journal API 与 Unit 11 后继适配器 | 结果耐久；同实例事务串行，跨实例由日志锁竞争收敛 | 通过 |
| `(surfacePrincipal, ingressId)` 准入索引 | control 流重建的 ingress 投影 | 首条 received 建索引，applied 固化稳定结果 | 文件锁吸收并发；pending alias 与 canonical 在同一 completion 提交完成 | first-party/channel 输入、后继 RunJournal | ingress 仅绑定 surface+ingress；requestId 绑定 surface+payload，路由设备/连接可迁移 | 通过 |
| 超限 envelope/result artifact 引用 | ArtifactStore 内容与 control 记录中的 ArtifactRef | artifact fsync 先于引用它的 log fsync | 引用提交前崩溃只留可 GC 孤件；提交后引用在场；缺件/损坏 fail-stop | envelope/result 编解码、日志投影、GC | 32KiB 阈值；内存投影只留有界绑定元数据与 Stored result，载荷按需加载 | 通过 |
| 增量投影缓存与权威重启重建 | authority log 为真相，内存投影仅缓存 | 成功事务后水位推进；重启从 0 验证重建 | 失败不合并 draft；同 inode 等长改写、改写后增长及换 inode 均全扫比对，异前缀零追加 | journal 每次 apply 与重启恢复；下游全部游标消费者 | 单 owner 未变化稳态 O(尾部变化量)；文件发生任何变化时以一次全扫换取前缀完整性 | 通过 |

### 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试；核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过：证据”“不适用：依据”或“有问题：编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 总纲、spec、contracts、交付物 | ControlRecord 与双幂等不变量 | 状态 | `control-admission.ts` 投影、received/applied/alias/recovery | 有问题：U10-01；received-only 只能由测试手写，不是公开流程可达态 | 通过：received 独立耐久，完成提交原子包含权威项、applied 与结果；canonical/alias 终态唯一 | 通过：逐分支重放确认 pending、完整 applied、稳定拒绝三类结果，无半 applied 或重复权威效果 |
| spec §5.1、现有 RPC/channel 入口 | session-create/input 与可信 IngressContext | 入口与生产端 | envelope 构造、来源校验、旧入口影子边界 | 有问题：U10-04；全仓消费者只有模块测试与导出门禁，未形成旧入口影子对照 | 通过：真实旧 session.new/session.send 结果进入 shadow journal；旧入口仍是唯一生产路径 | 通过：shadow 不注册 handler、不持有业务副作用，仅写隔离 authority log |
| owner-kernel 导出、后继 Unit 11 | API、包导出、权威条目消费者 | 消费端与继承面 | `index.ts`、package exports、authorityEntries | 有问题：U10-01；后继 API 被迫在查重前生成 plan，重复请求仍会重复规划 | 通过：prepare 仅 pending 调用，authorityEntries 仅作数据提交；全仓零生产消费者，Unit 11 边界稳定 | 通过：cursor 为 opaque 私有证明，后继消费者只能使用公开 LSN，不会继承文件元数据实现细节 |
| 总纲故障矩阵 | 接收、应用、回放、保留与重启 | 生命周期 | 新请求、重复请求、received-only、applied、artifact | 有问题：U10-01、U10-02；回放/大对象可用，但真实崩溃不能留下 received-only，投影常驻完整载荷 | 通过：新建、pending 重驱、applied 回放、alias、重启、超限 artifact 与日志变化回退路径闭合 | 通过：崩溃丢失进程 cursor 后必从 0 重建；缓存永不取代 authority log 真相 |
| 不变量 17、Unit 9 原子日志 | 同键并发、响应丢失、崩溃插点 | 并发与崩溃点 | transactProjection、跨实例日志锁、投影水位 | 有问题：U10-01、U10-02、U10-07；同 inode 原位改写后游标仍可基于旧 state 决策并追加 | 通过：同 inode 等长/增长、换 inode及跨实例变化均不再未经前缀证明复用 state | 通过：文件变化全扫并在 cursor LSN 比摘要，失配在 decide/append 前中止；正常竞态仍由文件锁决胜 |
| ControlResult、AuthorityStorageError | 冲突、拒绝、坏记录、缺 artifact | 异常路径与终态 | 全部 return/throw/append 分支 | 有问题：U10-01、U10-07；异 inode 前缀失配能 fail-stop，但同 inode 前缀改写未被识别 | 通过：所有可观测文件变化均全扫，前缀失配在 decide/append 前 fail-stop，耐久日志零追加 | 通过：截短、增长、改写、换代、坏帧和缺 artifact 均有唯一 fail-stop 路径，无静默降级 |
| 总纲角色边界、spec owner 派生纪律 | principal、channel responder、字段污染 | 安全边界 | wire 快照、payloadDigest、source/ingress guard | 有问题：U10-02、U10-03；摘要与来源复算正确，但路由 device 被误作请求绑定且部分 key 无字节上界 | 通过：source 每次复验；幂等绑定仅取稳定 surface+payload；渠道 principal 由 responder 规范摘要派生 | 通过：严格字段、摘要复算、身份派生和尺寸上界均未受修复影响；日志前缀变化改为保守拒绝 |
| Unit 10/11 边界、依赖图 | core 原语、owner journal、server 不接管 | 模块边界 | package/tsup/export gate/structure golden | 通过：core/owner 分层、根/子路径导出及旧生产路径未接管均符合；完整 IngressContext 入 RunJournal 属 Unit 11 | 通过：U10-07 仅改 core 私有 cursor 与测试；无新增导出、依赖、schema、golden 或生产接管 | 通过：消费者反查仍仅测试/导出门禁；无 RunJournal、assignment、mesh 或生产切换 |
| Unit 10 验收、既有 golden | 并发/重启/渠道/大对象/回归 | 测试与验收 | core/owner tests、build、behavior/structure golden | 有问题：U10-01～U10-04、U10-07；游标测试只覆盖 inode 变化，未覆盖同 inode 原位改写 | 通过：直接测试新增等长改写与改写后增长，17 项覆盖正常追加、换代、损坏和零追加 | 通过：测试同时锁定失配拒绝且零追加、同前缀换代、跨实例追加及原有损坏恢复，无同根盲区 |

### 问题清单

> 每个根因只保留一行；“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试；状态只允许“待裁决、待修复、修复中、待验证、已验证”。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U10-01 | `apply` 在查重前同步准备 plan/result/artifact；新请求把 received、权威项、applied 写进同一 CommitEnvelope；两项恢复测试直接手写 received | API 把“耐久接收”和“可重驱应用”压成一次调用的一次提交，`received → applied` 只是记录顺序而非可恢复状态机 | 生产端：session/input owner 适配器；类型：plan API；消费者：Unit 11；异常：准备失败/进程崩溃/重复规划；测试：真实崩溃恢复 | API 改为惰性 `prepare`：第一事务只查重并在新键写 received；仅 pending 才调用 prepare；第二事务原子写权威项+applied，竞态完成者回放。以 prepare 抛错制造真实 received-only，重启/同 ingress 重试后断言恰一 received、applied 和权威效果；已 applied 重投不得调用 prepare | 已验证 |
| U10-02 | 每次 `transactProjection` 从 0 扫 WAL 并收集全部历史 ref；每次 apply 克隆全部 Map；投影持有完整 envelope/result，含已 externalize 的载荷 | “增量”只在 reducer 过滤层成立，日志游标、内存投影和载荷投影均未采用有界增量表示 | 生产端：每个控制请求；类型：事务游标；消费者：所有后继权威投影；异常：长日志/大载荷/重启；测试：资源上界与跨实例回放 | AuthorityCommitLog 返回同进程不持久化的验证游标；文件快照完全未变化时从尾偏移续读，任何变化或重启全扫并比对旧前缀。新提交的全部 ref 由 candidateReferences 保护，删除历史 ref 全扫；owner 用 O(变化量) draft，投影只存有界元数据和 Stored result。验收覆盖未变化快路、跨实例变化回退、重启重建、大对象与长序列 | 已验证 |
| U10-03 | `sameRequestBinding` 比较 deviceId；同 ingress 不比较 device，因此同一平台事件换 requestId 可回放，同 requestId 在设备迁移后反而冲突 | 把可变化的路由/宿主身份误并入稳定幂等身份 | 生产端：first-party 重连与渠道锚点迁移；类型：request 绑定；消费者：重试方；异常：合法重投被永久冲突；测试：同 requestId 跨 device/connection | requestId 只绑定 `surfacePrincipal + payloadDigest`；connection/device/at 不参与幂等相等性，可信 source 仍逐次验真。补同 requestId 跨连接/设备的 session 与 input/channel 重投，以及异 surface/异 payload 冲突测试 | 已验证 |
| U10-04 | `ControlAdmissionJournal` 全仓仅被自身测试消费；测试中的 shadow result/authority entry 为手造值；现有 behavior golden 只证明旧入口未变 | 把“新模块自洽”和“新旧入口影子等价”混为同一验收 | 生产端：session.new/session.send 与渠道入口；类型：旧结果到 ControlResult 映射；消费者：后续切换；异常：映射漂移到切换期才暴露；测试：golden | 增加 server 进程内影子 conformance：调用真实旧 session-create/input 准入，映射其 conversationId/turnId/队列结果，经新 journal 持久化回放；同一 golden 同时锁定旧结果、shadow 结果及二者相等，且断言旧路径仍唯一执行、shadow 零业务副作用 | 已验证 |
| U10-05 | `FileProjectionCursor` 只有 LSN/文件身份/偏移；inode 变化时 `#readProjectionTail` 虽从 0 验证日志，却只过滤并重放 `lsn > cursor.lsn`，无法证明新文件前缀等于旧缓存 | 把“文件记录均合法”误当成“缓存所依赖的逻辑前缀未改变”；LSN 不是前缀内容证明 | 生产端：日志换代/未来压缩后的首个控制请求；类型：opaque cursor；消费者：全部增量权威投影；异常：不同合法前缀复用陈旧 state；测试：同前缀换 inode 与异前缀拒绝 | 游标加入累积前缀摘要；全扫、后缀扫和 append 都增量推进该摘要。文件身份匹配时沿 append-only 后缀续算；身份失配时全扫到 cursor LSN 并机械比对前缀摘要，相同才复用 state，不同 fail-stop；非本日志游标拒绝。补同前缀换文件可恢复、异前缀换文件拒绝且零追加测试 | 已验证 |
| U10-06 | server 全测 698 项中仅 `distributed-runtime-structure.test.ts` mismatch；当前 structure golden 仍是集中修复前的包导入计数 | behavior golden 与独立 structure golden 由不同测试生成，修复时只重跑前者，遗漏了机械派生产物同步 | 生产端：无；类型/消费者：包拓扑基线；异常：结构门禁阻断提交；测试：独立 structure gate | 以更新模式只生成 structure golden，逐项检查 diff 必须仅对应本单元新增/调整的 core、owner-kernel、test-utils 导入边；无额外拓扑变化才接受。随后普通模式复跑该唯一失败测试 | 已验证 |
| U10-07 | `FileProjectionCursor` 不记录文件时间元数据，`canResumeProjectionCursor` 仅比较 path/dev/inode/offset；实测同 inode、同长度原位换成另一条合法前缀后，事务得到投影 `[original,next]`，耐久事实却为 `[differnt,next]` | 把“同一文件对象”误当成“已验证前缀仍未改变”，快速续读从旧 offset 开始且不复验 cursor 前缀 | 生产端：AuthorityCommitLog 原子投影事务；类型：opaque cursor；消费者：ControlAdmissionJournal 及全部后继投影；异常：原位恢复/改写/损坏后以陈旧 state 继续追加；测试：仅覆盖换 inode，缺同 inode 改写 | 游标记录签发时文件 size/mtime/ctime；只有文件身份与这些元数据完全匹配时才允许从 offset 快速续读，任何变化一律全扫并在 cursor LSN 比对累积前缀摘要，失配 fail-stop。同 inode 等长改写、改写后增长测试均须拒绝且零追加，并保留正常跨实例追加 | 已验证 |

### 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口，输入闭包必须具体到可重复计算指纹；执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V10-01 | 直接证明游标事务、前缀换代、可恢复 received→applied 与双幂等 | 仓库 TS 5.9.3 core typecheck；core 定向构建；core/owner 定向测试 | core/owner 对应源码、测试、contracts、Unit 9 dist | 修复直接验证 / 低 / 约 86 秒 | typecheck、构建通过；core 15、owner 10 项通过 | `63107d8c…` | 失效 |
| V10-02 | 受影响包回归 | core 全测；owner-kernel 全测 | core/owner 源码、测试、依赖与 lockfile | 最终验证 / 高 / 本轮总验证 256 秒内 | core 2187、owner 10 项通过 | `eb3757fb…` | 有效 |
| V10-03 | 必要构建与声明生成 | `pnpm build` | 全 workspace 源码、清单、lockfile | 最终验证 / 高 / 约 136 秒 | 17 个 workspace 项目全部构建成功，含声明生成 | `eb3757fb…` | 有效 |
| V10-04 | 真实旧入口与新 journal 影子等价 | 普通模式运行 server distributed-runtime golden | server 入口、owner journal、core log、behavior/structure golden | 最终验证 / 低 / 随 server 全测 | server golden 2 项通过；旧/新结果相等且 shadow 仅写 control 流 | `eb3757fb…` | 有效 |
| V10-05 | 包导出和结构边界 | package export gate + structure golden | 构建产物、package/tsup、导出脚本、结构源码/golden | 最终验证 / 中 / server 约 35 秒、export 约 6 秒 | package export gate 通过；server 698 项全绿，含 structure 1 项 | `eb3757fb…` | 有效 |
| V10-06 | CLI 迁移基线与补丁完整性 | CLI distributed-runtime golden；`git diff --check`；交付物指纹复核 | CLI 测试/构建产物、全部交付源码与 golden | 最终验证 / 低 / CLI 约 9 秒 | CLI 1 项通过；diff 无空白错误；最终指纹未变化 | `eb3757fb…` | 有效 |
| V10-07 | 证明同 inode 原位改写不能复用旧投影且现有游标事务无回退 | changed files biome；core typecheck；authority-storage 定向测试 | `commit-log.ts`、`authority-storage.test.ts`、core contracts/protocol/persistence | 修复直接验证 / 低 / 约 21 秒 | 格式与类型通过；authority-storage 17 项通过，含等长改写、改写后增长、换 inode 与跨实例追加 | `eb3757fb…` | 有效 |

### 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 是 | 0 | `eb3757fb…` | 通过 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | 0 | `eb3757fb…` | 通过 |
