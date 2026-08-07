## 审查清单

### 当前状态

- **当前单元**：第 31 单元 · generation 1
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`research/design/drafts/scheduler-architecture.md`、`task-advancement-rubric-architecture.md` 与当前定稿开发清单 D31-01～D31-06；其他模块文档不是本单元架构依据
- **交付基线**：父提交 `6410de0a` → 当前工作树；闭包共 41 个路径，其中 34 个属于第 31 单元生产实现、直接测试、结构门禁与当前合同同步，7 个 `research/design/workbench/` 路径仅承载工作台、归档、台账与验证规则状态，不参与功能通过判定
- **目标提交边界**：第 31 单元（S8）只交付随本地域 conversation owner 的 schedule/rubric `DeferredGlobalIntent` 耐久流、收编前查询/撤销、锚点 internal review 与原子确认归宿；不传输意向、不切换 current owner、不开放公开离线入口
- **明确排除**：第 32 单元 `AuthorityTransfer`、freeze/checkpoint/import/commit/tombstone、current-owner 切换与公开 CLI/RPC/渠道离线旅程；memory/workscene/skill/trust/config/delivery/rubric archive 意向；离线 schedule 读取、部分 patch、run/abort、直接全局写、job/delivery；第 33～38 单元；第二事实源、通用 intent/事务/outbox/事件总线/registry/调用图及监控、诊断、benchmark、信息采集
- **当前任务进度**：100%（33 / 33 项已通过；0 项 [ ]，33 项 [x]，0 项 [!]，0 项 [~]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：独立审查通过。冻结修复指纹 `sha256:b6ad14d0…0a6f` 上的 21 个受影响项已逐项复审，12 个事实未变化项直接复用；33 项全部 `[x]`，两类问题列表均为空。证据闭包：owner-kernel 13/13、两生产根 2/2、S7 15/15+golden、workspace build 17/17，以及本轮对生产调用图、权威日志前缀、pending materializer、公开零入口和 Unit32 边界的只读对账。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| `always-online-and-local-execution-requirements.md` §一 | 适用 | 持续在线与本机真实环境并存的产品问题归入 IR31-01、IR31-30～IR31-31。 |
| 需求文档 §二～§五 | 不适用 | 外部项目转述、事实核验与方案形成过程不是本单元规范性合同。 |
| 需求文档 §六～§七 | 适用 | 两种部署形态体验平权、本机继续工作与全局能力诚实不可用归入 IR31-11～IR31-15、IR31-24、IR31-30。 |
| `distributed-runtime-charter.md` 当前交付原则、一、二 | 适用 | 最小完整产品、一个产品与本机连续工作归入 IR31-01、IR31-11～IR31-15、IR31-30～IR31-33。 |
| 总纲 §1 | 适用 | 单机退化形态与锚点/本地域权威分界归入 IR31-01、IR31-06、IR31-22～IR31-24。 |
| 总纲 §2 | 适用 | anchor、executor、surface 职责及意向 record/review 的角色边界归入 IR31-06、IR31-16～IR31-17、IR31-23～IR31-24。 |
| 总纲 §3 | 适用 | core→owner-kernel→owner-services→cli 的正式依赖方向及无环边界归入 IR31-22、IR31-25、IR31-32。 |
| 总纲 §4 的身份、权限、能力与最小权限 | 适用 | conversation/current-owner、principal×method、deadline 与 fail-closed 归入 IR31-02、IR31-06、IR31-09、IR31-16～IR31-17、IR31-29。 |
| 总纲 §4 的 mesh、配对、信任链、SecretStore 与迁居授权 | 不适用 | 属既有 S2/S5 或第 32 单元；本单元仅在 IR31-25～IR31-27 检查未越权开放。 |
| 总纲 §5 | 适用 | conversation-owned intent、全局 schedule/rubric owner 与正负能力矩阵归入 IR31-06～IR31-18、IR31-23～IR31-27。 |
| 总纲 §6 | 适用 | 本单元只复用 control admission、幂等、CAS 与确认终态，归入 IR31-16～IR31-21；run/job 派发状态机不扩写。 |
| 总纲 §7 | 不适用 | Environment 路由由第 30 单元既有 local owner 提供，本单元没有新环境选择或 workspace 义务。 |
| 总纲 §8 | 适用 | rubric ArtifactStore 依赖闭包与确认最终性归入 IR31-10、IR31-14、IR31-18～IR31-21。 |
| 总纲 §9 | 适用 | schedule/rubric 意向闭包、随 owner 迁移、锚点重校验、时效再确认、internal-only 与第 32 单元接缝归入 IR31-01、IR31-06～IR31-27、IR31-30。 |
| 总纲 §10 | 适用 | intent 投影恢复先于准入、写入受 lifecycle gate、关闭拒绝新写归入 IR31-22～IR31-24。 |
| 总纲 §11 | 适用 | “尚未生效/连接值班设备后确认或保存”的诚实产品语言与零公开入口归入 IR31-11、IR31-15、IR31-25、IR31-30。 |
| 总纲 §12 | 适用 | 响应丢失、冲突、日志/投影恢复、资产缺失、重启和停机归入 IR31-07～IR31-10、IR31-15、IR31-18～IR31-24、IR31-28。 |
| 总纲 §13 不变量 1～5、8、11～12、14～17 的直接部分 | 适用 | owner fencing、幂等、角色零加载、ID、双拓扑、结构、staged 零外泄、安全与恢复归入 IR31-02～IR31-29。 |
| 总纲 §13 的 job/channel/transfer/资源治理专属部分 | 不适用 | 不属于第 31 单元；本单元只验证没有建立相应能力旁路。 |
| 总纲 §14 第 31 单元 | 适用 | S8 `DeferredGlobalIntent` 实施顺序与 internal-only 停止条件归入 IR31-01～IR31-33。 |
| 总纲 §14 第 30、32～38 单元 | 不适用 | 第 30 单元仅作已完成前置条件，第 32 单元仅保留消费接缝；后继能力不得提前成为提交内容。 |
| 总纲 §15 | 适用 | 范围内双生产根、严格联合、恢复、冲突、原子性和产品文案证据归入 IR31-02～IR31-33。 |
| `specification.md` §1.1 | 适用 | `int-<Ulid>`、conversation/localDomain、requestId、LSN 与规范时间归入 IR31-02～IR31-03、IR31-07～IR31-09。 |
| 规格 §1.2 | 适用 | canonical digest、未知字段拒绝、引用闭包与 wire/log 一致性归入 IR31-02～IR31-05、IR31-07、IR31-10、IR31-29。 |
| 规格 §1.3、§1.3b | 适用 | `DeferredGlobalIntent`、`IntentStreamRecord`、schedule/rubric 联合与 control result 类型归入 IR31-02～IR31-05、IR31-18～IR31-21。 |
| 规格 §1.4～§1.5 | 适用 | 术语映射、内部 AuthorityError accepted-domain、拒绝终态与公开映射边界归入 IR31-11、IR31-15、IR31-18、IR31-29～IR31-31。 |
| 规格 §2.1～§2.2 | 适用 | host/surface/assignment 方法矩阵、current owner 与 authenticated surface 归入 IR31-06、IR31-09、IR31-16～IR31-17、IR31-25。 |
| 规格 §2.3～§2.5 | 不适用 | SecretStore、暴露记录与 mesh bootstrap 不由本单元修改或消费。 |
| 规格 §3.1 | 适用 | rubric local-draft 先进入既有 SessionState、发布失败不回滚采用归入 IR31-13、IR31-15。 |
| 规格 §3.2 | 适用 | 锚点 schedule/rubric 全局 validator、reducer、CAS 与 revision 归入 IR31-18～IR31-21。 |
| 规格 §3.8、§3.2b | 适用 | intent record/list/decide 闭合方法集、principal 守卫、local/anchor/current-owner 边界归入 IR31-06～IR31-09、IR31-16～IR31-17、IR31-25。 |
| 规格 §3.3～§3.7 | 不适用 | 环境、资源、advancement review、run executor/submission 端口是既有上游能力；本单元没有新增或改写其协议。 |
| 规格 §4.1 | 适用 | 每域唯一 AuthorityCommitLog、逻辑流、一次 fsync、耐久投影和日志锁内读取归入 IR31-04～IR31-10、IR31-18～IR31-23。 |
| 规格 §4.2 | 适用 | rubric 内容先落 ArtifactStore、候选引用闭包与缺件拒绝归入 IR31-10、IR31-14～IR31-15、IR31-18。 |
| 规格 §4.3 | 适用 | `intent:<conversationId>`、latest-wins 状态和 transfer 分类归入 IR31-04～IR31-09、IR31-20、IR31-27。 |
| 规格 §4.4 | 适用 | 全局 reducer 准备、同一事务 global effect+control applied+intent confirmed 归入 IR31-18～IR31-21。 |
| 规格 §4.5 | 适用 | intent、投影和 rubric 引用的保留/重建边界归入 IR31-08、IR31-10、IR31-20。 |
| 规格 §5.1 | 适用 | internal global-write control envelope、稳定 request binding 与回放归入 IR31-18～IR31-21。 |
| 规格 §5.2～§5.7 | 不适用 | 派发、能力匹配、run/job 提交、状态投递、stream 与取证不是本单元新增功能；禁止借意向重开这些路径。 |
| 规格 §6.1～§6.2b | 不适用 | conversation/job 状态机由既有 owner/runtime 承担，本单元不新增 run/job 状态。 |
| 规格 §6.3 | 适用（边界） | intent 必须被分类为 conversation-owned transfer 内容，但 freeze/import/current-owner 切换与收编事务属于第 32 单元；归入 IR31-27。 |
| 规格 §6.4 | 不适用 | 设备状态与 uncertain resolution 不由意向协议改变。 |
| 规格 §7 | 适用（局部） | conversation 域的 intent 随 owner 转移/保留分类归入 IR31-27；其他权威类别不进入本单元。 |
| 规格 §8 | 适用（局部） | schedule 四种完整写、rubric save-own/update-own 与 internal intent 落点归入 IR31-11～IR31-18、IR31-25；其他落点不扩写。 |
| 规格 §9 | 适用 | local/anchor 两域 schedule、rubric、intent、公开能力差异逐行归入 IR31-11～IR31-18、IR31-23～IR31-28。 |
| 规格 §10、§10.1 | 适用（交界） | 本单元不得新增资源/存储治理旁路；启动恢复和关闭在途追加边界归入 IR31-10、IR31-22～IR31-24。 |
| 规格 §11 | 适用 | 离线记录、尚未生效、时效再确认和重连后待复核的零术语文案归入 IR31-11、IR31-15、IR31-30。 |
| 规格 §12 的直接不变量 | 适用 | ID、幂等、栅栏、双拓扑、角色零加载、结构、安全、恢复与资产在场归入 IR31-02～IR31-29。 |
| 规格 §12 的 job/channel/mesh/transfer/存储维护专属矩阵 | 不适用 | 不属于第 31 单元，不得形成配置×故障笛卡尔积。 |
| 规格 §13 的 scheduler 与 rubric 行 | 适用 | 当前 schedule/rubric 文档与离线沉淀边界同步归入 IR31-31。 |
| 规格 §13 的其他模块行 | 不适用 | 当前交付没有修改相应模块合同。 |
| 规格 §14 | 不适用 | S1 历史开工说明不是第 31 单元现行合同。 |
| 规格 §15 第 30～32 项及依赖顺序 | 适用 | 第 30 单元同构 owner 是前置，第 31 项是当前实现/验收，第 32 项只作为可消费接缝；归入 IR31-01、IR31-22～IR31-28、IR31-33。 |
| 规格 §15 其他项 | 不适用 | 已完成上游仅按具体接口消费，后续 33～38 不得成为当前门禁。 |
| `scheduler-architecture.md` 当前生产架构、§一与§三中现行 authority mutation 合同 | 适用 | 四种完整 schedule 写、revision CAS、无 read/run/abort 与真实产品语义归入 IR31-11～IR31-12、IR31-18～IR31-20、IR31-30。 |
| scheduler 文档 §二、历史推演及“待根治项” | 不适用 | 历史割裂说明与另案技术债不是第 31 单元交付义务。 |
| `task-advancement-rubric-architecture.md` 需求区、§0～§3 | 适用（边界） | 用户价值、local-draft 与既有 advancement 拓扑作为上游边界归入 IR31-13～IR31-15、IR31-30。 |
| rubric 文档 §4.1～§4.3、§4.5～§4.7 | 适用（上游） | 既有 advancement 状态身份不得被沉淀意向改写，归入 IR31-13、IR31-15、IR31-32。 |
| rubric 文档 §4.4、§5.2 | 适用 | 快照采用与全局库沉淀分离、save/update 离线转意向归入 IR31-13～IR31-15。 |
| rubric 文档页首 S7 当前取证边界 | 适用（上游） | 本单元修改 S7 门禁与 advancement 发布接缝，不得恢复本地 `evidenceProvider`、fallback 或兼容开关；归入 IR31-26、IR31-32。 |
| rubric 文档 §5.1、§5.3～§7 的既有 run/review/recovery | 适用（交界） | 既有推进生命周期继续运行且不被发布失败回滚，归入 IR31-13、IR31-15、IR31-28、IR31-32。 |
| rubric 文档 §7 的全局预算待决项 | 不适用 | 文档明确为跨模块待决义务；第 31 单元不新增全局预算或局部限流。 |
| rubric 文档 §8 的当前全局资产/会话身份与 §9 cache 边界 | 适用 | ArtifactStore、只读 cache revision、active snapshot 不变归入 IR31-10、IR31-13～IR31-15、IR31-18、IR31-32。 |
| rubric 文档 §8 的冷启动预设与演化回路 | 不适用 | 文档分别明确进入 requirement backlog 和“留口不实现”；没有当前单元交付义务。 |
| rubric 文档 §10 | 适用（局部） | 仅 save/update 选择后的发布结果与“采用不等于已保存”反馈归入 IR31-13～IR31-15、IR31-30；既有事件、确认 UI、收场与未来渠道节奏不由本单元重审。 |
| rubric 文档 §11～§14 | 适用（上游） | 只取当前稳定角色边界、直接测试拓扑与不变量，归入 IR31-22、IR31-25、IR31-28、IR31-32～IR31-33；历史包名和已交付施工记录不形成新落点。 |
| rubric 文档 §15、C1～C17 | 不适用 | 已完成的提交/审查拆分与施工记录不是第 31 单元现行实施清单，只由 IR31-32 守有限上游兼容。 |
| rubric 文档 C18 当前持久化选择合同 | 适用 | `save-new`/`update-existing` 的用户选择、目标 identity/revision 与 active snapshot 不变直接归入 IR31-13～IR31-15。 |
| `unit-development-workbench.md` 静态目标/边界与 D31-01～D31-06 | 适用 | 六项生产、消费、异常、恢复和直接测试义务反向归入 IR31-01～IR31-33。 |
| 当前完整交付物 HEAD `6410de0a` 与工作区 36 个变化路径 | 事实来源 | 32 个第 31 单元生产、直接测试、S7 门禁与当前合同路径逐一归入 IR31-01～IR31-33；4 个工作台/上一单元归档与台账路径明确排除，不参与功能通过判定。 |

### 审查项

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR31-01 | [x] | 单元身份、边界与完整交付物 | 冻结当前 41 个变化路径并二元归属；34 个功能路径必须全属 D31-01～D31-06，7 个工作台/归档/台账路径不参与功能判定；不得含第 32～38 单元能力或无依据框架。本项在路径归属与边界对账完成后停止。 | 复审 `6410de0a` 至当前工作树的 41 路径：34 个功能路径全部反绑 D31-01～D31-06，7 个 workbench 路径仅为流程状态；U31-01～U31-02 修复增量只闭合会话身份/intent 同日志线性化、schedule pending 重驱及直接证据。未实现 transfer、current-owner 切换、公开离线入口、结果联合或通用框架，EX31-01 未触发。 |
| IR31-02 | [x] | 严格意向判别联合 | `DeferredGlobalIntent` 只接受 schedule-create/update/set-state/delete 与 rubric-save-own/update-own；各分支字段、revision、ArtifactRef、timeSensitive 分类、未知字段和跨族组合在副作用前严格校验。 | `deferred-global-intent.ts` 以六分支精确键集复用 schedule/rubric validator，并强制 schedule=true、rubric=false；`control-artifacts.ts` 的 global-write 同用该 validator。联合测试覆盖六正例、未知/缺字段、跨族、revision 与时效错配，均在日志调用前抛错。 |
| IR31-03 | [x] | identity、时间与 digest | intentId 必须为稳定 `int-<Ulid>`；localDomainId、conversationId、requestId、recordedAt/reviewedAt、mutation digest 与首次 envelope 时间全等反绑，重启、重放和收编不得漂移。 | 确定性 intentId、首次 envelope 时间与 mutation digest 合同未改；窄 journal 事务只移动线性化位置，不重算身份或时间。matching replay 先于 fresh guard 返回原 intentId/recordedAt，终态仍只由同一 reducer 固化 reviewedAt；异载荷与相反终态稳定拒绝。 |
| IR31-04 | [x] | intent 流与记录 codec | 记录只可进入 `intent:<conversationId>`，不得与 `intent:rubric-registry` 或异会话碰撞；wire/log codec、`IntentStreamRecord` 与流分类双向全等，错流零追加。 | `deferredIntentStream`/`isDeferredIntentStream` 明确排除 `intent:rubric-registry`；record、projection reducer 与 control reducer 均经 `validateIntentStreamRecord` 双向反绑 body conversationId 与流后缀。codec 测试覆盖异会话、rubric-registry 碰撞与畸形记录，失败前无 append。 |
| IR31-05 | [x] | latest-wins 状态机 | 每个 intent 仅允许 pending→confirmed 或 pending→discarded；pending 首记录、终态不可改写、相反决定拒绝、exact terminal replay 零追加，身份/正文/timeSensitive/recordedAt 不可变。 | reducer 仍只接受 pending 首记录及两个单向终态；record/discard 的 matching replay 均在 fresh identity/delete guard 前零追加返回，异载荷或相反终态拒绝。confirmed terminal replay 仅重驱既有派生 pending，不改写 intent 或全局权威记录。 |
| IR31-06 | [x] | repository owner 与准入 | record 仅当前本地域 owner 的既有 local conversation/host；anchor record、assignment、错域/错 owner/未知或已删除会话、过期 deadline 均在日志/资源副作用前拒绝；list/decide 仅当前 owner 允许 principal。 | 静态 mode/principal/domain/deadline 拒绝保持在事务前；fresh record/discard 改由当前 `ConversationRunJournal` 在同一 AuthorityCommitLog 锁内联合读取 control identity、journal identity/delete、ownerEpoch 与 intent 投影。delete 胜出时零 intent 追加，intent 胜出时完整提交；未知/已删除会话拒绝，matching replay 可越过后续删除全等返回。 |
| IR31-07 | [x] | record 幂等与并发线性化 | requestId+domain+conversation+规范 mutation/timeSensitive 形成稳定操作；exact replay 返回原 intentId/recordedAt 且零追加，异载荷复用冲突，并发、fsync 前后、响应丢失和连续重启无半记录或双 intent。 | 稳定 request/digest 身份不变；journal 窄事务把 intent 投影与会话 delete 放入同一日志前缀，先判 exact replay、再判 fresh identity 并 append。真实同日志竞争证明并发同请求与 delete 只有一个合法提交，响应丢失/重启仍返回原身份和首次时间，异载荷零追加拒绝。 |
| IR31-08 | [x] | 耐久投影、排序与重建 | request、locator、intent latest 与首次 LSN 顺序键均由同一日志投影；list 按首次 record 顺序稳定分页且不扫全历史，坏尾/索引丢失或损坏可重建并与日志全等。 | 单一 reducer 同步维护 intent latest、locator、request 摘要及 `order:<conversation>:<firstLsn>`；list 仅分页扫描该会话 order 前缀并点读 latest，不扫 AuthorityCommitLog。`recover/rebuild` 复用 DurableProjectionIndex 的 checkpoint/manifest 与坏尾恢复，repository 重开测试对账顺序与 latest 状态。 |
| IR31-09 | [x] | list、discard 与本地域终态 | list 返回当前会话 latest-wins 全集；discard 只把 pending 原子变为 discarded、重复幂等、相反终态拒绝、零全局副作用；本地域 confirmed 必须拒绝并引导锚点 review。 | list 继续读取 current-owner 的 latest-wins 投影；fresh discard 在 journal 同锁事务内重读 intent 与会话 delete，删除胜出零追加，discard 胜出形成唯一终态。重复 discard 先返回、相反终态与本地 confirmed 拒绝，未引入任何全局写副作用。 |
| IR31-10 | [x] | rubric 资产依赖闭包 | save/update 的内容必须先以规范正文进入既有 ArtifactStore，并在 intent 提交/确认时作为 candidate reference；缺失、损坏、metadata/content 不全等、写失败和 GC/重建边界不得产生可确认 intent 或悬空全局记录。 | journal 事务通过原 `candidateReferences` 把 rubric ArtifactRef 继续纳入同一提交闭包；anchor 确认仍重读并反绑 metadata/content，缺失或损坏不得确认。会话 guard 前已写但未引用的 CAS 内容不是可见业务事实，沿既有 GC 边界回收；未扩建跨存储事务，当前正确性与架构均闭合。 |
| IR31-11 | [x] | schedule 四种完整写 | 本地域 producer 只接收四种完整 `ScheduleWriteMutation`；create/update 携完整 spec，update/set-state/delete 携 taskId 与 CAS revision，全部 timeSensitive，成功只返回稳定 intentId 与“尚未生效、需确认”。 | `DeferredScheduleIntentProducer` 的输入即封闭 ScheduleWriteMutation；调用前再以 timeSensitive=true 严校验，随后只转交唯一 intent port。四分支测试核对完整 spec/taskId/revision、稳定 requestId、deferred intentId 与固定“尚未生效、需确认”文案。 |
| IR31-12 | [x] | schedule 负向能力闭包 | producer 不暴露 list/run/abort，不读取或合成全局任务、不触达 AnchorScheduler/GlobalState/job/delivery/staged publish；不完整 mutation、登记失败或无锚点不能显示已生效或成功。 | 类仅持 DeferredGlobalIntentPort，公开面只有 `record`，生产调用图无 scheduler/global/job/delivery/staged 依赖；本地域 port 也仅暴露 defer/list/discard。缺 revision/不完整 update 在 port 前拒绝，repository 失败向上传播，零“已生效”结果；生产 conformance 核对 task/job 流计数不变。 |
| IR31-13 | [x] | rubric 采用与沉淀分离 | local-draft 契约快照先独立进入 SessionState 并立即用于当前任务；仅 save-own/update-own 产生意向，沉淀失败不得回滚已采用快照，也不得把 adopted 冒充 globally saved。 | AdvancementController 先 await `store.confirmRubric` 形成 local-draft snapshot，再异步启动 publication task；publication 失败仅返回“任务已继续执行、暂未保存”，不回滚 SessionState。local 组合根只注入 DeferredRubricPublication，联合只可能构造 save-own/update-own。 |
| IR31-14 | [x] | rubric save/update 准备 | save-new 不依赖目录命中并生成完整 save-own；update-existing 必须反绑只读 cache 中 rubricId+expectedRevision，过期/缺失/错 identity 拒绝；archive 永不可构造。 | `prepareDeferredRubricMutation` 对 save-new 直接投影/解析并生成 save-own；update-existing 先从只读 execution catalog 加载目标、解析 revision，再要求投影 document id 全等目标后生成 update-own。缺/坏 revision、缺目标与身份变化均拒绝，类型与 validator 无 archive 分支；requestId 反绑 draft+choice+target。 |
| IR31-15 | [x] | rubric 发布恢复与产品终态 | 准备、资产或 intent 写失败不得伪装保存；exact replay/响应丢失/重启不重复意向；成功文案明确“已用于本任务，连接值班设备后保存”，不泄漏内部术语。 | publisher 的 prepare→asset→record 顺序与固定 deferred 文案未变；repository matching replay 现经同一 journal 事务返回原 intent，响应丢失/重启仍不重复。身份/delete guard 的新增拒绝只进入既有可行动失败分支，不回滚已采用快照，也不泄漏 intent/anchor/stream 等内部术语。 |
| IR31-16 | [x] | 锚点 locator 与 current owner | anchor review 必须先由耐久 locator 取得 conversation，再以 current-owner guard 通过后读取完整 intent/资产/全局状态；未知、错流、未导入、非当前 owner 零信息泄漏与零全局副作用。 | review/decide 均先点读耐久 locator，仅取得 conversationId，再调用注入的 current-owner predicate，成功后才 locate 完整 intent；locator 缺失、非当前 owner 测试均在 mutation/资产/global projection 读取前拒绝。第 32 单元可替换该 predicate，当前未实现 transfer。 |
| IR31-17 | [x] | review principal 与时效再确认 | schedule 恒只接受 authenticated surface 确认，host/伪 surface 不得代替；非时效 rubric 可由有限 host/surface review；discard 无需全局写且两族都遵循同一 owner fence。 | admission 先执行 principal×method；confirmed 分支再强制 timeSensitive 仅 surface，rubric 仅 host/surface，并由 context 生成不可带 ingress 的 TrustedControlSource。schedule host 反例、rubric host 正例已覆盖；discard 在全局 envelope 前走 repository，保持同一 owner fence 和零全局记录。 |
| IR31-18 | [x] | 全局重校验、CAS 与冲突 | 确认时必须从同一锁内权威前缀重新校验当前 intent、schedule/rubric validator、revision/CAS、资产与 global projection；冲突或暂态失败保持 pending 且零部分效果；本单元 internal-only seam 不承担公开产品错误合同。 | 同锁前缀重校验、CAS/资产拒绝与 pending/零部分效果成立。冻结的 `DeferredGlobalIntentPort.decide` 返回 `Promise<void>`，anchor review 也没有 CLI/RPC/channel consumer；现在新增产品结果联合会提前决定第 32 单元的公开收编体验。稳定产品码、可行动说明与内部术语净化已明确转入第 32 单元公开旅程，不作为第 31 单元门禁。 |
| IR31-19 | [x] | 原子 global+control+confirmed | 同一 AuthorityCommitLog 事务必须一次提交全局 schedule/rubric 记录、control applied 结果与 intent confirmed；禁止先 mutate 全局再补 intent，任何 fsync 边界均不得出现全局效果与 confirmed 分离。 | review service 只返回一个 AtomicControlApplicationPlan：authorityEntries 同含 prepared task/rubric records 与 confirmed intent，ControlAdmission 同批补 control applied；companion streams/readProjectionIds/candidateReferences 均声明于同一 `transactProjectionPrefix`。两族测试按同一 CommitEnvelope 查到三类记录，无先行 GlobalState mutate。 |
| IR31-20 | [x] | 决定重放与派生物化 | intentId+mutation digest 派生稳定 control request；同决定 exact replay 零追加，反向决定拒绝，响应丢失/连续重启不重复全局权威效果；schedule 派生 refresh 失败不得改变已提交事实且可重驱。 | 首次 confirmed 与 terminal same-decision 现统一调用 `#materializeConfirmedSchedule`，由冻结 intent 重建同一 requestId、taskId 与目标 revision（create=1，其余原 revision+1）。refresh 效果前/后失败均保留耐久 pending 并拒绝返回；同进程重试或启动恢复可追平。materialized 只清不晚于该目标的 pending，旧 replay 不清较新目标且不重复 task revision。 |
| IR31-21 | [x] | control admission 与全局 reducer 接缝 | `global-write` envelope/result 必须严格校验、无 ingress 伪造，async decide、companion streams 与 readProjectionIds 只放行声明闭包；schedule/rubric durable projection 和 request replay 与既有在线 GlobalState 语义一致。 | 复审 control codec、admission 与 coordinator：global-write 严格联合、无 ingress source、companion streams/readProjectionIds 和原子 authority entries 均未放宽。新增 conversation identity 投影只由同日志 `session-create received→applied ok` 派生并只读参与 intent guard；schedule 重驱复用既有 pending/materializer，未增加权威写面。 |
| IR31-22 | [x] | 本地域单一 repository 装配 | 每个 local assembly 恰一 repository，schedule producer、rubric publication、list/discard 共用同一实例和 executor log；启动先 recover 投影，两个生产根不得重复实例或建立第二事实源。 | LocalConversationOwnerAssembly 仍只构造一个 local repository，并新增同一 ownerEpoch 与 `protocol.deferredIntentAuthority` 显式反绑；schedule、rubric、list/discard 继续共用该实例和 executor log。启动顺序仍先恢复投影；两真实生产 profile 的 ensureSession→record/list/replay/discard 直接装配证据通过，未出现第二 repository。 |
| IR31-23 | [x] | 锚点单一 review 装配 | 每个 anchor-enabled 生产拓扑恰一 anchor-mode repository/review service，复用 control admission、global coordinator、rubric authority 和当前 protocol owner；anchor record 恒不可达，不适用角色零装配。 | AnchorSchedulerRuntime 仍恰一 anchor-mode repository/review，新增 anchorEpoch 与当前 protocol journal authority 的窄绑定；authorityLog、control admission、coordinator、rubric authority 均复用原实例。anchor record 仍由 mode 拒绝，非 anchor topology 无该 runtime；未引入 transfer 或公开 consumer。 |
| IR31-24 | [x] | topology 与角色 exact-set | 对 `planServeTopology` 八种配置及 anchor+executor、executor-only 两生产根核对 local repository、anchor review、shared producers 和 cleanup/lifecycle 的恰一/零集合；同机双角色不得串域。 | 既有八配置表精确判定 local owner 位于 access-surfaces、executor-role 或 none，并反绑 cleanup owner；S7 再证明每个 local assembly 单 repository/双 producer、每个 anchor runtime 单 review。anchor+executor 使用分离 authorityLog/executorLog，同机仅 local 端可 record；surface 等价配置不改变集合。 |
| IR31-25 | [x] | internal-only 端口与公开零入口 | local internal port 只暴露 defer/list/discard 窄能力并经统一 lifecycle gate；anchor review 只供第 32 单元注入，不得注册 CLI/RPC/channel/status/tool 或把 raw repository/GlobalState 暴露给 surface。 | 公开 port 形态未扩写：local 仍仅 defer/list/discard 且全部经过统一 lifecycle gate；新 authority 适配器冻结为 protocol 内部单方法事务能力，raw journal/repository/GlobalState 均不逸出。生产引用与 staged diff 未出现 CLI/RPC/channel/tool/status 注册，anchor review 仍为 internal seam。 |
| IR31-26 | [x] | S7 结构门禁与能力隔离 | 现有单一 S7 gate 必须机械证明 local/anchor 各一 repository、producer 共用实例、mode 正确、公开零暴露，并继续拒绝 GlobalState/global participant/delivery/其它 Store；真实变异应 fail-closed，合法两根零误杀。 | 现有单一 S7 gate 已扩展为核对 local/anchor repository 的 ownerEpoch、conversationAuthority 及 protocol 窄适配器，保留 mode、计数、共享 producer、公开零暴露和禁用能力检查。直接变异覆盖缺失/替换绑定与 adapter 漂移，15/15+golden 证明合法两根零误杀；未新增 lint 或通用调用图。 |
| IR31-27 | [x] | 第 32 单元 transfer 接缝 | intent 流必须被明确分类为 conversation-owned、locator/最新状态/资产可由收编直接消费，localDomainId 保留来源身份；本单元不得实现 transfer 流、freeze/import/current-owner 切换或公开 adopt。 | `intent:<conversationId>`、localDomainId、latest/locator/order 与 ArtifactRef 合同保持不变；新增 guard 只消费当前 journal ownerEpoch，不实现 epoch 切换。代码与文档 diff 均无 AuthorityTransfer、freeze/import/commit/tombstone、current-owner switch 或公开 adopt，anchor current-owner predicate 仍留作第 32 单元接缝。 |
| IR31-28 | [x] | 双生产根 conformance 与恢复 | 证据须按生产交界风险成比例：两 local profile 真实穿过 assembly 的 record/list/discard/replay/restart，anchor review、rubric/资产/CAS 与物化故障由直接生产服务测试覆盖；发现的生产交界缺陷必须并入对应根因验收，不复制组件矩阵或建设通用 fixture。 | 当前证据按失效边界闭合：两真实生产 profile 2/2 覆盖普通 control identity 与 local repository；owner-kernel 13/13 直接覆盖同日志 delete 竞争及四 schedule mutation 的 pending 故障；S7 15/15+golden 覆盖结构装配，workspace build 17/17 覆盖可消费性。没有只能由新共享 runner 发现的独立生产差异，EX31-01 重开条件不成立。 |
| IR31-29 | [x] | 安全、拒绝零副作用与并发 | 非法 identifier/date/revision/字段、错 principal/owner/stream、过期 deadline、并发 record/decide 与资产缺件均在首个权威日志或全局副作用前拒绝；对外结果不得回显 ArtifactStore 物理路径、内部 stream/projection 或权限身份。 | 静态 validator、principal/domain/deadline 与资产检查保持 fail-closed；动态 delete/record/discard 竞态现由同一 journal/log prefix 唯一排序，失败零 intent 追加。ownerEpoch/identity 投影仅为内部判定，不进入返回值；ArtifactStore 路径、stream/projection 与权限身份均无公开 consumer，Unit32 的产品错误映射未提前实现。 |
| IR31-30 | [x] | 有限产品输出与可行动反馈 | 本单元只核对 schedule producer 的 deferred 结果、既有 rubric publication 消费文案及 anchor internal review 的真实终态：响应丢失或重启后不改口，不得把尚未完成的派生效果报告为已完成。公开冲突语言和可行动选择归第 32 单元。 | schedule/rubric 的“已记录、尚未生效”文案未变；anchor internal decide 只有 materializer 已达到原 target 才返回 confirmed，效果前/后失败与响应丢失均拒绝并保留 pending，same-decision 重试继续追平。由此内部终态与 scheduler 实际效果一致；公开冲突语言仍明确留给第 32 单元。 |
| IR31-31 | [x] | 架构、规格与模块文档同步 | 总纲 §9/§14、规格 §3.2b/§15、scheduler 当前段与 rubric 采用/沉淀分界必须与现行类型和生产调用图一致；历史段保持非现行，第 32 单元能力不得被写成已交付。 | 总纲 §9/§14、规格 §3.2b/§15、scheduler 当前段和 rubric 采用/沉淀段已与实现全等：conversation journal 窄事务固定 replay→identity/delete/epoch→append，confirmed 首次/终态 replay 共用 pending materializer。历史段未升级，transfer/current-owner/公开复核仍归第 32 单元。 |
| IR31-32 | [x] | 有限上游兼容与包边界 | 只核对本轮直接触及的有限集合：在线 schedule/rubric authority mutate/replay、advancement active snapshot 与 C18 save/update 选择、S7 canonical-evidence-only 边界、SessionState、DurableProjectionIndex manifest/checkpoint 序列化及 S7 单一 lint 入口；新增 intent 不得使这些分叉或回退。包依赖保持无环，exports 只暴露冻结合同。 | 在线 schedule/rubric planner 与 authority reducer仍被直接复用，active snapshot/C18 save-update、SessionState、DurableProjectionIndex 与 canonical-evidence-only 均未分叉。新窄 authority 类型只沿 owner-kernel→cli 暴露，core→owner-kernel→owner-services→cli 依赖仍无环；S7 保持单一入口，17/17 workspace build 证明当前导出可消费。 |
| IR31-33 | [x] | 开发义务、条款与路径反向闭包 | D31-01～D31-06、全部适用来源条款、34 个功能路径与 IR31-01～IR31-32 必须双向全等：每项有生产端、消费端、装配、异常/恢复和直接证据落点，每条实现有当前架构依据；不得遗漏、重复或把测试存在当功能通过。 | D31-01～D31-06、适用条款、34 个功能路径及 IR31-01～IR31-32 已重新双向对账。U31-01 闭合 D31-02 的会话身份/delete 线性化，U31-02 闭合 D31-05 的同进程物化重驱；生产、消费、装配、异常/恢复和成比例证据均有落点。EX31-01 未重开，第 32 单元义务未提前，零未处置反证。 |

> 本清单只定义第 31 单元独立审查范围和证据要求；本轮 21 个输入变化项已全部复审通过，连同直接复用的 12 项，当前 33 项 `[x]`、零 `[ ]`、零 `[~]`、零 `[!]`。

---

## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 工作量评估 | 问题评级 | 相关审查项 |
| ---- | -------- | ---------- | ---------- | -------- | ---------- |

### 已删除问题的价值裁决记录（非待处理问题）

| 原编号 | 原结论 | 推翻或收窄事实 | 新决定与重开条件 |
| ------ | ------ | -------------- | ---------------- |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| ---- | -------- | ---------- | ------------ | ---------- | -------- |


