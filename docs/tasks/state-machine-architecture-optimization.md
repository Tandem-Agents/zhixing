# 核心状态机架构与实现优化

## 问题

核心账本与运行时中，多种正交职责和共享状态集中在少数超大类、长方法里，形成巨型状态机；业务裁决与并发、持久化处理交织，相近的状态推进与协调逻辑分散在多条路径中维护。代表性文件（基于 `f724d845` 物理行统计，含空行与注释）：

- `packages/owner-kernel/src/conversation-assignment.ts`（13,170 行）
- `packages/owner-kernel/src/job-assignment.ts`（11,681 行）
- `packages/executor/src/assignment-ledger.ts`（6,514 行）
- `packages/cli/src/serve/conversation-protocol-runtime.ts`（4,513 行）

## 影响

局部改动难以判断和隔离关联范围，理解与联动验证成本高；多处同步维护容易漏改，增加回归风险，拖慢日常修复与后续演进。

## 要求

对相关模块进行内部架构与实现优化，消除巨型状态机问题，降低单点改动的维护与回归成本：

- **产品功能与外部契约不变**：产品能力、交互体验与 CLI/RPC/通道公开接口保持不变，既有本机数据、检查点与历史重放保持兼容；不改变[愿景](../vision.md)、[架构演进方向](../architecture/evolution-direction.md)与[整体架构概述](../architecture/overview.md)确立的顶层边界。“功能不变”以原始需求与正确产品契约为准——发现异常时须先基于源码因果与同条件对照严格区分**原版真实功能缺陷**、**本次重构引入的回归**与**正常安全边界等待**（严防误判）；凡经核实确属违反原始需求与正确契约的真实缺陷（如调度在线在途撞车缺冻结策略致补跑、在途日程删除取消栅栏身份冲突、状态历史非空尾页水位游标未推进、作业 `owner-fence` 取消证明交接断链致停机挂起），均在本次优化中一并优雅根治并实测闭环，绝不借“与原版行为一致”保留真实缺陷，也不为求短时表象通过放松租约到期等安全边界。
- **正确性、安全与性能底线不降级**：单写权威、原子提交、代际与签名栅栏、`uncertain` 消歧、崩溃与跨机离线恢复、安全与确认准入，以及既有性能与资源有界性不降级。

## 设计方法

1. **从行为与成本义务重建状态，按可区分性剪枝**：不默认现有巨型投影或协调器中的字段、布尔位与缓存都须原样保留再分组，而是从必须兑现的命令裁决、有界查询与故障恢复义务反推状态，分清**不可由他处恢复的耐久权威事实**、**为有界读取保留的派生索引/摘要**与**单次运行或单进程的瞬时句柄、认领及缓存**。互斥阶段采用带必要数据的分支表示以消除非法可选组合；并发活跃维度分别封装表示，并显式声明共同事件与跨维度判定条件（不把正交误当零跨维读取）。裁剪或合并状态前，先说明新表示及每步转移如何对应合同允许的观察、裁决、提交与后续义务（必要时借助精化映射或证明辅助变量）：若两段合法历史被压成同一新状态后，面对**相同后续输入**需要不同的合同响应，且剩余事实无法在规定读取成本内区分，才保留最小摘要或按键回查。凡重组持久或索引表示的候选，须核对纯旧、纯新、旧开始新结束、切换中断重来与切换后尾部五种历史形状；未改持久格式的内部重组不凭空引入迁移。
2. **在同一原子提交域内按三类耦合关系因式分解**：单次 `AuthorityCommitLog` 原子提交不等于所有逻辑共享同一平面大对象，也不把必须同批成立的事实拆成多笔独立落盘；按每条变更的读写依赖分别构造边界：
   - **共同前态裁决**：互为准入前提或跨维冲突约束（如授权与镜像结果核对）的事实，保留在同一锁定前缀下的明确共同裁决点，提供窄只读视图联合判定，不拆成各自局部合法却漏检跨事实冲突的分立检查；
   - **同批伴随记录**：主决定成立后需同批持久化的资源租约、投递、调度策略、发布与终态 outbox 等参与方，各自隐藏内部状态结构，仅经窄接口交出候选记录、所需预装键与制品引用保护集，在协调点统一验证并合入同一 `CommitEnvelope`；
   - **派生维护**：区分**同事务同步更新的按键索引/摘要**（将内部树/表表示与完整更新操作封装在一起，归约前按层成批预装定位路径，避免归约中途逐次缺键重开整封事务或重读密封包）与**提交后可重驱投影**（已提交事实绝不被后置物化失败反改或重分类）。共同决策极密、拆开只产生透传内部顺序的浅层转发时，保留内聚单元。
3. **明确计算、I/O 与后置效果交接，分层审视缓存与平行归约**：从长方法与归约器中分离不同性质的操作，阶段间以语义明确的窄中间结果契约衔接，不传装满局部变量的大上下文：
   - **零制品快筛**：先凭轻量身份/历史索引拦截重复、已结或明显无效请求，避免白读大体积制品；
   - **锁外不可变准备与按需补齐**：将可完整准备、身份可复验的不可变制品解引用、验签及按需工作集/冷历史补齐移出裁决；逐调用点核对**事务内与事务外全部读取入口**的补齐重做回路（缺载不等于不存在；从检查点恢复后仍须补做必要的制品在场核对）；
   - **同前缀确定性裁决与合批**：无法安全前移的工作集版本/头位置核对、跨投影同前缀只读查询与制品 GC 引用保护留在权威锁临界区内，由确定性状态计算产出明确拒绝或候选记录批次；
   - **绑定事实与身份的后置效果**：由已提交事实驱动的派发、取消、交互镜像与通知等外部效果，各自绑定实际依赖的耐久事实、授权与幂等身份，触发前及异步返回后核对有效性，仅经受控状态转移回写新事实；
   - **分层审视缓存与平行归约**：对热缓存、认证检查点、旧前缀分页历史与按键索引，先写明各自解决的读取/恢复成本与回退义务，证明可替代后再合并；对公共协议归约与本地执行投影，先区分重复判据与各自独有职责（如本地时效、待办请求、流/镜像索引），共享同一推进决定、本地仅消费窄变化结果，待等价与损坏检测责任有明确新承担者后再移除重复转移与比对断言。
4. **按耐久交接点、统一终态结算与代际边界组织跨权威长流程**：运行时协调器横跨资源预留、工作区锁、执行体、权威账本与流会话，既不伪装成单日志纯归约，也不对不可逆外部效果假设 Saga 式回滚：
   - **阶段责任与准入链四要素**：按已确认耐久事实与所持句柄/义务划分阶段；跨组件准入与重试逐环写明所持锁/租约/容量 permit（物理容量 permit 不跨网络或外层权威锁等待）、锁外重试责任方、依具体合同确定的截止起点与进展重置规则、以及原子预留预算与真实叶消耗的匹配；
   - **多出口统一收束与独立清理**：正常完成、拒绝、异常、取消与后台恢复处理同一终态义务时共用一致结算判据与幂等身份；未知外部结果按合同定格 `uncertain` 并允许合法迟到证据消歧；`finally` 中逐项隔离清理错误，确保前置关闭失败不漏清在途认领或恢复标记，派生清理读压也不覆盖已耐久的运行结果（清理本身的错误按实上报，不反改已提交结论）；
   - **代际与门禁精确分治**：将同生共死的可替换运行态纳入代际作用域（下层仍用窄责任接口，并区分普通缓存淘汰与恢复/能力/认领的独立寿命），逐个标明 `await` 后会访问的可替换状态并在访问前验代——失效操作不得读写替代它的新状态，**但其既有资源义务、已发生效果与迟到证据仍须由所属实例结算或转交恢复/消歧**；优化性的通知/调度抑制门须给出不依赖外部配合的独立解除或重评路径，业务安全门只依正式事实/授权放行；幂等通知对可重试/未知失败退避重试，不对永久权限拒绝无限重试；实际后绑定端口核查全部创建与预读恢复顺序，采用构造前就绪或稳定委托，防止旧实例永久捕获未绑定态。
5. **按语义映射与输入事实闭包确定协议共享深度**：不凭同名方法认定同构，也不因存储容器不同放弃共享；对跨领域（`conversation` 与 `job`）、跨角色（`owner` 与 `executor`）及跨投影（完整归约与轻量守卫）的相似机制，逐项映射状态含义、前置事实、授权身份域、拒绝/重放语义、原子伴随记录与恢复终态义务：
   - **规则同构的多执行点**：提炼唯一事实源的纯判定谓词或确定性推进核，并为**每个消费点证明输入事实闭包完整有效且证据强度一致**；不同读模型保留各自的数据准备与损坏检测边界，不为统一接口偷偷扩成全量状态加载；
   - **存在实质业务分叉**：将固有差异（如 `assign` 重放语义、调度触发与失败摘要、会话转录与窗口）留作明确语义的领域策略或外层模块，不用膨胀的布尔开关与可选回调硬凑同构；共同部分过薄、适配税更高时保留独立实现。
6. **分离设计期对照探针与落地后整链实证，严守契约与门禁意图**：
   - **设计期比选与最小探针**：以“保留现聚合”作对照基线，用同组需求变更与并发/崩溃/迟到消息交错比较各候选的修改点、泄露的状态知识、协调读取成本及安全性与活性；对决定性未知用状态表、小模型或局部最小探针先行证伪并注明覆盖边界，不把模型通过当作实现通过；
   - **落地实证与门禁等效**：明确实际候选落地后须通过受影响的真实存储、关闭重开及配对/收编/换代恢复入口验证（不在替身处止步，也不对未受影响入口机械重跑），结合结构推导与可区分增长趋势的规模操作衡量读写字节、物化、遍历与解析开销，防热路径成本转移到冷启动、检查点或兼容路径；公开契约不变、历史数据兼容，若模块调整触及导出白名单、S7 结构锚点或拓扑快照，须证明原门禁的检查意图被等效保留。

方法依据：状态表示与分解参 [Parnas 1972](https://ckrybus.com/static/papers/decomposing_systems_into_modules_1972.pdf)、[Harel 1987](https://www.weizmann.ac.il/math/harel/sites/math.harel/files/users/user50/Statecharts.pdf)、[Abadi & Lamport 1988](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/abadi-existence.pdf)；同批事务、阶段协议与长流程参 [Temporal CHASM](https://raw.githubusercontent.com/temporalio/temporal/main/docs/architecture/chasm.md)、[etcd/raft](https://raw.githubusercontent.com/etcd-io/raft/main/README.md)、[Chassaing 2021](https://thinkbeforecoding.com/post/2021/12/17/functional-event-sourcing-decider)、[Fowler Split Phase](https://www.refactoring.com/catalog/splitPhase.html)、[Garcia-Molina & Salem 1987](https://www.cs.cornell.edu/courses/cs530/2005sp/papers/sagas.pdf)；评估与证伪参 [SEI ATAM 2000](https://www.sei.cmu.edu/documents/629/2000_005_001_13706.pdf)、[AWS 2014](https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf)；本仓经验与反例见[状态、重放与合同一致性](../engineering/state-replay-contract-lessons.md)、[单元 13 记录](../../research/design/workbench/unit-review-ledgers/unit-13.gen-1.md) `U13-40`/`U13-41` 及[失败复盘](../postmortems/README.md)（`2026-10-23`、`2026-10-24`、`2026-10-25`、`2026-10-27`、`2026-11-01`、`2026-11-02`、`2026-11-04`）。

## 优化范围与结束边界

采用**稳定公开门面 + 按领域事实和生命周期封装的内部责任单元 + 原有单写事务协调点**：保持现有包边界、公开导出子路径、签名协议、磁盘逻辑记录格式、投影 ID/索引键名与原子提交域不变；不引入通用状态机引擎、反射注册表或按状态族拆库的分笔事务。四个原巨型文件保留为薄门面与公开兼容导出入口，内部状态族、命令决定、阶段准备、重放派生与恢复协调各有唯一责任归属。

**纳入判据**：凡直接持有本次被拆状态、重复维护同构子协议、或直接导入被拆内部归约/投影形状的相邻文件，一并纳入适配与验证；仅经未变窄端口交互的相邻模块保持原实现，只做受影响闭环验证。

| 责任簇 | 本次纳入重构与适配的范围 | 明确保持外部窄端口闭合的范围 |
| --- | --- | --- |
| **`owner-kernel` 对话责任簇** | `conversation-assignment.ts`（`ConversationRunJournal`、`InProcessConversationDispatcher`、发布与终态 outbox）及直接消费其状态/归约入口的 `conversation-run-state-index.ts`、`conversation-run-state-view.ts`、`conversation-run-state-extras.ts`、`conversation-projection-draft.ts`、`conversation-resource-witness.ts`、`conversation-decision-migration.ts`、`conversation-base-domain.ts`、`conversation-run-queries.ts`、`advancement-recovery-index.ts`、`conversation-run-contracts.ts`（含 `test-support/s7-durable*.ts` 适配） | 底层 `AuthorityCommitLog`/B+ 树索引与 `conversation-decision-partitions.ts` 分片引擎、`conversation-transfer.ts` 传输协议、`control-admission.ts`、`conversation-manager.ts`、`resource-governor.ts` 内部调度算法、`delivery-participant.ts` 核心流水线 |
| **`owner-kernel` 作业责任簇** | `job-assignment.ts`（`JobReduction`、`JobJournal`、`InProcessJobDispatcher`）及直接关联的 `job-run-state.ts`、`job-run-state-index.ts`、`job-failure-summary.ts`、`job-run-contracts.ts`（并纳入冷审确认的 `scheduler-authority.ts` 与 `core/src/scheduler/runtime-policy.ts` 在线错过冻结策略、单源取消推进及完整任务快照原子发布真实缺陷修复） | 正常调度触发业务规则与权威边界、系统内建任务与对话运行各自的独立业务语义 |
| **`owner-kernel` 共享子协议** | 收敛对话与作业实际重复的四族协议决定与状态更新：`not-started` 终止证据分类、提交能力鉴权、数据面票据生命周期、交互镜像与信任批次准备（复用并扩充 `data-plane-ticket-lifecycle.ts`、`data-plane-ticket-proof.ts`、`channel-interaction-records.ts`、`trust-rule-hits.ts` 及包内共享模块） | 不合并 `assign` 重放、系统任务执行、冻结投递计划、失败摘要与会话窗口/转录等真实业务分叉；不改 `@zhixing-ai/core/protocol` 既有公开函数签名 |
| **`executor` 委派账本责任簇** | `assignment-ledger.ts`（`ConversationAssignmentLedger`、`InProcessAssignmentSubmission`、`JobRecoveryIndex`）及直接关联的 `assignment-ledger-index.ts`、`assignment-lease-clock.ts`、`assignment-interaction-stream.ts` | 执行器 Runtime/模型工具循环、`executor/src/resource-governor.ts` 内部治理、`assignment-stream-spool.ts`、`data-plane-ticket-registry.ts`、Mesh 传输 |
| **`cli/serve` 对话协调责任簇** | `conversation-protocol-runtime.ts` 内部职责分解，以及与其共享计划释放、换代协同或收尾辅助边界的 `conversation-executor-dispatch.ts`、`anchor-scheduler-runtime.ts`、`executor-job-owner.ts`、`command.ts`（本机作业取消证明提交接线）、`conversation-assignment-worker.ts`、`job-assignment-worker.ts`、`assignment-worker-obligations.ts`、`durable-{conversation,job}-interactions.ts` 必要收敛与组合根接线适配 | CLI 命令、终端 UI、Product API、Channel 业务路由、`planned-anchor-transfer*`、`device-removal.ts`、`backup-command.ts`；保持正常宿主排空停止、本机/Anchor 角色及既有恢复让路策略 |

**清晰结束条件**：上述四簇全部公共方法、记录分支、状态字段与恢复义务均落入唯一内部责任单元，无遗留巨型混合操作、无新旧双实现并存、无扩面至无关大文件或维护台存量问题；下文九项最终验收门槛全部实证通过即告完成。

## 具体架构设计

### 1. 状态表示、底层载体隔离与单向依赖

不更换业务状态枚举、不新增耐久流程阶段、不删减历史可区分事实，将**运行时访问权限**与**持久化/兼容形状**解耦：

1. **三层单向依赖（消除门面反向依赖与整份可变投影泄漏）**：
   - **叶子契约层**：记录定义、公开兼容类型（如 `RunProjection`、`SubmissionGuardProjection`）及窄只读事实接口下沉至叶子模块，原公开入口仅作 re-export；**严禁内部责任模块反向 `import` 四个门面文件**。
   - **存储与重放载体层**：保留现有记录字段、按键索引名及 JSON/V8 检查点保存 DTO 形状（含 `LedgerProjection` 与 `DecisionState` 原持久化字段），仅允许存储适配、重放路由与兼容导出层接触完整原始载体。
   - **语义状态族与业务操作层**：每个状态族将共同变化的表示与完整不变量更新封装在一起（底层仍读写同一按键存储或内存载体，不复制权威数据）；业务决定器（`operations/*`）只接收本次判定所需的窄只读事实视图，不接收整份 `RunProjection`、`JobProjection`、`LedgerProjection` 或宿主 `this`。
2. **核心状态族划分与可区分性保持**：
   - **对话状态族（`conversation-journal/state/`）**：① 会话身份、`sessionMeta`/revision、生命周期请求去重、`taskList`/`advancement` 与 `workscene` 前沿；② 输入与排队（`ingress→run`、追加输入、开闭窗口、消费边界，以及绑定在一起的队列位置表 + 最小堆 + `heapIndex`）；③ 委派生命周期与控制（当前运行/委派绑定、`started` 耐久观测、取消/取代栅栏、`uncertain` 开放决议、冲突前缀记录、激活/撤销能力与关联票据）；④ 交互/通道挑战/信任镜像（镜像批次摘要与序号前沿、请求去重、通道挑战投递/采纳、信任批次状态）；⑤ 运行提交与后置发布（已提交回执/资产索引、`PublishProjection` 双域计划与进度、`FinalOutboxProjection` 待发与过期）。其中“已耐久观测到 `started`”与“`uncertain` / 取消原因”保持独立事实源，不压成单一阶段枚举。
   - **作业状态族（`job-journal/state/`）**：在同类委派控制、票据与交互/通道授权（含作业专属 `interactionSettlementFences` 与通道中继 grant）外，独立封装作业专属 `TaskDefinition`/修订、`occurrence` 排序、冻结 `deliveryPlan`、系统任务租约/结果、`JobFailureSummary` 树路径与待办目录派生维护（`refreshJobDirectories` / `refreshFailureSummary`），不向共享运行规则泄漏调度表示。

### 2. 对话与作业账本：事务协调、阶段交接与四族共享协议

包内按 `conversation-journal/`、`job-journal/`（含 `state/`、`operations/`、`submission/`、`transaction/`、`replay/`、`dispatcher/`）与共享子协议模块组织；直接复用并适配现有 `*-run-state-*`、`conversation-decision-migration.ts`、`conversation-base-domain.ts`、`conversation-run-queries.ts`、`advancement-recovery-index.ts`、`job-failure-summary.ts`，不平行另建第二套索引或编解码。其中 `InProcessConversationDispatcher` 与 `InProcessJobDispatcher` 各自保留独立的恢复驱动循环与取消退避所有权，仅复用同构上下文构造、回执与证明辅助函数。

#### 2.1 原子转移与阶段交接契约

保持原有原子状态转移边界与多步骤耐久顺序不变：原属同一 `CommitEnvelope` 的主记录与伴随记录继续同批原子追加；原跨多步耐久推进的协议（如控制 `received → applied`、会话 `writeSession → projectSession`、执行取消 `begin → finish`）保持原步骤边界与顺序。以 `submitBundle` 为代表的复合写路径按五段窄契约衔接：

1. **锁外不可变准备与参与方依赖冻结（阶段 P1，`submission/`）**：先经守卫投影快筛拦截重放或明显失效代际；锁外完成密封包/派发信封解引用、规范化与签名校验（输出绑定身份、基线版本、摘要与引用集的不可变 `PreparedSubmission`，不含“已获准写入”布尔位）。由于 `AuthorityCommitLog.transactProjection` 在进入 `decide` 前即固定 `readProjectionIds` 并在锁外以 `artifactStore.withPresentReferences` 持有 GC 引用栅栏，所有伴随参与方须在 P1 交出静态 `readProjectionIds`、预编译产物与额外受保护引用（如 `compileConversationDelivery`、`publisher.collectStagedReferences`）及初始工作集键需求；信任规则命中仅在守卫预检通过时绑定单次准备句柄执行一次。
2. **同前缀联合决定器（`operations/`）**：在锁定前缀下只读消费 `AssignmentFacts + InputFacts/OccurrenceFacts + MirrorAndSettlementFacts + OpenResolution + PreparedSubmission`，联合重验当前性、能力授权、输入窗口闭合/冻结计划与跨维冲突，产出拒绝、幂等回执或主提交决定，不读写投递内部表或触发网络。
3. **锁内已冻结前缀伴随生成（阶段 P2）**：资源激活/终态记录、投递准备（`prepareConversationCommit` / `prepareJobCommit`）、对话双域发布计划与 `FinalOutbox`、作业 `schedulerPolicy` 自动禁用与能力缺口闭合等参与方，仅在 P1 已冻结的 `context.readProjection` 读集、受保护引用集与当前 `authorityPrefix` 上生成伴随记录，**严禁在当前 `ProjectionTransactionContext` 内事后扩充读投影或未受保护引用**；若锁内发现缺失状态键或前缀条件变化，以受控准备信号（`ConversationWorkingSetChanged` / `JobStateRequired`）或引用不匹配（`TransactionArtifactReferenceError` → 可重试 `missing-base`）退出当前锁/许可，不在锁内打补丁。
4. **事务协调与缺依赖/头变化重做（`transaction/`）**：单点管理串行队列、工作集预装与 `log.transactProjection` 原子追加，**严格保持从外到内的既有协调锁次序：`resources.coordinate` → `systemResources.coordinate`（仅作业侧存在且非 `sameCoordinator` 时；`sameCoordinator` 只获取一次资源协调，对话侧无 `systemResources` 层）→ `delivery.coordinate` → `transactProjection` 内部锁外 `artifactStore.withPresentReferences` 引用保护 → 日志事务锁内决定/追加（缺省参与方沿原分支跳过，杜绝渐进切片期逆序等待环）**，并将**整次请求生命周期的信任预准备/结算**与**单次事务尝试的重做**严格解耦。以“`global staged mutation + delivery` 提交”为例：正常路径下 P1 合并 `publisher.readProjectionIds` 与 `bundle + delivery + stagedReferences` 后按上述从外到内次序进锁，回调入口先清空 `appendedGlobalRecords`，联合裁决通过后顺序执行 `authority.decideAtPrefix → delivery.prepareConversationCommit → publisher.prepareGlobalBatchAtPrefix` 并单封 `CommitEnvelope` 落盘，出锁释放引用栅栏与许可后最多执行一次 `afterGlobalCommit` 与信任 `accept`；若发生 CAS 前缀变化重跑或因受控缺载信号退回锁外 `#repeatWorkingSet`/`#repeatState`，则先释放该次尝试所持锁与内部许可并在锁外补齐状态，**直接复用既有 `PreparedSubmission`、`compiledDelivery`、`stagedReferences` 与单次信任准备句柄**（不重读大制品、不重复信任预准备或误清在途尝试），在新 `authorityPrefix` 上完整重验当前性、修订链、投递与全局批次；仅在整个提交请求最终拒绝或异常退出时统一调用一次 `#settleUncommittedTrustRuleHits`。对话侧同时保留按键索引工作集与已收编导入历史基线各自的读取准备策略；作业侧提交成功后按原合同采纳 `session.main` 并刷新 `session.guard`，`requireFailureSummaryPaths` 按层批量预装。
5. **绑定事实的后置驱动**：仅消费已落盘提交事实推进转录/窗口物化、`afterGlobalCommit` 发布、`FinalFrame` 发送、生命周期投影与状态通知；后置失败保留待重驱状态并按原合同报错，绝不倒改已提交回执。事务内与事务外全部只读入口均经各自的按需补齐回路读取，检查点恢复路径保留制品在场核验。

#### 2.2 归约分派与四族共享协议的精确输入/分叉边界

单族记录按 `t` 判别式直接路由至所属状态族封装更新（配编译期穷尽检查）；**同一记录跨多状态族读写时（如对话 `state`、`committed`），在内聚联合转移决定点（`replay/joint-transitions.ts`）采用“从当前记录之前、已应用此前同封记录的候选状态捕获有限不可变前态 → 共同校验产出不可变转移增量 → 固定次序族内写入同一候选/覆盖层”协议**（既不把每条记录绑回整封 `envelope` 最初前态，也不广播给各族边改边读；校验失败整封丢弃，不外露部分更新）：

- **`state` 联合转移**：写入本条记录前，从已反映此前同封记录（如前置 `committed`/`assigned`）的候选窄视图捕获不可变前态（`admitted.queuedPosition`、当前 `runState`/`statusRevision`、`assignmentByRun`、`closedAssignments`、`activeRunId`、`commits.at(-1)` 及同封记录），一次性完成 `delivery.assertConversationStatuses`、`assertStateReplayContract`、`assertQueuedTerminalDequeue`、`assertStateAtomicReplayContract` 与资源终态记录核对并产出不可变 `StateTransitionEffect`，再依次调用 `InputQueueFamily.applyQueueMembershipDelta`（独占维护队列位置表 + 最小堆 + `heapIndex`）→ `AssignmentControlFamily.applyRunStateTransition`（独占维护 `activeRunId`、`stateByRun`、`assignmentByRun`、`closedAssignments`、`recoveryAssignments`、`uncertainOrigins`、`statusHistoryByRun`）。
- **`committed` 联合转移**：在冻结前态核验委派与修订连续性、密封包栅栏、输入窗口闭合（`validateConversationBundleClosure`）及资源结算并产出 `CommittedTransitionEffect`，再依次调用 `CommitPublishFamily.applyCommittedBundle` → `AssignmentControlFamily.clearRecoveryAssignment` → `SessionIdentityFamily.applyCommittedSessionEffects`（会话变更、`workscene` 前沿与 `lastActiveAt`；输入消费由同封伴随的 `input_consumed` 记录直接路由至 `InputQueueFamily` 独占更新）。
- **Full / Guard / 按键索引统一消费与设计期影响面对照**：`conversation-run-state-index.ts` 在物化作用域视图上继续调用唯一 `reduceConversationRunState` 与 `reduceConversationSubmissionGuard`（守卫仅消费同一转移头校验并更新守卫可见的控制/输入切面，不读取 CAS 密封包体），随后刷写变更行，不复制第二套多族规则。以“修改对话输入窗口闭合或排队顺序规则”对照原聚合基线（`f724d845`）：原基线将堆与输入表平铺在 71 字段可变 `RunProjection` 上，需排查上万行是否直改堆索引；新结构将堆与输入状态私有封装于 `InputQueueFamily`，提交裁决仅读 `InputFacts.assertClosedInputMatches`、`state` 重放仅调 `applyQueueMembershipDelta`，控制/票据/镜像/发布模块零接触堆结构，且 `DecisionScope` 按 `runId` 读取量不变。针对 `JobReduction` 主归约与守卫归约，同样提炼限定在守卫 `JobStateLayout` 键集内的 `verified record + bounded prestate reader + scoped mutation sink`，完整归约再叠加调度/occurrence/失败摘要/目录维护，并用守卫 I/O 测试防越界加载。

对话与作业的四族重复协议共享确定性核心判定，同时显式保留各自真实业务分叉（不用布尔开关硬凑伪统一）：

| 共享协议族 | 共享核必选前态与输入事实 | 消费点有界读取来源 | 共享领域中立输出 | 保留在各领域的真实分叉与记录生成 |
| --- | --- | --- | --- | --- |
| **1. `not-started` 终止证据分类** | 已验签 proof（覆盖 `dispatch-rejection`、`supersede(not-started-fenced)` 及**对话与作业两域 `CancelProofBody`**）、绑定源校验结果、当前 `assigned` 与运行状态、**消费点完整耐久既有证明集**（`acceptDispatchRejection` / `acceptSupersedeProof` 路径传 `[superseded, rejectedNotStarted(id, kind)]`；`submitCancelProof` 路径传 `[acceptedCancellations, superseded, containmentByAssignment, rejectedNotStarted(id, "cancel")]`）、`hasDurableStartedObservation`、`open` 决议事实及 `conflict.receivedRecordSeq` | 对话与作业两域的 `acceptDispatchRejection`、`acceptSupersedeProof`、`submitCancelProof` 六个公开入口（经对话 `#acceptNotStartedTermination`/`submitCancelProof` 与作业 `#acceptNotStarted`/`#rejectContradictoryNotStarted`/`submitCancelProof`）各自按 `DecisionScope`/`JobScope` 装载目标 run 与 assignment 行 | `same-proof-replay`（`submitCancelProof` 走 `durable-replay` 鉴权）\| `conflicting-prior-proof` \| `contradictory-not-started`（含重放幂等）\| `late-for-state` \| `conflict-seq-invalid` \| `accepted-not-started`（含是否闭合 `dispatch-conflict`） | **两域全部终止证据入口覆盖**：① 对话已耐久 `started` 后于 `cancel-requested` 收到 `CancelProof(not-started)` → 判 `contradictory-not-started`，记 `(id,"cancel")` 之 `not-started-rejected` 并开 **`cancel-unproven`**（区别于 `dispatch-rejection`/`supersede` 矛盾时的 `ledger-unknown` 与作业取消矛盾时的 `job-cancel-unknown`）、撤权转 `uncertain` 且保留 `started`；② 对话在 `uncertain(dispatch-conflict)` 且无 `started` 下收到 `CancelProof(not-started, lastRecordSeq > receivedRecordSeq)` → 判 `accepted-not-started(closesDispatchConflict: true)`，验 `usageFinal` 后同批写 `dispatch-conflict-contained + assignment-superseded + resolution(proven-not-started-redispatched) + 撤权 + state: queued`（而 `dispatch-rejection` 仍不可闭合已收到的 `dispatch-conflict`）；作业另按 `TaskDefinition` 禁用/删除态计算 `notStartedTargetState` 与 `notStartedResolutionKind` 并执行 `assertJobConflictContainmentReplayContract` |
| **2. 提交能力鉴权** | `AuthorityCallContext`（`principal`、`deadlineAt`）、`AssignmentSubmissionAuthorization`（`assignmentId`、`method`、`mode`）、当前权威任期匹配结果、`assigned` 激活信息（`capIds`、`executorId`、任期引用、可选 `envelope.capabilities`）、已撤销能力键状态、`verifier`、`now`、资源 URI | 对话 full/guard/imported 与作业 full/guard 均从各自已索引的 `assignedById` + `revokedCapabilities` 按键读取，零额外制品加载 | 通过或精确阶段拒绝（身份不匹配 / 任期过期 / 能力未激活或已撤销或过期 / 信封能力不一致） | 对话资源域 `conversation:<id>` + `ownerEpoch`（导入历史委派无本地 `envelope` 时按原合同跳过本地信封比对）；作业资源域 `task:<id>` + `anchorEpoch` 及对应错误消息 |
| **3. 数据面票据生命周期** | 请求参数、同 `ticketId` 既有票据及 `replacesTicketId` 映射、被替换票据及撤销状态、领域在同一前缀核定的**当前委派可签发裁决与入站 `surfacePrincipal`**、权威前缀时间 `issuedAt`、签名器；同步前沿查询含 `ticketSyncFrontier` 与窗口内票据 | 按 `ticketId`、`replacesTicketId`、`assignmentId` 与 `ticketSyncFrontier` 区间有界读取 | 同 `ticketId` 同载荷精确历史重放优先（异载荷冲突拒绝）、参数校验、`abort` 禁续期、`replacesTicketId` 链合法性、`surfacePrincipal` 限制、签发载荷构造、幂等撤销及 `nextDataPlaneTicketSyncFrontier` 计算 | **新票据签发两域最终均须当前已确认（`acked`）且处于 `dispatched \| running`、无 `cancelFence`**（`cancelled` 在两域均不可新签发票据）；真实分叉在于检查次序、错误分类与入站来源：对话对 `closedAssignments && runState === "cancelled"` 保留首段初筛放行以顺序校验 `admitted`、表面限制、续期链并在 `(cancel-requested \| cancelled) && cancelFence` 抛专用 `ConversationAssignmentCancelledError`，随后仍由终态检查拒绝；作业额外拒绝无 `ingressByJob` 的定时任务签发票据 |
| **4. 交互镜像与信任批次准备** | 已验签批次与 `batchDigest`、`assigned.executorId`、同批次键既有记录、当前镜像游标（`upTo`、`ordinal`、`mirrorDigest`、已见 `requestId`）、领域可接纳状态与鉴权 `mode`、信任沉淀/规则命中端口 | 锁外仅当预检满足同组提交前提时准备信任命中（防污染恢复记录），锁内同前缀复核，失败走 `#settleUncommittedTrustRuleHits` | 幂等重放回执、前缀摘要与 `ordinal`/`seq` 连续性、`requestId` 去重、锁外信任预准备与未提交清理、提交后 `accept` 驱动 | 对话按 `batchDigest` 索引并核对无签名载荷一致、校验 `closedAssignments` 与 `MAX_INLINE_LOGICAL_RECORD_BYTES`；作业按 `${assignmentId}:${batchDigest}` 索引，支持未完成 `interactionSettlementFences` 下的 `settlement` 模式与 `assertJobMirrorReplayContract` |

### 3. Executor 委派账本：公共协议推进、本地投影、分层历史与检查点指纹

保持 `ConversationAssignmentLedger` 与 `InProcessAssignmentSubmission` 全部公开端口，内部拆分为六个单一责任单元：

1. **协议推进与本地派生（`ledger/state-replay.ts`）**：**保持 `@zhixing-ai/core/protocol` 公开导出的 `applyValidatedAssignmentEntry(state: AssignmentLedgerValidationState, entry: AssignmentEntry): Digest` 函数签名与 `Digest` 返回值不变**。`RawLedgerState`（原 `LedgerProjection`）继续持有 `validation: AssignmentLedgerValidationState` 作为阶段、控制与栅栏的唯一协议事实源；每次归约先调用 `applyValidatedAssignmentEntry(state.validation, entry)` 取得链摘要 `Digest`，本地更新仅根据更新后的 `state.validation` 与当前记录维护执行器独有派生字段（`received.permission`/`resourceLease`、`sideEffects`、`requested`/`pendingRequests`/`finished`/`finishedOrder`/`finishedIndexBySeq`、`stagedMutations`/`mutationRequestIds`、`mirrored*`、`streamProjection*`、`acknowledgedCommitRevision`），不再平行编码第二套协议阶段转移，同时完整保留检查点反序列化与快照一致性损坏校验。
2. **分层投影与历史存储（`ledger/projection-history-store.ts`）**：统一封装热投影缓存（默认 64 条，完整保留 `options.maxCachedAssignments` 显式配置；正常视图与 `receiptRetirement` 退休视图严格隔离）、认证 `DecisionState` 检查点、`legacyHistory` 分页回退与 `ASSIGNMENT_LEDGER_INDEX_ID` 按键查询，对外提供 `readFacts / prepareHistory / transact / evidencePage` 窄接口。**事务内（`#transact`）与事务外只读入口（`#select`）共用同一缺键补齐重试回路**；从 `DecisionState` 检查点恢复后强制执行 `#recheckRestoredState` 核对派发信封与未结交互显示制品仍在场。
3. **执行控制与取消竞态（`ledger/execution-control.ts`）**：负责 `dispatch`、控制租约、`start`、`abort`/`cancel`/`supersede` 准入与证明，将本机执行句柄等待与日志裁决分离。严格保持取消竞态顺序：`abort`/栅栏先落盘耐久再阻止新副作用；已开始的副作用与交互结算仍允许闭合；跨 `await` 获取最终资源用量后必须在当前前缀重新验态再生成 `halted`/取消证明；若 `bundle_sealed` 已先提交则按既有记录顺序回放已封包结果，无法证明已停止时保持待对账/恢复。
4. **交互与副作用（`ledger/interaction-effect.ts`）**、**封包与证据页（`ledger/sealing-evidence.ts`）**、**回执等待与恢复对账（`ledger/receipt-recovery.ts`）**：封包前检查全部未结交互/镜像/流义务（不只看 `pendingRequests`）；回执等待队列、串行对账、租约时钟伴随记录与 `EXECUTOR_JOB_RECOVERY_PROJECTION_ID` 恢复索引封装在各自责任生命周期内。
5. **检查点函数源码指纹与冷热成本边界**：
   - `startup-proofs.ts` 的 `projectionCheckpointKey` 依赖 `Function.prototype.toString` 计算源码指纹。重构拆分子模块后，**禁止只把外层一行薄转发包装传给 `projectionCheckpointKey`**；必须显式维护并传入实际承载归约、校验、空状态构造与绑定提取的语义叶子函数清单（`LEDGER_DECISION_FINGERPRINT_FNS`、`LEDGER_BINDING_FINGERPRINT_FNS` 及对话侧对应归约函数组），若未来归约语义或序列化形状变更须同步升级版本号。
   - **诚实成本边界**：保持 `DecisionState` V8 序列化 DTO 形状不变，且**保留原有 5 秒 pending 合并、尽力保存（含 `legacyHistory` 读回核实）与显式 `flushDecisionStates()` 语义，不新增强制同步写检查点**。移动/重构归约函数源码本身会使新代码首次面对旧指纹检查点时触发一次合法失效：此时 `executor-data-plane-bindings` 与可恢复对话发现直接回退查询 `ASSIGNMENT_LEDGER_INDEX_ID`，读取成本仍按索引段深度有界；单个活跃委派的 `executor-assignment-decision` 在无匹配检查点时按原合同对该委派流执行**一次完整重放**（读量随该委派已完成历史增长，不产生跨委派整日志扫描）并进入 `#scheduleDecisionSave` 待保存队列——**仅在新检查点已有效保存（或测试显式 `flushDecisionStates()`）后**的下一次冷重开按 `checkpointReads === 1` 常数级命中，而在保存前中断或检查点存储不可写时继续合法重放且不丢失事实与兼容页。对话侧标量检查点保存已退役，`conversation-decision-migration.ts` 的受信旧代次指纹集（`TRUSTED_RUN_GENERATIONS` / `TRUSTED_GUARD_GENERATIONS`）与删除清理保持原样。

### 4. Host 协议运行时与执行协调：多寿命作用域、阶段推进与既有策略保持

保持 `ConversationProtocolRuntime` 公开接口、构造选项与后绑定契约不变，按真实寿命与职责拆为六个内部单元，**不引入未证实的新缓存淘汰或超时策略**：

1. **会话访问与收编基底（`ConversationAccess`）**：在当前 `AuthorityScope` 内管理 `journals`（保持现有 `Map` 语义，不新增固定容量 LRU 或引用计数淘汰；普通 `releaseConversation` 继续只从当前 `AuthorityScope` 移除可重建的 `journals` 与 `sessionIdentities`，**不递增权威代际**，也不影响路由、恢复登记、能力与认领）、带 `routeRevision` 令牌的委派路由表（`assignmentConversations`）、首触收编装入（`#adopt` / `#installAdoption` / `unavailableTransfers`）及后绑定端口稳定读取委托。
2. **准入与会话生命周期（`AdmissionAndLifecycle`）**：在当前 `AuthorityScope` 内管理 `preparedAdmissions`、输入准入、会话创建/清空/删除及未接管前台义务（`ForegroundObligation`）；`run()` 接管准备项时原子摘除其 `foreground` 句柄归属权，使后续清理未接管准备项时绝不误关已在跑运行的前台义务。
3. **单次运行阶段执行（`TurnExecution`）**：启动时捕获不可变 `RunAttemptHandle`（绑定所属 `capturedScope`、`capturedJournal`、`runClaimToken`、`assignmentClaimToken`、`attemptForeground` 与 `executionScope`），按 `prepare → execute → seal/commit → publish` 显式传递单次运行所持 `executorPlan`、输入/通道/表面流会话与资源句柄；本机终态队列内的 `#prepareRunEndUntilAvailable` **保持非睡眠立即分类退回（`RetryableRunEndPreparation`）**，将退避等待留在队列锁外。
4. **终态结算与跨代安全清理（`TerminalSettlement`）**：共享已确认终态的证据归属与释放判据，区分不同失败/取消结局。**旧 `run()` 跨换代 `finally` 走查**：若运行在外部等待或清理 `await` 期间发生 `recoverInstalledAuthority` 切换出 `newScope` 并为相同 `runId` 重建了准备与路由，旧 `run()` 进入 `finally` 时：① 本次尝试私有的物理与流句柄（`channelSession`、`firstPartyFinalitySession`、`firstPartySurfaceSession`、`executorPlan.dispose`、`attemptForeground.close`、`executionScope.close`）**无条件逐项隔离释放**，绝不因代差提前 `return` 造成泄漏；② 运行与委派认领释放（`clearRunClaims`、`activeAssignmentClaims.delete`）**仅对 `capturedScope` 按自身 `claimToken` 执行**，绝不删除 `newScope` 同 `runId`/`assignmentId` 的准备或认领；③ 派生路由清理 `#retireSettledAssignments` 与恢复补标仅当 `currentScope === capturedScope` 时执行。旧尝试已产生的外部效果或迟到密封包/取消证明，统一由新基底耐久账本栅栏与 `newScope` 恢复循环裁决或消歧。
5. **恢复调度器与登记序号（`RecoveryScheduler`）**：显式分离**单调恢复登记序号 `markSeq`**（每次 `#markRecovery` 在所属 `AuthorityScope` 内递增，恢复 claim 记录起始 `startMarkSeq`，完成时仅当当前序号仍等于 `startMarkSeq` 才清除，防抹除 `await` 期间并发新增登记）与**权威基底代际 `authorityScopeId`**（仅在 `recoverInstalledAuthority` 切换时新建）。完整保持 32 会话/4 worker 有界并发、显式恢复合流与 `#deferFirstSendRecovery` **精确让路一轮**策略。
6. **状态寿命归属与双层作用域（`RuntimeObligationScope`）**：
   - **状态寿命切分**：① **随 `AuthorityScope` 换代整体替换**：`journals`、`adoptedConversations`、`unavailableTransfers`、`sessionIdentities`、`assignmentConversations`（含 `routeRevision`）、`schedulingRuns`、`scheduledRuns`、`activeAssignmentClaims`、`preparedAdmissions`、`firstPartyPublishedFinals`/`ownerPublishedFirstPartyFinals`/`pendingFirstPartyFinals`、`recoveryConversations`（含 `markSeq`）、`recoveryMarkLedger`、`firstSendWindows`、`recoveryDeferredRounds`、`recoveryAttempted`、`pendingConversationRetirements`；② **普通缓存回收可丢弃**：仅 `journals` 与 `sessionIdentities`（`releaseConversation` 触发，不换 `AuthorityScope`）；③ **单次尝试独立寿命**：`RunAttemptHandle` 持有的流会话、`executorPlan`、`attemptForeground` 与 `executionScope`（随该帧 `finally` 释放）；④ **跨代持久事实**：落盘于 `AuthorityCommitLog` 的运行/能力/恢复状态。
   - **暂停 vs 换代与 `#retireSettledAssignments` 走查**：`stopRecoveryLoop` 不换 `AuthorityScope`，仅停定时器、清 `firstSendWindows`、中止并等待 `afterUsableUnfinished`、等待在途恢复轮次与 `controlBasis`，保留 `journals` 与路由表；`recoverInstalledAuthority` 先停恢复并等待 `readinessRecovery` 与 `lifecycleProjectionClaims`、核验无残留 `activeRecoveryClaims`，再切换全新 `AuthorityScope` 并关闭 `oldScope` 未接管 `preparedAdmissions` 的前台义务（持 `oldScope` 的异步返回禁写 `currentScope`）。`#retireSettledAssignments` 在 `await journal.assignmentsAwaitingRecovery()` 前快照 `(capturedScope, candidateRouteRevisions)`，返回后若 `currentScope !== capturedScope` 直接放弃，同代内仅遗忘不在 `recoverable` 中且 `routeRevision` 未变的路由，避免误删 `await` 期间并发新绑路由。
7. **Worker 与调度接线边界**：`conversation-assignment-worker.ts` 与 `job-assignment-worker.ts` 继续复用 `durable-obligation-retry.ts` 与 `assignment-worker-obligations.ts`，各自保留不同的 `#scheduleCancellation` 与作业交互恢复退避协议，仅收敛确实重复的窄辅助逻辑，并同步适配 `conversation-executor-dispatch.ts` 与 `anchor-scheduler-runtime.ts` 的计划释放与换代接线。

## 渐进推进切片

在隔离分支/worktree 内按六个完整责任闭包依序推进，每片仅保留唯一在线实现，数据协议全程不变，任一切片异常可按提交安全回退：

| 切片 | 交付闭包 | 必答验证问题 |
| --- | --- | --- |
| **A. 叶子契约、静态锚点与缓存指纹核定** | 提取各簇内部叶子类型/窄接口；建立门面零反向 `import` 约束；固化检查点指纹叶子函数清单与隔离环境新鲜构建基线快照 | 原公开入口导出与类型完全兼容；内部模块无反向依赖门面；记录判别式与状态字段归属全集无遗漏 |
| **B. 对话账本簇与直接消费者重构** | 落地 `conversation-journal/` 状态族、阶段化提交、统一事务骨架、发布/Final 模块与 dispatcher，同步适配 `conversation-decision-migration`、`conversation-base-domain`、`conversation-run-queries`、`advancement-recovery-index`、`conversation-run-state-*` | 同前缀原子合批与多步控制顺序不变；full/guard/冷补齐/已收编导入基线语义一致；后置发布失败不倒改已提交结果 |
| **C. 作业账本簇与四族共享协议合拢** | 落地 `job-journal/` 状态族、主/守卫共享受限 sink 归约核、目录/失败摘要按层预装维护器，接入经核实的四族共享协议核并保留双域差异 | 四族共享规则单源且精确合同结果与差异分支（如四消费点 `not-started`、两域票据次序与错误分类、作业结算栅栏）完整保持；守卫路径无越界全量加载 |
| **D. Executor 委派账本簇重构** | 落地 `executor/src/ledger/` 六单元、`validation` 单一协议阶段源、四层历史/缓存统一补齐回路、取消/封包竞态与检查点叶子函数指纹保护 | 取消/封包/迟到证据与同批资源/租约伴随不变；事务内外冷补齐与检查点恢复制品复核闭合；检查点命中与失效单流重放符合成本合同 |
| **E. Host 协议运行时与协调接线重构** | 落地 `ConversationProtocolRuntime` 六单元、双层停止/换代作用域、登记版本单调消费与隔离清理，完成 `dispatch`/`scheduler`/Worker 受影响接线适配 | 一轮首发让路、并发新登记不丢失、`stopRecoveryLoop` 与 `recoverInstalledAuthority` 寿命区分、旧异步义务安全收束及本机/Anchor 语义保持 |
| **F. 冻结候选全量构建、物理耐久、规模与双审收口** | 基于同一冻结候选执行全量构建、物理同步耐久/恢复闭环、规模有界性对照、S7/导出/拓扑门禁核验，完成无历史盲审冷执行与总控独立终审 | 下文九项最终验收门槛全部实证达标，无临时双实现、无绕过门禁、无主工作区或日常运行数据污染 |

## 最终验收标准与门槛

全部九项条件须在同一冻结候选上同时提供可复核证据方可勾选完成，严禁以测试通过替代内部结构验收，或以快速源码替身（如默认 `fsync no-op`）替代最终耐久实证：

| 验收维度 | 验收方式、标准条件与通过门槛 |
| --- | --- |
| **1. 范围闭合与状态封装真落地** | 逐项核对四簇全部原公共方法、记录 `t` 分支、状态字段与恢复义务均归属明确内部单元（配编译期穷尽检查与责任映射表）；入口门面与事务壳不再残留大段领域 `switch` 或透传宿主 `this` 的万能上下文；`operations/*` 零持有整份可变 `RunProjection`/`JobProjection`/`LedgerProjection`；静态检查确认内部子模块对四个门面文件的反向 `import` 数为 `0`。 |
| **2. 单点改动影响面实证缩小** | 针对五类典型维护变更——① 对话输入/排队规则、② `not-started` 矛盾证据判定、③ 作业连续失败摘要、④ 执行器交互结算、⑤ 运行时首发让路与显式恢复合流——对比重构前基线，由非执笔盲审员在真实重构代码上独立重做改动推演：每项均能唯一定位至对应规则源、窄输入适配与定向测试，无需通读或修改无关状态族表示（五项全部满足）。 |
| **3. 共享规则单源与输入闭包实证** | 本次收敛的四族共享协议（含 `not-started` 在对话与作业两域 `acceptDispatchRejection`、`acceptSupersedeProof`、`submitCancelProof` 全部终止证据入口）与 `JobReduction` 主/守卫共享转移核各自只有唯一语义实现；每个 full/guard/导入/重放消费点均提供有界前态读取与缺载重试证据。通过定向反例测试集验证：对话 `started` 后 `CancelProof(not-started)` 判 `cancel-unproven` vs `dispatch-rejection`/`supersede` 判 `ledger-unknown` vs 作业判 `job-cancel-unknown`、对话 `uncertain(dispatch-conflict)` 下合法 `CancelProof(not-started)` 闭合回 `queued`、缺同批伴随记录、错误能力/任期身份、票据同 ID 精确重放优先且两域 `cancelled` 均拒新签（对话保留 `closed+cancelled` 检查次序与 `ConversationAssignmentCancelledError`，作业无 `ingress` 定时任务拒签）及作业 `interactionSettlementFences` 结算窗口，任一消费点漏判或守卫越界加载即判定不通过。 |
| **4. 原子提交、两段参与方与外部效果等价** | 相同确定性输入夹具下，核对接受/拒绝/重放结论、记录流归属与次序、锁外 P1 冻结 `readProjectionIds`/`candidateReferences` 与锁内 P2 伴随记录完整性、缺工作集/前缀变化重做时复用 `PreparedSubmission` 且不重复信任预准备或 `afterGlobalCommit`：新增分笔提交、未保护制品引用、重复外部副作用或遗漏伴随记录均为 `0`；后置发布或通知失败不改变已提交回执。 |
| **5. 并发交错、取消竞态与换代句柄隔离** | 受控交错测试覆盖：锁外准备期间并发撤销能力或开栅栏、`seal` vs `abort` 与在途副作用闭合、`await` 期间并发新增恢复 `markSeq` 或新绑 `routeRevision`（验证不被旧轮完成抹除或遗忘）、`stopRecoveryLoop` 暂停重启 vs `recoverInstalledAuthority` 切换 `AuthorityScope` 并重建同 `runId` 后旧 `run()` `finally` 收尾（验证旧物理/流句柄完整释放且零误删 `newScope` 准备/认领/路由）、普通 `releaseConversation` 不触发换代、本机终态队列非睡眠退回。在可恢复存储与消息可达前提下，越代缓存写入、前台/资源预留泄漏、恢复登记丢失均为 `0`。 |
| **6. 真实存储、历史形状与跨组件恢复** | 在**物理同步模式（`--physical-sync`）或新鲜构建 `dist/` 生产入口**下，使用真实 `AuthorityCommitLog`、生产签名验签与真实关闭重开，通过受影响的本机 Owner、Anchor/Executor、配对、收编导入首触装入及换代恢复闭环测试；对触及重构的检查点/索引与 `legacyHistory`/迁移路径覆盖纯旧、纯新、旧开始新结束、切换中断重来、切换后尾部五种历史形状及损坏拒绝（`AuthorityStorageError`），无需用户迁移既有日常数据即可直接启动。 |
| **7. 读写规模有界与冷热成本诚实保持** | 实跑并满足既有规模套件与原阈值（不放宽系数）：至少覆盖 `assignment-ledger-binding-scale.test.ts`（`64 / 256 / 1024` 已结束派发）、`assignment-ledger-decision-state.test.ts`（`2 / 8 / 20` 续租及 `2 / 128 / 512` 已完成交互/副作用）、`assignment-ledger-legacy-history.test.ts`、`job-journal-scale.test.ts` 及对话按键/守卫规模测试。单独列出**缓存/检查点有效保存后命中行**、**冷失效单流重放行**与**保存前中断/缓存不可写合法回退行**（不用热命中掩盖冷路，也不新增强制同步写），验证新增每操作全历史扫描为 `0`、叶子归约函数变更使旧检查点键失效，并在单流重放及有效保存（测试显式 `flushDecisionStates()`）后下一次冷开恢复 `checkpointReads === 1`。 |
| **8. 全量构建、S7 锚点与导出/契约门禁** | 同一冻结候选上：`pnpm build`、`pnpm s7:lint`（含 `s7-entry-coverage.mjs`、`s7-entry-coverage.test.mjs`、`s7:registry-golden`、`s7-behavior.mjs`）、`pnpm contracts:typecheck`、`pnpm security:supply-chain`、`pnpm security:mesh-test-clock`、`pnpm security:secrets`、`provider-call-governance-registry.test.ts`、`startup-server-owner.test.ts` 及全部受影响测试套件均须 **`exit 0`**（若 `test-source.mjs` 参与阶段验证，须核实实际选中文件与执行用例数 `> 0`）。S7 或源码治理锚点随职责下沉移位时，须附反向破坏单测证明原违规仍被拦截，严禁留空壳方法骗扫描。对照隔离环境动刀前基于未改动 `f724d845` **新鲜 `pnpm build` 实测固化**的基线（禁止拿陈旧未构建 `dist/` 作默认豁免）：`packages/{core,owner-kernel,executor,cli}/package.json` 的 `exports` 子路径键集合、`tsup.config.ts` 入口集合及触及子路径公开 `.d.ts` 类型面完全兼容（`0` 意外增删），`check-runtime-package-exports.mjs` 与 `pnpm contracts:lint` 在本次触及/新增范围 `0` 违例且全仓无新增失败码，`distributed-runtime-structure.test.ts` 无环/禁止边/RPC 合同全绿且零新增跨区 `(sourceZone, kind, target)` 依赖边。 |
| **9. 无历史冷执行盲审、独立终审与收尾** | 按[跨会话协作约定](../workbench/cross-session-collaboration.md) §3.13，由无历史新会话在冻结隔离 worktree 上先只读需求、合同与公开入口自主冷执行关键跨界/恢复验证，再冷读实现与测试结构；随后经总控独立终审达成 `0 blocker / 0 major`。主工作区未提交/已暂存内容、日常 `~/.zhixing` 与全局 CLI 链接保持未触碰，临时测试进程与一次性目录清理完毕，隔离分支提交与验收证据完整保留供集成审阅。 |

## 执行待办

每项须在对应交付物及所列质量门禁全部实证过关后，方可更新为已完成（`[x]`）；未通过或问题修复未复验前严禁提前勾选。

- [x] **1. 修复跨会话协作收敛与审查链路**：针对协作中范围误判、向保守空话妥协及审查脑补填空导致质量变差的根因，修订 `session-collab` 技能与[跨会话协作约定](../workbench/cross-session-collaboration.md)（不写耦合代码、不污染通用系统规则），经双边实操盲测、增量回归与总控独立终审通过（归档于 `collab/threads/20261116-fix-session-collab-chain-9d4a/controller-final-attainment-r2.md`）。
- [x] **2. 双人独立重研“如何设计好”并更新 `## 设计方法`**：围绕“怎样才能设计好此类核心状态机架构”（与“要什么效果”分离），负责人与总控严格按 `research` 技能各自独立调研一手原理、工程实践与本仓实证并先行冻结，再按修复后的协作规则交叉质询收敛，产出能实际构造并检验候选方案的具体设计方法与适用边界，按 `write-for-readers` 更新上文 `## 设计方法`，经无历史新会话方法应用盲审与总控独立终审通过（归档于 `collab/threads/20261116-design-method-research-v2-3e8b/cold-method-final-r3.md` 与 `controller-gate2-attainment.md`）。
- [x] **3. 把控完整有限的优化范围，完成具体架构设计并明确最终验收标准与门槛**：不机械局限于上文 4 个代表性文件，基于全仓真实耦合与同构路径划定完整但具有清晰结束边界和结束目标的本次优化范围（区别于伴随系统生命周期的持续性系统优化，不扩成无界重写）；依据本文档要求、[整体架构概述](../architecture/overview.md)及更新后的 `## 设计方法` 完成具体架构设计，并在设计中写明可判定的**最终验收方式、标准条件与通过门槛**（含经审核的可推进切片边界），经无历史新会话盲审与总控独立终审通过（归档于 `collab/threads/20261116-state-machine-concrete-design-5c1a/cold-design-final-v3.md` 与 `controller-gate3-attainment-v3.md`）。
- [x] **4. 制定并建立不阻塞主线的隔离分支与工作环境方案**：在具体设计过关后，按 `branch-management` 技能与[路径及资源隔离规范](../engineering/path-and-resource-isolation.md)建立独立分支（`codex/feature-state-machine-arch-opt`）与隔离 worktree（`E:/zx-iso/state-machine-arch-opt`）及独立运行数据根（`E:/zx-iso/state-machine-arch-opt-runtime`），确保不触碰主工作区未提交/已暂存文档、日常运行数据与全局 CLI 链接，不阻塞 `develop`/`main` 主线发布与宏观主线推进，不擅自推送或发布；经总控核对确认通过（归档于 `collab/threads/20261116-state-machine-concrete-design-5c1a/worktree-receipt.json`）。
- [x] **5. 总控监督负责人深入理解并内化高效工作方法本质**：开启架构优化代码落地前，负责人亲读[高效工作方法](../engineering/antigravity-gemini-4-carbon-high-efficiency.md)，不硬搬照抄持续性系统优化的巡检流程，而是结合本次有限边界架构重构深入理解其高效本质（前置核实一手依据与测试替身边界、合并已知独立工作、先低成本证伪后集中构建验证、冻结交审与有效证据复用、遇阻及时交接防外围空转），经总控严格监督审核通过（归档于 `collab/threads/20261116-state-machine-concrete-design-5c1a/owner-gate5-efficiency-plan.md` 与 `controller-isolation-and-execution-plan.md`）。
- [x] **6. 隔离分支架构与实现优化落地及阶段验证**：在隔离分支按通过审查的具体设计与高效工作纪律完成目标范围内的架构与实现优化，通过全量构建（`pnpm build`）、静态与导出门禁（`s7:lint`、`runtime:package-exports`、黄金基线）及受影响/相关测试套件验证，确认公开契约、历史数据/检查点重放及正确性/安全/性能底线不降级后勾选（最终冻结候选 `542f24c800ae17a43ae12d24e27780c8dedbc394`，实证矩阵归档于 `collab/threads/20261116-state-machine-concrete-design-5c1a/owner-slice-f-candidate-and-9gate-evidence.md`）。
- [x] **7. 最终验收、无历史盲审冷执行、独立终审与收尾交接**：逐项对照具体设计明确的最终验收方式、标准条件与通过门槛完成实测举证，按[跨会话协作约定](../workbench/cross-session-collaboration.md) §3.13 完成无历史新会话冷执行与冷读盲审、真实缺陷修复闭环（含 `9851023d` 增量复验与 `542f24c8` 公开读面短实测）及总控独立终审验收；最终候选 `542f24c800ae17a43ae12d24e27780c8dedbc394` 已快进合入 `develop`，主目录完整构建、旧样本读回与正常停机验证通过，临时分支、worktree 和运行根已清理，必要验收日志已归档（记录见 `collab/threads/20261116-state-machine-concrete-design-5c1a/{controller-final-attainment.md,owner-final-attainment-and-resource-handover.md,integration-handover.md}`）。
