## 审查清单

### 当前状态

- **当前单元**：第 27 单元 · generation 1
- **架构来源**：分布式运行时总纲与可执行规格；任务推进闭环架构与 Rubric 协议；运行体生命周期、对话/接入面、确认交互、注意力窗口与 workscene 直接上下游合同；持续在线/本地执行与 S2 安全供应链约束；第 14、15A、15B、18、20、23、25、26 单元冻结合同、适用排除项与迟发现教训；第 27 单元定稿开发清单
- **交付基线**：HEAD `d4cce198` 至当前完整工作区的 93 个非工作台路径，删除 0；CLI 23、core 25、executor 3、orchestrator 11、owner-kernel 10、owner-services 9、rpc 1、server 9、架构与规格 2
- **交付指纹**：`git-delivery-manifest-v1:eb1b74f9aee0d8deda2c8454e8b204d52616069f070ec828544c47c190e57dda`；路径集 SHA-256 为 `354d171394b4ac464a6c8b284ecf037a4e0518e92a244d2f59d781910e95b600`；指纹只作范围证据，不建立为审查项
- **目标提交边界**：第 27 单元（S7）advancement 与独立取证的生产实现、直接相关测试，以及同步修订的推进架构与分布式运行时规格
- **当前任务进度**：100%（45 / 45 项完成；45 项 [x]、0 项 [~]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：独立审查通过。U27-01～U27-09 已在正式文件中更新为“已验证”；最终验证补齐 `advancement-event` 的真实生产行为矩阵并同步结构 golden 后，IR27-37、IR27-41 与跨项闭包已在当前指纹复审通过，其余 43 项输入未变化并继续复用。45 项全部为 `[x]`，P0/P1 与非阻断临时问题列表均为空。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| --- | --- | --- |
| distributed-runtime-charter.md 当前版本交付原则、背景 | 适用 | 最小完整产品、持续在线、本地真实执行、单机/分布式平权与优秀产品体验归入 IR27-01、IR27-28～IR27-32、IR27-35～IR27-40。 |
| distributed-runtime-charter.md §1～§3 | 适用 | 锚点与 conversation owner 权威、executor 完整运行体、owner-services/owner-kernel/orchestrator/CLI 包边界归入 IR27-04～IR27-05、IR27-08、IR27-28～IR27-30、IR27-37。 |
| distributed-runtime-charter.md §4 | 部分适用 | 设备身份、签名凭证、SecretStore 和短租约适用于取证信封与 mesh，归入 IR27-02、IR27-13～IR27-19、IR27-23、IR27-34；本单元不改变配对、信任链和密码学选型。 |
| distributed-runtime-charter.md §5～§6 | 适用 | advancement 会话状态随 conversation owner、Rubric 库归锚点、证据资产与控制/数据流单源归入 IR27-04～IR27-05、IR27-15～IR27-27、IR27-33～IR27-36。 |
| distributed-runtime-charter.md §7 | 适用 | EvidenceRequest/Bundle、ObservationToken、PathGuard、workspace revision、独立 provider 与 review 子租约全部归入 IR27-13～IR27-25、IR27-33～IR27-35。 |
| distributed-runtime-charter.md §8 | 部分适用 | owner 控制与 executor 只读取证、local/mesh 只换 transport 不换语义归入 IR27-15～IR27-25、IR27-30、IR27-34；run stream、渠道确认与 job relay 不因本单元重开。 |
| distributed-runtime-charter.md §9 | 部分适用 | local-draft 立即生效、全局 Rubric 沉淀延后合同适用，归入 IR27-26～IR27-27、IR27-32；本地域 owner、DeferredGlobalIntent 耐久流、收编与 AuthorityTransfer 由第 30～32 单元承载，IR27-01、IR27-36 防止提前启用。 |
| distributed-runtime-charter.md §10 | 部分适用 | owner/executor 角色启动、恢复、停机与未启用角色零副作用归入 IR27-28～IR27-31、IR27-33；托管、升级和发布由第 36～38 单元承载。 |
| distributed-runtime-charter.md §11 | 适用 | 用户只感知任务、确认、推进、缺口和收场，不暴露拓扑/租约/绑定术语，归入 IR27-06～IR27-12、IR27-26～IR27-27、IR27-32、IR27-38～IR27-40。 |
| distributed-runtime-charter.md §12 故障矩阵 | 部分适用 | owner/executor 崩溃、响应丢失、重复/迟到、旧 epoch、断网重连、日志坏尾、磁盘满、版本/能力漂移、停机竞争归入 IR27-04、IR27-09～IR27-25、IR27-30～IR27-35；AuthorityTransfer、锚点永久丢失与 S9 恢复行不适用。 |
| distributed-runtime-charter.md §12 安全对抗矩阵 | 部分适用 | 伪签、错 scope/audience/ownerEpoch/executor/workspace/review/run、过期、重放、PathGuard、权限/资源凭证不可替代及原始 surface 确认归入 IR27-05、IR27-07、IR27-13～IR27-25、IR27-32、IR27-34；配对短码、MITM 与渠道 token 不因本单元重开。 |
| distributed-runtime-charter.md §13 不变量 1～18 | 部分适用 | 1→IR27-04/05/28/41；2→IR27-09/36；3→IR27-18/30/34；4→IR27-26/27；5→IR27-28～30；6→IR27-23/34；7→IR27-16/18/20～23/34；8 由第 30～35 单元承载且归 IR27-01/36 排除；9→IR27-10/12/17/33；10→IR27-04/12/17/19/33/41；11→IR27-02/13～18/23/34；12→IR27-28～30/36；13→IR27-11/32/40；14→IR27-28～30/37；15→IR27-09/36；16→IR27-07/10/32/34/40；17→IR27-05/28/32/37～40；18→IR27-13/14/35。 |
| distributed-runtime-charter.md §14 | 适用 | S7 第 27 单元依赖顺序、前置冻结能力和后继不得提前开放归入 IR27-01、IR27-28～IR27-31、IR27-36～IR27-37。 |
| distributed-runtime-charter.md §15 | 部分适用 | 结构、适用故障/安全和推进产品体验验收归入 IR27-32～IR27-41；本单元没有量化 benchmark 或性能采集门禁，IR27-01、IR27-35、IR27-37 防止引入非必要设施。 |
| specification.md §1 | 适用 | EvidenceRequest/Bundle/ObservationToken、AdvancementAdmissionDecision/Draft/Review/Proxy/Attribution、AdvancementControlEvent/Snapshot、Rubric source、规范字节、摘要域、签名和错误形态归入 IR27-02～IR27-03、IR27-15、IR27-18～IR27-24、IR27-34、IR27-38～IR27-41。 |
| specification.md §2 | 部分适用 | owner/evidence principal、短租约、ResourceLease 与签名验证适用，归入 IR27-05、IR27-13～IR27-19、IR27-23、IR27-34；配对、SecretStore 迁移和 mesh bootstrap 不改。 |
| specification.md §3.1 | 适用 | SessionStatePort 的 readAdvancementState 与 advancement-event 写、AuthorityCallContext 和 host-only guard 归入 IR27-04～IR27-05、IR27-12、IR27-28、IR27-41。 |
| specification.md §3.2 | 部分适用 | Rubric asset index、rubric save/update、ArtifactRef 与 GlobalState guard 适用，归入 IR27-26～IR27-27、IR27-34；其他全局资产写不在本单元。 |
| specification.md §3.2b | 部分适用 | 本单元只消费 DeferredGlobalIntentPort 合同 fake 并验证离线提示，归入 IR27-27、IR27-32；intent 流、生产本地域装配、收编和重校验由第 30～32 单元实现。 |
| specification.md §3.3 | 适用 | EnvironmentPort、CapabilityDescriptor.evidenceCapabilities、workspace binding/revision 与无 workspace 语义归入 IR27-16、IR27-18、IR27-20～IR27-23、IR27-29、IR27-34。 |
| specification.md §3.4～§3.4b | 适用 | advancement control 根、evidence 子租约、UsageReport/intake 与 workload-advancement 物理 permit 归入 IR27-13～IR27-14、IR27-18～IR27-19、IR27-29、IR27-35。 |
| specification.md §3.5 | 适用 | ControlCompletionPort 与完整领域输入的 AdvancementReviewerPort、reviewer 不写权威状态归入 IR27-08、IR27-13、IR27-28。 |
| specification.md §3.6～§3.7 | 部分适用 | 被审 accepted run、run 所有权、资源水位与 existing submission 事实作为 review 输入归入 IR27-09、IR27-13～IR27-17、IR27-24、IR27-36；本单元不改变普通 run 派发/提交协议。 |
| specification.md §3.8 | 适用 | advancement-event 仅 host、rubric 全局写的 principal/revision 守卫归入 IR27-05、IR27-27、IR27-34。 |
| specification.md §4.1～§4.2 | 适用 | advancement 逻辑流、单一 AuthorityCommitLog、ArtifactStore 先内容后引用、可重建投影与内容可见性归入 IR27-04、IR27-12、IR27-17、IR27-19、IR27-26～IR27-27、IR27-33～IR27-35。 |
| specification.md §4.3 | 适用 | AdvancementStoreEvent 十五分支、evidence_requested/result/settled、被审 RunRecord 与会话删除分类归入 IR27-04～IR27-12、IR27-15、IR27-17、IR27-24、IR27-33、IR27-36、IR27-41。 |
| specification.md §4.4～§4.5 | 部分适用 | advancement 原子复合状态、投影恢复、归因随 review/proxy 耐久、证据 journal 终态保留和 pending 不回收归入 IR27-04、IR27-09～IR27-12、IR27-17、IR27-19、IR27-33、IR27-35、IR27-39、IR27-41；普通 staged publish 不改。 |
| specification.md §5.1 | 部分适用 | first-party 任务准入、advancement invocation、requestId/ingress、原 turn/draft 身份与取消交界归入 IR27-06～IR27-10、IR27-32、IR27-36、IR27-40；scheduler/job 控制入口不改。 |
| specification.md §5.2～§5.6 | 部分适用 | accepted run、每 run 验收条件瞬态注入、source/ingress 所有权、取消/terminal、stream/final 只作推进 review、proxy 和恢复输入，归入 IR27-09～IR27-12、IR27-24、IR27-33、IR27-36、IR27-38～IR27-40；assignment/job 数据面合同不重做。 |
| specification.md §5.7 | 适用 | EvidenceRequest/ObservationToken/EvidenceBundle 全字段、executor journal、stale≤2 与 capability-gap 归入 IR27-02、IR27-14～IR27-25、IR27-33～IR27-35。 |
| specification.md §6.1 | 部分适用 | conversation accepted/committed/cancelled/failed/expired 与响应丢失只作为推进触发、代理收束和恢复交界，归入 IR27-09～IR27-12、IR27-33、IR27-36；36 行状态机不被本单元重写。 |
| specification.md §6.2～§6.2b | 不适用 | user/system job 状态机由第 26 单元完成，本单元不让 advancement 或 evidence 复用 job/assignment 入口；IR27-18、IR27-29、IR27-36 证明隔离。 |
| specification.md §6.3 | 不适用 | AuthorityTransfer 的生产实现由第 32～35 单元承载；本单元只把 advancement 流登记为随会话转移分类，归入 IR27-04、IR27-36。 |
| specification.md §6.4 | 部分适用 | 结果不明不得自动重执行与 typed capability-gap 诚实呈现适用，归入 IR27-09～IR27-12、IR27-17、IR27-25、IR27-32；设备迁居裁决不适用。 |
| specification.md §7 | 适用 | 会话删除连带 advancement、advancement 随 owner、Rubric 全局权威、evidence executor 本地事实归入 IR27-04、IR27-12、IR27-16、IR27-26～IR27-27、IR27-36。 |
| specification.md §8 | 适用 | 推进确认/修订/取消/详情、owner Completion/Reviewer 与取证落点归入 IR27-06～IR27-12、IR27-15～IR27-32、IR27-38～IR27-40。 |
| specification.md §9 | 适用 | 锚点域/未来本地域 advancement 等价、local-draft 立即生效和全局沉淀延后归入 IR27-26～IR27-32、IR27-36；本单元不开放离线本地域生产。 |
| specification.md §10 | 适用 | advancement/control/evidence 的租约层级、公平准入、settle/release、intake 与设备 permit 归入 IR27-13～IR27-14、IR27-18～IR27-19、IR27-29、IR27-35。 |
| specification.md §11 | 部分适用 | 推进确认、进度、缺证据、目标离线、deferred、接管和收场产品语言归入 IR27-06～IR27-12、IR27-25～IR27-27、IR27-32、IR27-39～IR27-40；配对、迁居与恢复旅程不适用。 |
| specification.md §12 | 部分适用 | 十八条机械口径按 charter §13 映射；本单元新增 codec/record/provider/adapter/guard 的真实 producer、拒绝零副作用、reopen/recovery 和拓扑证据归入 IR27-02～IR27-05、IR27-13～IR27-25、IR27-28～IR27-41；无关 job/transfer 行不重跑。 |
| specification.md §13 | 适用 | task-advancement-rubric-architecture.md 与本规格的同步、公开合同和下游一致性归入 IR27-37。 |
| specification.md §14 | 不适用 | S1 开工基线已经完成，不形成第 27 单元新增义务；包边界回归由 IR27-28、IR27-37 承载。 |
| specification.md §15 | 部分适用 | 第 27 项全部目标/验收归入 IR27-01～IR27-45；第 15A、15B、18、20、23、25、26 项作前置回归，第 28～38 项明确排除。 |
| always-online-and-local-execution-requirements.md §1 | 适用 | “持续在线且进入真实工作环境”的核心问题是本模块产品目标，归入 IR27-01、IR27-16、IR27-28～IR27-32。 |
| always-online-and-local-execution-requirements.md §2 | 不适用 | 本章明示为未经核实的第三方回复整理，不构成项目事实、架构要求或提交门禁。 |
| always-online-and-local-execution-requirements.md §3 | 不适用 | OpenClaw 外部现状核验仅为调研事实，不规定知行第 27 单元交付；本单元不得据此增加竞品对齐事项。 |
| always-online-and-local-execution-requirements.md §4 | 不适用 | 架构者对竞品机制的复核用于否定外部推断，不是独立规范来源；知行的正式义务已由总纲与规格承载。 |
| always-online-and-local-execution-requirements.md §5 | 不适用 | 本章是竞品能力现状归纳，不产生第 27 单元实现或审查义务。 |
| always-online-and-local-execution-requirements.md §6 | 部分适用 | 单机与常驻锚点两种形态平权、本机接入不绕远端及既有业务需求保持不变，归入 IR27-28～IR27-32、IR27-36；未来桌面客户端不在本单元。 |
| always-online-and-local-execution-requirements.md §7 | 部分适用 | 智能体持续在线、环境任务诚实等待且恢复、单机用户不承担分布式代价归入 IR27-16～IR27-17、IR27-25、IR27-28～IR27-32；普通提醒/定时/通知能力不因本单元重开。 |
| s2-security-supply-chain-review.md 裁决、强制门禁、接受依据 | 部分适用 | 既有受管安全依赖、精确锁版与零旁路规则归入 IR27-34、IR27-37；当前 93 路径不含依赖或锁文件变化，不重开库选型与供应链建设。 |
| task-advancement-rubric-architecture.md 需求区、§0～§3 | 适用 | 任务/问题边界、球员/裁判隔离、一次确认、标准公开/程序私有/验证独立、结构化归因、独立窗口、owner 拓扑和范围归入 IR27-01、IR27-06～IR27-08、IR27-28、IR27-32、IR27-38～IR27-40。 |
| task-advancement-rubric-architecture.md §4.1～§4.7 | 适用 | admission/session/draft/confirmed/review/proxy/归因/权威事件模型逐项归入 IR27-02～IR27-12、IR27-24～IR27-27、IR27-39、IR27-41。 |
| task-advancement-rubric-architecture.md §5.1～§5.6 | 适用 | 用户输入、契约确认、run 瞬态契约注入、accepted 后 review、代理续推与中间态恢复逐项归入 IR27-06～IR27-12、IR27-15～IR27-17、IR27-24～IR27-25、IR27-31～IR27-33、IR27-38～IR27-40。 |
| task-advancement-rubric-architecture.md §6 | 适用 | 独立裁判、一级独立取证、canonical evidence、transient/结论性失败分流归入 IR27-08、IR27-15～IR27-25。二级执行测试/构建明确不适用，归 IR27-01、IR27-37。 |
| task-advancement-rubric-architecture.md §7 | 适用 | 完成、死胡同、风险/成本退出、用户接管、收场交付、逐条归因矩阵与契约再生归入 IR27-10～IR27-12、IR27-25、IR27-32、IR27-39～IR27-40。 |
| task-advancement-rubric-architecture.md §8 | 适用 | Rubric 全局资产、会话不可变快照、local-draft 与延后沉淀归入 IR27-03、IR27-26～IR27-27。 |
| task-advancement-rubric-architecture.md §9 | 适用 | 执行侧/推进侧窗口与 cache 隔离、run 注入不污染落盘原文/窗口/cache prefix、恢复折叠态不成为第二事实源归入 IR27-08～IR27-12、IR27-35～IR27-36、IR27-38。 |
| task-advancement-rubric-architecture.md §10 | 部分适用 | contract draft/confirmed/cancelled/failed→IR27-06～IR27-07/40；run reviewed/review deferred→IR27-09/25/40；proxy enqueued/recovered→IR27-10/12/39/40；completed/exited→IR27-11/39/40；recovery failed→IR27-12/31/40。确认重量与折叠层级、详情/归因、插话反馈、awaiting 恢复及零拓扑术语归 IR27-39～IR27-40；渠道里程碑批量是未来投影原则，本单元不实现、不形成门禁。 |
| task-advancement-rubric-architecture.md §11 | 适用 | core/orchestrator/owner-services/owner-kernel/server/CLI 唯一落点与禁止 ConversationManager 内嵌语义归入 IR27-28～IR27-30、IR27-37。 |
| task-advancement-rubric-architecture.md §12 | 部分适用 | 历史提交索引仅作现状溯源，不形成按提交号的验收；其揭示的现有功能由 IR27-06～IR27-12、IR27-32、IR27-36 回归。 |
| task-advancement-rubric-architecture.md §13 | 适用 | core/运行体/控制器/集成、事件结构闭包与产品旅程测试拓扑归入 IR27-02～IR27-12、IR27-15～IR27-32、IR27-37～IR27-41。 |
| task-advancement-rubric-architecture.md §14 不变量 1～17 | 适用 | 1→IR27-06/32/40；2→IR27-07/09/40；3→IR27-03/07/38；4→IR27-38/39；5→IR27-10/39/40；6→IR27-08/18/28；7→IR27-11/35/40；8→IR27-10/11/39；9→IR27-08/12/35/38；10→IR27-38；11→IR27-07/32/40；12→IR27-06/32；13→IR27-15～IR27-25；14→IR27-06/07/10/40；15→IR27-38；16→IR27-08/12/13/25/33；17→IR27-03/06/26/27。 |
| task-advancement-rubric-architecture.md §15、C1～C18 | 部分适用 | C1→IR27-02/03/26/27；C2→IR27-07/32/40；C3→IR27-02/04/05/09/39/41；C4→IR27-06/07/38/40；C5→IR27-07/32/40；C6→IR27-08/13～25/39；C7→IR27-09～11/39/41；C8→IR27-10/12/39/40；C9→IR27-12/31～35/40；C10→IR27-15～25/29/30/33～35；C11→IR27-11/32/39/40；C12 的准入/会话投影→IR27-06/28/32，历史延迟观测不形成当前 benchmark/采集门禁；C13→IR27-04/12/37/41；C14→IR27-02/03/08/25/38/39；C15→IR27-06/26；C16→IR27-08～12/33/39；C17→IR27-07/11/39/40；C18→IR27-06/26/40。提交号和已完成轮次只是历史，不能代替当前证据。 |
| rubric-protocol.md §0～§2 | 适用 | Rubric 定位、场景复用、id/title/description/content 严格结构归入 IR27-03、IR27-06～IR27-07、IR27-26。 |
| rubric-protocol.md §3～§5 | 适用 | 通过标准、required/optional 证据、failureHandling 与变量格式归入 IR27-03、IR27-08、IR27-15、IR27-24～IR27-25、IR27-38～IR27-39。 |
| rubric-protocol.md §6～§7 | 适用 | 用户确认后的不可变运行契约、执行侧公开面和全局库归属归入 IR27-03、IR27-07～IR27-12、IR27-26～IR27-27、IR27-38。 |
| rubric-protocol.md §8～§9 | 适用 | 扩展字段、严格校验、非法 schema 和运行期消费归入 IR27-02～IR27-03、IR27-06～IR27-08、IR27-25～IR27-27。 |
| rubric-protocol.md §10 | 适用 | 不把 Rubric 做成 Skill/Rule/工作流、不过度建模任务类型与执行策略归入 IR27-01、IR27-03、IR27-37。 |
| unified-core-and-access-surfaces.md §1～§3 | 部分适用 | 单一 core/单一 conversation owner、接入面平权且只作薄入口、会话 RPC 双通道与 CLI/server 共用权威归入 IR27-04～IR27-05、IR27-28、IR27-30～IR27-32、IR27-37、IR27-40；通道 screen 同步、热插拔与通用宿主控制未被本单元修改，不形成门禁。§4 是既有实施计划，不新增规范义务。 |
| agent-runtime-lifecycle.md §1～§8、§10～§11 | 部分适用 | 装配期注册、`onBeforeRun.injectUserContext` 唯一 run 前入口、贡献式发送视图拼装、system/tools/cache 边界、主/工作运行体一致性及失败隔离归入 IR27-28、IR27-31、IR27-33、IR27-35、IR27-38、IR27-40；其他 hook 未被本单元改变。§9 的 skill 消费者、§12～附录的历史实施/开放项不属于本单元。 |
| transcript-persistence-and-attention-window-architecture.md §3.1～§3.2、§3.5 | 部分适用 | accepted run 先耐久、窗口只经 accept/reset 前进，以及注入只进入当前 run 发送视图、持久化与窗口用户消息恒为原文、不产生第二事实源归入 IR27-09、IR27-12、IR27-33、IR27-35、IR27-38；分片、GC、bootstrap、compact 与历史迁移实现未被本单元重开。其余章节为由来、落点和既有实施序列，不产生新增门禁。 |
| context-architecture.md §2、§5、§12、§15 | 部分适用 | 默认路径不增加额外 LLM 调用、CLI/server 同构、静态 cache prefix 不因每 run 注入漂移、动态贡献不落秘密且只进入合法发送视图归入 IR27-28、IR27-32、IR27-34～IR27-35、IR27-38；旧窗口驱逐、budget/compact、场景分类和未来工具增强已由后续窗口架构接管或未被本单元修改，不形成门禁。其余章节为既有上下文实现与历史 ADR。 |
| conversation-model.md §2～§5、§7～§9、§11～§12 | 部分适用 | Conversation 唯一事实源、任一对话至多一个 Session、turn 接受/持久化、CLI/server 生命周期、transcript 原文、恢复可见性和鉴权 RPC 投影归入 IR27-04～IR27-12、IR27-28、IR27-31～IR27-33、IR27-38～IR27-40；通道实现、scheduler/background、管理 CRUD 和历史实施路线未被本单元重开。§1/§14～§15 为术语/决策索引，适用结论已由上述章节承载。 |
| server-gateway.md §5～§6、§10 | 部分适用 | 已认证 JSON-RPC、conversation send/event 关联、入站只经 Conversation owner、同一 Agent Loop 与网络安全边界归入 IR27-05～IR27-12、IR27-28、IR27-31～IR27-32、IR27-34、IR27-37、IR27-40；通道 adapter、跨通道投递、OpenAI API、平台适配和路线图未被本单元重开。§1～§3、§11～§14 为定位、对比、历史规划与类型汇总，不新增第 27 单元义务。 |
| confirmation-ux.md §3～§8 | 部分适用 | advancement 确认复用既有选择/渲染基础设施时，须保持数据与渲染分离、稳定 requestId、串行 pending、重复决定幂等、取消/失联有确定结果且产品文案可理解，归入 IR27-07、IR27-32、IR27-34、IR27-40；SecurityPipeline 权限确认语义不被 Rubric 确认替代。竞品调研、未来 Web/渠道 renderer、smart 分诊和实施路线不适用。 |
| remote-confirmation-execution.md §0～§10 | 部分适用（仅隔离回归） | 当前 93 路径未修改 `ConfirmationBroker`、ConfirmationHub/Bridge、InboundRouter、TextConfirmationRenderer 或 channel challenge/grant；advancement 的 Rubric 控制确认只经 `SelectionService` 与 owner advancement 事件，不得复用或改变权限确认往返语义。该隔离由 IR27-28、IR27-37、IR27-40 判定，不重做远程权限确认功能。 |
| remote-interruption-execution.md §0～§8 | 部分适用 | 当前变更触及 conversation controller、session RPC、advancement user takeover/cancel 与停机交界，既有 turn 级 `abortSignal`、`session.abort`、pending 清理、唯一反馈及 `control > confirmation > agent-input` 优先级不得回归，归入 IR27-10、IR27-12、IR27-31～IR27-34、IR27-40；飞书 IntentClassifier、scheduler RunRegistry、卡片按钮和通道渲染未被本单元修改，不形成新增门禁。 |
| workscene-management-architecture.md 需求区、§0～§3、§6、§8～§10 | 部分适用 | workscene 恢复/切换的用户可见性、设备域 workspace binding、无 workspace 语义、CLI/RPC 同一领域服务及确认边界归入 IR27-16、IR27-18、IR27-20～IR27-23、IR27-29、IR27-32、IR27-34、IR27-40；真实路径模型已由第 25 单元 device/binding 合同取代。管理 CRUD、quiesce、智能创建和工具权限未被本单元重开。 |
| 第 14 单元 EX14-01、LD14-01～LD14-08 与冻结合同 | 部分适用 | EX14-01 的旧无 ingress `ControlRecord` 重开条件未出现；LD14-01～LD14-08 适用于本单元新增事件族、wire validator、状态量词、恢复义务和结构门禁，归入 IR27-02、IR27-04～IR27-05、IR27-12、IR27-17～IR27-19、IR27-24、IR27-33～IR27-36、IR27-41。 |
| 第 15A 单元 U15-X1～U15-X5、U15-L1～U15-L26 与冻结合同 | 部分适用 | 新增 advancement/evidence 生产日志、事件族和 owner/executor 路径使重放保留、外部副作用线性化、时间/数值边界、恢复依赖、epoch、通知、全 reducer、错误分类、容量、golden/RPC、投影与 runtime validator 检测动作适用，归入 IR27-02、IR27-04～IR27-05、IR27-09～IR27-12、IR27-17～IR27-19、IR27-24、IR27-31～IR27-37、IR27-41；与旧 scheduler 投递、已退役配置和无当前消费者的排除项须由 IR27-36 按原重开条件判定，不自动重开。 |
| 第 15B 单元 U15B-X1～U15B-X9、U15B-L1～U15B-L35 与冻结合同 | 部分适用 | advancement surface、确认、proxy ingress、run/review 恢复、owner/readiness、幂等身份、客户端投影、会话删除和结构门禁直接相交，归入 IR27-04～IR27-12、IR27-28、IR27-31～IR27-37、IR27-39～IR27-41；与 job delivery、channel interaction 或已退役显示物化且未命中重开条件的条目由 IR27-36 逐项写明不适用事实。 |
| 第 18 单元 X18-01～X18-02、L18-01～L18-12 与冻结合同 | 部分适用 | advancement control/evidence 新增资源方法、身份、重放/在线活性、双 governor、provider 治理、协议枚举、恢复消费者和 runtime validator，使相应检测动作归入 IR27-02、IR27-13～IR27-19、IR27-29、IR27-33～IR27-35、IR27-42；CLI 既有类型基线和第 28 单元 orchestration-node 子租约是否重开，须由 IR27-42 按原条件判定。 |
| 第 20 单元 X20-01～X20-12、L20-01～L20-09 与冻结合同 | 部分适用 | 新增 advancement evidence mesh、目标 workspace/device 选宿、local/mesh adapter、角色装配、服务授权和启动/停机，使相应检测动作归入 IR27-15～IR27-18、IR27-28～IR27-35、IR27-43；job 产品入口、其它数据面、issuer 迁居和既有工具链疑点是否重开，须由 IR27-43 按原条件判定。 |
| 第 23 单元 X23-01～X23-20、L23-01～L23-53、L23-53b、L23-54～L23-59 与冻结合同 | 部分适用 | 新增 evidence journal、ArtifactStore 引用、recovery maintenance、设备 permit、物理 I/O、local/mesh conformance、严格合同与故障注入，相关检测动作归入 IR27-02、IR27-14、IR27-17～IR27-24、IR27-28～IR27-35、IR27-37、IR27-41、IR27-44；surface asset、旧 WAL/迁移、本地域 owner 等未直接相交条目仍须由 IR27-44 按各自原重开条件写明不适用事实。 |
| 第 25 单元冻结合同（X/L 表为空） | 适用 | EnvironmentPort、PathGuard、workspace binding/revision、能力发布、无 workspace 与唯一交付指纹算法归入 IR27-16、IR27-18、IR27-20～IR27-23、IR27-29、IR27-34、IR27-37、IR27-45。 |
| 第 26 单元 X26-01 与冻结合同 | 适用 | executor-role-runtime 已进入当前 93 路径，X26-01 重开条件满足；credential projection/秘密扫描必须按当前变更重新归因，归入 IR27-23、IR27-29、IR27-34、IR27-37、IR27-45。scheduler/job 只作 accepted run、资源和停机交界回归。 |
| 第 27 单元定稿开发清单 D27-01～D27-11 | 适用 | D27-01→IR27-02/03/34/37；D27-02→IR27-04/05/12/17/33/41；D27-03→IR27-06/08/09/13/25/28；D27-04→IR27-13/14/18/19/29/33/35；D27-05→IR27-15/16/17/24/25/33；D27-06→IR27-18～23/29/30/34/35；D27-07→IR27-20～24/34；D27-08→IR27-24/25/39；D27-09→IR27-03/26/27/32；D27-10→IR27-28～31/33/37；D27-11→IR27-01/32/37～40。开发清单限定范围，不替代总纲、规格和当前交付物反向核查。 |
| 当前完整交付闭包 | 适用 | 93 个路径逐一归项：CLI 23→IR27-06～IR27-17/26～32/34～41；core 25→IR27-02～05/12～17/23～25/34～37/41～42；executor 3→IR27-13～14/29/33/35/41～42；orchestrator 11→IR27-08/18～23/29～31/34～39/41；owner-kernel 10→IR27-04～05/13～14/33～37/41～44；owner-services 9→IR27-05～17/24～28/31～39/41；rpc 1→IR27-32/34/36～37/40；server 9→IR27-04～17/28/31～33/36～41；文档 2→IR27-37。未归项路径或新增生产链无审查落点即为范围缺口。 |

### 审查项

| 编号 | 状态 | 审查分区 | 审查点与通过条件 | 证据 |
| --- | --- | --- | --- | --- |
| IR27-01 | [x] | 产品目标与单元边界 | 通过：93 路径均可反绑 D27-01～D27-11；未发现第 28～38 单元、二级取证、benchmark/性能采集、通用诊断或非必要 UI 进入生产交付。 | 当前 manifest 复算：93 路径、0 删除，分组和、路径集哈希与冻结指纹全等 |
| IR27-02 | [x] | 协议合同、codec 与摘要 | 通过：advancement 全事件由严格 codec 校验嵌套形状与 exact keys，review-attempt 的冻结 root/lease 形状、阶段与 evidence 请求均在 reducer 前复用同一 codec 与 batch guard；摘要、请求与结果引用绑定完整。 | 当前源码重建；`event-codec.ts`、`guards.ts`、`review-attempt-identity.ts` 及直接负例 |
| IR27-03 | [x] | Rubric 契约与严格校验 | 通过：生成、修订、库匹配和最终 seal 均复用同一 content-id 守卫，requirement/failureHandling 规范化碰撞在确认前 fail-closed，合法 `pc-N` 语义不变。 | 当前源码重建；`contract.ts` 及直接负例 |
| IR27-04 | [x] | advancement 唯一权威状态 | 通过：review-attempt 加入既有 `AdvancementControlEvent`，只经 conversation owner 的同一日志与 batch guard 提交；没有外部 raw-event 写入口、第二 reducer 或旁路状态面。 | 当前生产调用图；core/file store 与 `SessionAdvancementStore` 写入、重放和投影路径核对 |
| IR27-05 | [x] | 权威写守卫与绑定 | 通过：owner/revision fence、确认内容、review/run、proxy、review-attempt lineage/generation/root、evidence request/result/settlement 与 terminal 复合写均在 reducer 前完成有限身份反绑。 | 当前源码重建；`guards.ts`、`store.ts`、稳定 mutation identity 与响应丢失投影确认用例 |
| IR27-06 | [x] | 任务准入与草案生成 | 通过：能力目录按架构只声明稳定 provider kind，workspace/Git/locator 是请求级前提并以 typed capability-gap 诚实退出；以未预探测 Git 为由判阻断与冻结语义冲突。 | 已审 |
| IR27-07 | [x] | 一次确认、修订与取消 | 通过：确认同提交强制写入稳定 turn/surface/origin/摘要绑定的 admission intent；在线与恢复均 exact replay 既有耐久准入，暂态/结果不明保持 pending，只有确定拒绝取消。 | 当前源码重建；confirm RPC、original-task admission port 与恢复入口 |
| IR27-08 | [x] | ControlCompletion 与 Reviewer 边界 | 通过：控制生成/收场与 reviewer 端口分离，review 输入显式携 run/Rubric/history/window/canonical evidence/lease/abort；review-attempt 只由 owner controller 编排，owner-services 无 provider/拓扑反向依赖，reviewer 不写权威状态。 | 当前 controller、reviewer port 与 CLI 生产组合根重建 |
| IR27-09 | [x] | accepted run 验收线性化 | 通过：以原任务 admission 结清 runId 为下界，按全等 `RunRecordRef` oldest-first 查首个欠审 accepted run；同 run 进程内单飞，catch-up 未证明连续或补审未产生全等耐久 review 时均 fail-closed。 | 当前 `recovery-maintenance.ts`、controller 单飞键、CLI maintenance 与恢复回归核对 |
| IR27-10 | [x] | 代理续推与用户中断 | 通过：failed review 与 proxy 复合写、单 outstanding、durable claim 查询、用户输入分类/接管和既有 turn abort 链均复用现有 owner/run 语义；未见第二取消状态机或 sibling 误收束。 | 已审 |
| IR27-11 | [x] | 完成、退出与收场交付 | 通过：completed/exited 必须与同批全等 review 决定一致；review、可选 evidence consumed、attempt consumed 与 proxy/terminal 由同一 owner 批次提交，失败策略与归因反绑既有 failed review，当前生产入口零旁路。 | 当前 event codec、batch guard、controller 与两种 store 的复合写路径重建 |
| IR27-12 | [x] | 恢复状态全枚举 | 通过：确认准入、accepted 连续补审、坏会话隔离保持闭合；旧 terminal evidence、started/invoking、acquire 响应不明、review deferred/抛错/提交丢失、取消与 closed cleanup 均由耐久 attempt 代际确定收敛。 | 当前控制器状态推演；真实 governor+生产 reviewer 7 个崩溃/竞争用例及恢复维护回归 |
| IR27-13 | [x] | control/review 根租约 | 通过：每个全等 accepted run 先耐久 `started` 与冻结 root，`invoking` 先于 provider，review 与 `consumed` 同批；deferred/expired 先于 settle/release，terminal replay 分类不复活旧根。 | 当前 `controller.ts`、两侧 governor、`ImmediateRootReservationInspection` 与真实组合根用例重建 |
| IR27-14 | [x] | evidence 子租约与物理容量 | 通过：child 从签发到 dispatch 的所有权交接唯一；接管前构造/权威写异常即时 `finishLease`，接管后只由 dispatch finally 终结；carried terminal outcome 零复活旧 child，executor 仍使用独立 advancement I/O permit。 | 当前 `evidence.ts`、executor handler 与 carried terminal outcome 直接用例重建 |
| IR27-15 | [x] | 取证计划与耐久 requirement 映射 | 通过：有界 items 与去重 item→requirement 映射由同一规范 request 生成；codec/guard 校验索引范围、request/review/generation/digest 全等并只允许结果和结算指向当前 pending。 | 当前 producer、codec、guard 与 canonical evidence 派生路径重建 |
| IR27-16 | [x] | 目标选择、能力与环境 | 通过：目标由 accepted run 冻结 manifest 与签名 descriptor 解析；carried bundle/capability-gap 先于当前目标重算并冻结原 executor/ownerEpoch，fresh 请求才按当前 workspace/Git/locator 前提验真。 | 当前 `carriedOutcomeRootTarget`、`resolveTarget`、target-drift 负例与 `X27-01` 边界核对 |
| IR27-17 | [x] | owner 耐久请求与有限重试 | 通过：review-attempt 代际独立于 evidence child 代际并在任何 root acquire 前耐久；terminal evidence 可跨多代零 dispatch 复用，typed-stale 先结清再 fresh，review 未提交不再丢失下一代身份。 | 当前 owner 日志投影、稳定 mutation id、连续 deferred/提交崩溃恢复用例重建 |
| IR27-18 | [x] | executor 入口守卫与零读取拒绝 | 通过：验签、executor/lease/workspace/revision/provider/permit 均先于文件读取；当前单锚点唯一 owner 拓扑满足授权前提，未来 AuthorityTransfer 门禁已在全局第 32 单元规范，不越界前置。 | 当前生产组合根与 `X27-03` 重开条件核对 |
| IR27-19 | [x] | executor 幂等 journal | 通过：requestId+规范请求身份线性化，同键并发合流、重启/过期 exact replay、异载荷拒绝、pending 保留、终态 27 天索引与损坏 fail-closed 均由 journal 及直接测试承载；当前阻断在上游代际 identity 与 replay 授权顺序，不是 journal 语义。 | 已审 |
| IR27-20 | [x] | file-diff provider | 通过：provider 只在解析后的目标 workspace 执行只读 `git status --porcelain`，locator 进入 `-- paths`；无 locator 为当前全工作区事实，路径/digest 不符及 Git 不可用诚实降为 missing/capability-gap，不虚构历史快照。 | 已审 |
| IR27-21 | [x] | log/artifact provider | 通过：locator 先 canonical 判界再打开 canonical 文件；读取前后句柄 stat 与读后 realpath/stat 全等反绑，路径替换或内容变化只产出 typed-stale，未授权字节不进入 bundle。 | 当前源码与 handle-open 后 ABA 直接用例核对 |
| IR27-22 | [x] | ObservationToken 一致性 | 通过：多路径按请求顺序用 path/state/length/contentDigest 的 JCS 帧形成规范原始字节，pre/post 指纹无裸拼接歧义；单次读取身份或状态变化稳定归一为 stale。 | 当前源码与规范摘要公式核对 |
| IR27-23 | [x] | EvidenceBundle 真实性与隐私 | 通过：签名、requestDigest、executor、observation 与每项身份完整验真；文件字节绑定已授权句柄且 summary 有界脱敏，真实路径和秘密不上 wire。 | 当前 executor handler、bundle verifier 与安全负例核对 |
| IR27-24 | [x] | owner 验真与 canonical evidence | 通过：bundle 签名、requestDigest/executor/observation、请求 item 身份与 digestHint 在进入 reviewer 前校验；carried bundle 仍按原请求验真，stale 归一为 typed-stale，canonical id 只由原 requestId/itemIndex/requirementId 派生。 | 当前 `evidence.ts`、协议 validator、pending 映射 guard 与 carried outcome 用例重建 |
| IR27-25 | [x] | 裁判采信与通过判据 | 通过：工具 schema/运行时校验强制 criterion 全覆盖和 canonical evidenceId；passed 两层门不变，required 客观证据只认 independent+passed；transient/abort 先耐久 deferred attempt，结论性无工具提交 fail-closed，capability-gap 保持明确退出语义。 | 当前 reviewer 端口、controller outcome 分流、真实 metered reviewer 回归与既有判据核对 |
| IR27-26 | [x] | Rubric catalog 与会话采用 | 通过：catalog/ArtifactStore/GlobalStatePort 与 local-draft 原子采用成立；稳定 provider kind 在生成/确认时约束 required，请求级前提不满足走明确 capability-gap，不要求把动态 workspace 状态冻结进全局 Rubric。 | 已审 |
| IR27-27 | [x] | 全局沉淀与延后意向 | 通过：会话采用与全局 CAS 沉淀独立；publication task 在产生处把 rejection 收敛为 saved/deferred/failed，RPC 固定先耐久准入原任务、后反馈真实保存结果，失败不回滚 active/run。 | 当前 confirm controller 与 RPC 编排核对 |
| IR27-28 | [x] | owner 生产组合根 | 通过：serve 组合根唯一创建 controller/reviewer/evidence coordinator，并以 lazy authority governor 与 `SessionStatePort` 接入当前 conversation owner；review-attempt 检查端口沿同一 governor 代理注入，server/RPC/CLI 仍为薄入口和投影。 | 当前 `createServeAdvancementController`、command 装配、owner-services 依赖图与全仓生产构造点核对 |
| IR27-29 | [x] | executor 生产组合根与能力发布 | 通过：handler/journal/environment/capacity/local-mesh 组合未被 review-attempt 改写；签名 descriptor 仍只发布稳定 provider kind，具体 Git/workspace/locator 前提按请求解析，资源 governor 新检查面不建立第二取证入口。 | 当前 executor handler、access/executor-role 装配与 governor 合同交界核对 |
| IR27-30 | [x] | local/mesh adapter 等价 | 通过：local 与 mesh 仍最终进入同一 `ExecutorEvidenceHandler` 和 wire codec；mesh 只做 canonical transport/peer 授权/abort 透传，不承载 reviewer、不回退 owner 本地 provider。当前单锚点 owner 边界未变化，`X27-03` 重开条件未触发。 | 当前 command `clientFor`、mesh `evidenceForExecutor`、local handler 与冻结排除项反向核对 |
| IR27-31 | [x] | 启动、持续恢复与停机 | 通过：启动与持续维护均先经 `loadActiveSession` 收敛 terminal attempt；逐 conversation 隔离、oldest-first 补审和健康项继续不变，started/invoking/terminal root 在恢复与停机竞争中均有确定重驱或清理终态。 | 当前 `recovery-maintenance.ts`、`loadActiveSession`/`reconcileTerminalReviewAttempts`、取消与 queued-root 竞争用例重建 |
| IR27-32 | [x] | RPC/CLI 产品旅程可达性 | 通过：确认、原任务执行、连续补审、deferred 后恢复、保存反馈与确定收场均可达；review-attempt/rootLease 仅属 owner 内部事实，RPC/CLI 有限投影不泄露拓扑、租约或能力凭证。 | 当前 RPC state/detail projector、CLI maintenance、deferred/响应丢失恢复链与产品输出核对 |
| IR27-33 | [x] | 并发、半提交与崩溃矩阵 | 通过：acquire 响应不明、invoking 后崩溃、provider usage 后 review 提交失败、target 漂移、取消与 acquire/deferred/queued-root 竞争均由耐久 attempt 与 root inspection 收敛；同 run 单飞且 invoking 不重放 provider。 | 真实 governor+生产 metered reviewer 7 个定向用例及当前 controller 状态推演 |
| IR27-34 | [x] | 安全与零副作用 | 通过：协议签名、owner/revision/lineage/root 静态绑定与零读取拒绝成立；log/artifact canonical handle 防住 symlink/ABA，reviewAttempts/rootLease 未进入 RPC/CLI wire 投影，拒绝路径不泄露字节或能力凭证。 | 当前 codec/guard、RPC projector、PathGuard 与攻击负例核对 |
| IR27-35 | [x] | 资源、保留与复杂度 | 通过：每个 review generation 恰一 root，terminal root 不复活；queued/active/terminal 分类支持幂等清理，未完成计量在 settle 时保守消费，attempt 投影按 run 只保留最新代，未引入随日志或场景无界扫描的新热路径。 | 当前两侧 governor、controller cleanup、reducer 与计量/重启直接用例重建 |
| IR27-36 | [x] | 第 14/15 单元历史合同 | 通过：review-attempt 的 lineage/generation/root 与 mutation id 全由耐久输入稳定派生，外部副作用前先写 started/invoking，恢复不依赖单次调用栈；有限 X/L 重开检测未发现第二 owner、宽松 codec 或响应丢失空洞。 | 当前事件/guard/store/controller 与第 14/15 单元适用检测动作逐项对账 |
| IR27-37 | [x] | 文档、结构与交付闭包 | 通过：93 路径、0 删除、分组、路径集哈希、交付指纹与逐路径归项全等；结构 golden 已同步当前 RPC 合同和生产依赖边；架构和规格已同步 review-attempt 严格代际、invoking 不重放、owner 终态先于 root 清理及 terminal root 不复活，未引入依赖或范围外设施。 | 当前 manifest 与结构 golden 只读复跑通过；两份权威文档与生产代码反向对账，`git diff --check` 通过 |
| IR27-38 | [x] | 执行侧公开契约瞬态注入 | 通过：host lifecycle 在 onBeforeRun 从 active owner 投影注入同一确认版 passCriteria/evidence requirements；终态不注入，不改落盘原文/窗口/system/tools/cache prefix，failureHandling、库索引和裁判过程未下发，ConversationManager 无领域引用。 | 已审 |
| IR27-39 | [x] | 归因权威与确定性续推 | 通过：criterionId 顺序稳定、工具强制恰一覆盖，unmet 从 attribution 派生；review/proxy 复合写和 missing-proxy 纯函数重建复用同一 attribution/failureHandling，只输出结论与证据摘录。 | 已审 |
| IR27-40 | [x] | 产品呈现、交互身份与恢复可见性 | 通过：确认、取消、resume、proxy 来源、详情与收场均为人话且不泄漏拓扑；全局保存实际 saved/deferred/failed 在原任务准入后反馈，失败不伪装成功。 | 当前 RPC/CLI 投影与产品旅程核对 |
| IR27-41 | [x] | 事件状态机结构性闭包 | 通过：十五类 producer/reducer/replay 均有严格 codec、领域 guard、合法 producer 和直接负例；`advancement-event` 已进入 conversation record 真实生产、完整重放和异载荷拒绝矩阵；`review_attempt_transitioned` 的 lineage/generation/root/phase 及与 review/terminal 复合提交的跨事件绑定均在 reducer 前拒绝错配。 | 当前 event union、codec、guard、reducer、两种 store producer与 41 项行为矩阵反向对账通过 |
| IR27-42 | [x] | 第 18 单元历史合同 | 通过：当前资源身份、租约层级、producer 输入和 runtime validator 均成立；新增 root inspection 只返回有限状态分类，terminal exact replay fail-closed；current-owner replay 在现有单锚点拓扑不可达并由 `X27-03` 与全局第 32 单元门禁承接。 | 当前两侧 governor 合同与历史重开条件逐项核对 |
| IR27-43 | [x] | 第 20 单元历史合同 | 通过：远端只取证、local/mesh 同 handler、owner 裁判不远端执行成立；review-attempt 只扩展 owner 的资源 governor 控制面，未建立远端 reviewer 或第二数据入口，相关未来 owner 疑点继续引用 `X27-03`。 | 当前 local/mesh 组合根、adapter 与历史重开条件逐项核对 |
| IR27-44 | [x] | 第 23 单元历史合同 | 通过：日志重放、I/O permit、consumer、evidence child 清理与静态身份检测均成立；review generation 在 acquire 前耐久，released/settled/reclaimed root 只作终态分类并驱动下一代，旧根不会复活或重新调用 provider。 | 当前 owner 日志、governor replay/inspection、controller cleanup 与历史检测动作复核 |
| IR27-45 | [x] | 第 25/26 单元交界合同 | 通过：executor-role 秘密隔离、descriptor 只声明稳定 provider kind、请求级 workspace/Git 解析和 accepted-run oldest-first 连续前缀均成立；没有重开第 25/26 单元既有根因。 | 当前源码与冻结合同交界核对 |

---

## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 工作量评估 | 问题评级 | 相关审查项 |
| --- | --- | --- | --- | --- | --- |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| --- | --- | --- | --- | --- | --- |
