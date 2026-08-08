## 审查清单

### 当前状态

- **当前单元**：第 32 单元 · generation 1
- **权威来源**：research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md、distributed-runtime-charter.md、specification.md；直接上游合同为 scheduler-architecture.md、task-advancement-rubric-architecture.md、rubric-protocol.md、transcript-persistence-and-attention-window-architecture.md 及其引用的 lifecycle-concepts.md；执行边界以已定稿开发清单 D32-01～D32-08 为准
- **交付基线**：父提交 4f843748 → 当前 HEAD dd50eec8；共 67 个变化路径，其中 61 个属于第 32 单元生产实现、直接测试、S7 门禁与当前架构/规格同步，6 个 research/design/workbench 路径只承载开发清单、单元账本/清单归档及当前审查清单，不参与功能通过判定
- **生产装配关系**：本地域 owner 提供唯一 transfer source，锚点提供唯一 target/coordinator；双方通过既有认证 mesh request channel、各自 AuthorityCommitLog 与设备 ArtifactStore 协调，ConversationTransferCommit 唯一切换 current owner；同一 current-owner verifier 前置于 local/mesh evidence 读取；提交恢复后才驱动公开 local session 路由、收编复核与锚点记忆蒸馏
- **目标提交边界**：只交付 conversation scope 的双端耐久收编、完整会话域与 conversation-owned intent 搬运、唯一 ownerEpoch 切换、旧 owner fencing、current-owner evidence 门禁，以及收编闭合后的第一方离线新建/查询/恢复、自动收编、复核与记忆补驱动
- **明确排除**：anchor scope planned/disaster transfer、AnchorTransferCommit、TrustTransition、ReadyProof、全量/周期 CheckpointEnvelope、恢复根与凭据轮换；第 36～38 单元服务生命周期、设备移除/卸载、升级与发布；锚点域既有会话离线写、非权威只读副本、秘密/环境事实/缓存迁移、全局预算追认；第二事实源、通用事务/同步/备份/registry/事件总线/调用图/测试 runner、监控、诊断、benchmark 与信息采集；干活电脑不新增渠道宿主
- **当前任务进度**：第 32 单元独立审查完成（0 项 [ ]，40 项 [x]，0 项 [!]，0 项 [~]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：本轮已逐项重审全部 35 个 `[~]`，并直接复用输入未变化的 IR32-03、IR32-04、IR32-19、IR32-20、IR32-24；40 项均无 P0/P1，当前问题列表为空，独立审查通过。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| always-online-and-local-execution-requirements.md §一 | 适用 | 持续在线与本机真实环境并存的产品目标归入 IR32-01、IR32-21～IR32-28、IR32-37。 |
| 需求文档 §二～§五 | 不适用 | 外部项目转述、事实核验与方案形成过程不是本单元规范性合同。 |
| 需求文档 §六～§七 | 适用 | 两种部署形态体验平权、失联时本机继续工作及重连后收编归入 IR32-21～IR32-28、IR32-31、IR32-37。 |
| distributed-runtime 目录的 s2-security-supply-chain-review.md 全文 | 不适用 | 本单元未新增、升级或改变 mesh 安全依赖及供应链装配；只复用既有认证 mesh，安全依赖门禁不得扩成当前功能审查。 |
| distributed-runtime-charter.md 当前版本交付原则、一、二 | 适用 | 最小完整产品、单一产品和当前用户价值归入 IR32-01、IR32-21～IR32-28、IR32-37～IR32-40。 |
| 总纲 §1 | 适用 | 单机是分布式退化形态、会话权威唯一及角色复用归入 IR32-01、IR32-15～IR32-18、IR32-31、IR32-37。 |
| 总纲 §2 | 适用 | anchor、executor、surface 角色与 source/target/公开接入边界归入 IR32-06～IR32-18、IR32-21～IR32-26、IR32-31。 |
| 总纲 §3 | 适用 | core→owner-kernel→rpc/cli 的无环依赖和组合根职责归入 IR32-02～IR32-04、IR32-31～IR32-34、IR32-37。 |
| 总纲 §4 | 适用（复用边界） | 设备身份、认证 mesh、签名、最小权限和 old-owner fencing 归入 IR32-02～IR32-05、IR32-11、IR32-17～IR32-20、IR32-33、IR32-35；不重审配对和信任链实现。 |
| 总纲 §5 | 适用 | 会话域完整权威、conversation-owned intent、全局 memory 与 schedule/rubric owner 分界归入 IR32-08、IR32-13～IR32-17、IR32-24～IR32-25、IR32-29～IR32-30。 |
| 总纲 §6 | 适用（交界） | freeze 前 active/queued/confirmation/finality 收束及旧能力拒绝归入 IR32-07、IR32-16～IR32-18、IR32-32；不扩写 run/job 协议。 |
| 总纲 §7 | 不适用（守边界） | 环境路由是既有 S7 能力；本单元只在 IR32-08、IR32-20、IR32-35 检查 workspace/环境事实不被迁移或越权读取。 |
| 总纲 §8 | 适用（交界） | mesh 无损请求、确认最终性和响应丢失恢复归入 IR32-10～IR32-14、IR32-18、IR32-23～IR32-26、IR32-33。 |
| 总纲 §9 | 适用 | conversation AuthorityTransfer、current-owner 切换、公开离线旅程、复核与 post-adoption memory 全量归入 IR32-02～IR32-33。 |
| 总纲 §10 | 适用（局部） | 启动恢复先于准入、停机拒绝新 transfer 并保留耐久事实归入 IR32-10、IR32-14、IR32-18、IR32-30、IR32-32；托管服务/移除/卸载属于后续单元。 |
| 总纲 §11 | 适用 | “值班设备/干活的电脑”语言、明确同意、可行动错误与待确认重浮现归入 IR32-21～IR32-28。 |
| 总纲 §12 | 适用（直接行） | transfer 任意步中断、网络/响应丢失、重启、旧 owner、坏尾、磁盘满、版本偏斜及确认重连归入 IR32-04～IR32-20、IR32-23～IR32-26、IR32-30～IR32-36。 |
| 总纲 §12 的灾难恢复、设备撤销和渠道投递专属行 | 不适用 | 分别属于第 33～38 单元或既有 S6/S7；本单元只验证未借收编提前启用。 |
| 总纲 §13 不变量 1、4～6、8、11～17及 2～3 的 freeze 交界 | 适用 | 唯一 owner、executor 零全局写、角色零装配、秘密不迁移、old-owner fencing、双拓扑、完成语义、包边界、staged 隔离、能力校验及在途 run 身份/栅栏兼容归入 IR32-02～IR32-20、IR32-31～IR32-37；job 专属部分不扩写。 |
| 总纲 §13 的 job、delivery 与完整资源治理专属部分 | 不适用 | 不属于 conversation 收编；只在 IR32-34、IR32-36 检查复用既有治理且不建旁路。 |
| 总纲 §14 S8 第 32 单元 | 适用 | 当前实施顺序与停止条件归入 IR32-01～IR32-40。 |
| 总纲 §14 既有上游与第 33～38 单元 | 不适用（边界） | 上游仅按现行端口消费；后继 transfer/backup/service 能力不得提前成为提交内容，归 IR32-38 守界。 |
| 总纲 §15 | 适用 | 双拓扑、故障、安全、零术语与成比例证据归入 IR32-02～IR32-40。 |
| specification.md §1.1 | 适用 | xfer/request/conversation/device identity、ownerEpoch、localDomainId 与规范时间归入 IR32-02、IR32-05、IR32-15～IR32-18、IR32-22～IR32-23、IR32-29。 |
| 规格 §1.2 | 适用 | JCS、严格未知字段、Digest/ArtifactRef、签名域与引用目标归入 IR32-02～IR32-05、IR32-09、IR32-12～IR32-14、IR32-33、IR32-35。 |
| 规格 §1.3、§1.3b | 适用 | conversation、SessionState、segment、Evidence、memory、schedule/rubric 外部符号与冻结字段归入 IR32-02、IR32-08、IR32-13、IR32-19、IR32-24～IR32-25、IR32-29。 |
| 规格 §1.4～§1.5 | 适用 | 构件名、AuthorityError 与公开稳定结果边界归入 IR32-04、IR32-20～IR32-28、IR32-38。 |
| 规格 §2.1 | 适用 | device/current owner、SourceFreezeProof、ConversationTransferCommit/Manifest/Abort 与 TransferRecord 身份归入 IR32-02～IR32-05、IR32-11～IR32-18。 |
| 规格 §2.2 | 适用（复用） | source/target 签名、受众、scope、expiry 和 replay 防护归入 IR32-03～IR32-05、IR32-11、IR32-17～IR32-20、IR32-33、IR32-35。 |
| 规格 §2.3～§2.4 | 不适用 | SecretStore 与 CredentialExposureRecord 不迁移、不修改；IR32-08、IR32-35 只审秘密零进入 transfer。 |
| 规格 §2.5 | 适用（既有接缝） | 两生产根复用已认证 mesh bootstrap、角色授权与连接恢复归入 IR32-11、IR32-18、IR32-31、IR32-33、IR32-37。 |
| 规格 §3.1 | 适用 | 完整 SessionState 重建、会话 mutation/current-owner guard 与本地域公开能力归入 IR32-08、IR32-13、IR32-15～IR32-17、IR32-21～IR32-22。 |
| 规格 §3.2 | 适用（消费） | 收编后 rubric/schedule review 与 MemoryFlush 只能走锚点既有 GlobalStatePort 归入 IR32-24～IR32-25、IR32-29～IR32-30；source/target 不得获得全局写能力。 |
| 规格 §3.8、§3.2b | 适用 | intent 随 conversation 搬运、current-owner 定位、收编后 internal review 与 authenticated confirmation 归入 IR32-08、IR32-13、IR32-16、IR32-23～IR32-26。 |
| 规格 §3.3～§3.4b | 适用（守边界） | 环境事实不迁移，transfer 拉取与 staging 复用设备容量/存储治理归入 IR32-08、IR32-12、IR32-34～IR32-36。 |
| 规格 §3.5 | 不适用 | ControlCompletionPort / AdvancementReviewerPort 是既有推进裁判端口；收编后 rubric/schedule 复核走 §3.2b internal review 与 ConfirmationHub，memory 走 GlobalStatePort，不得借本单元改写 §3.5。 |
| 规格 §3.6～§3.7 | 适用（交界） | freeze 前 run/assignment/finality 收束、commit 后旧 owner 能力拒绝归入 IR32-07、IR32-16～IR32-18；不新增派发协议。 |
| 规格 §4.1 | 适用 | 双端各自唯一 AuthorityCommitLog、transfer 逻辑流、投影重建、日志前缀与 commit 发布归入 IR32-04～IR32-18、IR32-30。 |
| 规格 §4.2 | 适用 | manifest/记录基底/内容资产进入既有 ArtifactStore、先资产后引用、共享 digest 保留归入 IR32-09、IR32-11～IR32-14、IR32-17、IR32-34。 |
| 规格 §4.3 | 适用 | transfer、conversation、intent、final、segment 与 activity 流的完整选择/导入归入 IR32-04、IR32-08、IR32-13～IR32-18、IR32-29。 |
| 规格 §4.4 | 适用 | commit 前准备全部派生 delta、一次权威切换与恢复一致性归入 IR32-14～IR32-18。 |
| 规格 §4.5 | 适用 | staging 清理、共享资产保留、tombstone 与 memory 水位恢复归入 IR32-10、IR32-14、IR32-17、IR32-29～IR32-30。 |
| 规格 §5.1 | 适用 | transfer command/result、公开 session/confirmation 请求的严格 envelope 与幂等归入 IR32-02、IR32-04、IR32-21～IR32-26、IR32-33。 |
| 规格 §5.2～§5.6 | 适用（交界） | source freeze 收束 assignment/interaction/final，公开重连补终态且不重复归入 IR32-07、IR32-17～IR32-18、IR32-23～IR32-26；不改现有派发/stream 合同。 |
| 规格 §5.7 | 适用 | current-owner EvidenceRequest verifier 必须先于 journal exact replay、workspace/path 和文件读取归入 IR32-19～IR32-20、IR32-31、IR32-34。 |
| 规格 §6.1 | 适用（交界） | active/queued/confirmation/finality 在 freeze 前达到可判定终态归入 IR32-07、IR32-10、IR32-18。 |
| 规格 §6.2、§6.2b | 不适用 | user/system job 不属于 conversation scope transfer。 |
| 规格 §6.3 | 适用 | prepared→frozen→imported→committed→tombstoned 与 pre-commit aborted 的逐边状态机归入 IR32-04～IR32-18、IR32-39。 |
| 规格 §6.4 | 不适用 | 设备状态与 UncertainResolution 没有被本单元扩写。 |
| 规格 §7 六类覆盖表 | 适用（conversation 行） | 会话状态与会话内容资产的转移/删除/保留分类、环境事实与秘密及非权威缓存不转移归入 IR32-08、IR32-13～IR32-17、IR32-35；全局状态与执行资产不由 conversation transfer 搬运。 |
| 规格 §7 CheckpointEnvelope 与 root activation 块 | 不适用 | 全量加密检查点、恢复根激活、复制回读和 TrustTransition 属第 33～35 单元；当前 manifest/wire/装配必须拒绝提前承载，归 IR32-38 守界。 |
| 规格 §8 | 适用（有限落点） | transfer/evidence/session/confirmation/memory 的生产入口与消费落点归入 IR32-19～IR32-33；其他 S7 入口只做兼容边界。 |
| 规格 §9 | 适用 | 锚点域/本地域会话能力矩阵、失联可用性与收编后能力归入 IR32-15～IR32-28、IR32-31、IR32-37。 |
| 规格 §10、§10.1 | 适用 | staging 拉取、ArtifactStore 写入、memory 消费及恢复不得绕过容量与锁顺序归入 IR32-12、IR32-29～IR32-30、IR32-34。 |
| 规格 §11 | 适用 | 离线新建/恢复、自动收编、冲突/暂态失败、待确认和内部术语净化归入 IR32-21～IR32-28。 |
| 规格 §12 对应总纲不变量 1、4～6、8、11～17及 2～3 的 freeze 交界 | 适用 | identity、幂等、唯一 owner、old-owner fence、strict wire、两根、角色零装配、完成语义、安全、恢复及在途 run 身份/栅栏兼容归入 IR32-02～IR32-39。 |
| 规格 §12 的 job/channel/anchor disaster 专属矩阵 | 不适用 | 不属于当前 conversation 收编；只检查未提前启用或误装配。 |
| 规格 §13 的 transcript、scheduler、rubric 行 | 适用 | segment MemoryFlush、schedule/rubric review 与 current evidence 边界归入 IR32-19、IR32-24～IR32-25、IR32-29～IR32-30、IR32-38。 |
| 规格 §13 的其他模块行 | 不适用 | 当前交付未改变对应模块合同。 |
| 规格 §14 | 不适用 | S1 历史开工清单不是第 32 单元现行合同。 |
| 规格 §15 第 30～32 项 | 适用 | 第 30/31 单元为前置，第 32 项是当前实现与验收，归入 IR32-01～IR32-40。 |
| 规格 §15 第 33～38 项及其专属枚举行 | 不适用 | 后继检查点、迁居、灾难恢复、服务生命周期和发布不得成为当前实现或门禁。 |
| scheduler-architecture.md 当前生产架构、§一及§三现行 schedule authority 合同 | 适用（上游） | 收编后的四类 schedule intent 只能经既有锚点 authority/CAS 和认证确认生效，归入 IR32-24～IR32-26、IR32-37。 |
| scheduler 文档 §二、历史推演与待根治项 | 不适用 | 旧实现分析和 scheduler 专项技术债不是本单元义务。 |
| task-advancement-rubric-architecture.md 页首取证边界、需求区、§0～§3 | 适用（上游） | canonical evidence、会话契约与本地域/锚点角色边界归入 IR32-19～IR32-20、IR32-24、IR32-37。 |
| rubric 文档 §4.1～§4.7 | 适用（搬运/恢复） | SessionState、confirmed snapshot、advancement 生命周期必须随会话完整重建且不成为第二事实源，归入 IR32-08、IR32-13、IR32-37。 |
| rubric 文档 §5.1～§5.6 | 适用（交界） | freeze 收束、resume 快照和 canonical evidence 归入 IR32-07、IR32-19～IR32-20、IR32-26、IR32-37。 |
| rubric 文档 §6～§7 | 适用（有限兼容） | imported awaiting/active/closed advancement 状态、恢复 owner 与退出边界必须保持现行语义，归入 IR32-07～IR32-08、IR32-13、IR32-37；不重做推进执行体或全局预算。 |
| rubric 文档 §8～§10 | 适用 | local-draft、ArtifactRef、intent review、confirmation 与产品显示归入 IR32-08、IR32-23～IR32-28、IR32-37。 |
| rubric 文档 §11～§14 | 适用（有限上游） | 包边界、生产测试拓扑和稳定不变量归入 IR32-31、IR32-37～IR32-39。 |
| rubric 文档 §15、C1～C18 | 不适用 | 历史提交/施工记录不是第 32 单元现行义务；当前接口仅按上游合同消费。 |
| rubric-protocol.md 〇～二 | 适用（上游） | rubric 的稳定资产身份、title/description/content 基础结构必须随 intent 资产完整搬运且不被收编层重解释，归入 IR32-08、IR32-13、IR32-24、IR32-37。 |
| rubric 协议 §三～§六 | 适用（上游） | 通过标准、证据要求、失败处理和运行契约只能由既有 anchor review 校验/消费，收编协调器不得绕过或改写，归入 IR32-24、IR32-37。 |
| rubric 协议 §七、§九 | 适用（上游） | ArtifactRef 闭包、稳定身份、保存态校验与既有资产管线归入 IR32-08、IR32-13～IR32-14、IR32-24、IR32-37。 |
| rubric 协议 §八 | 不适用 | 退出边界、优先级与版本信息是协议扩展点，本单元不得因收编预实现。 |
| rubric 协议 §十 | 适用（负边界） | 收编不得把 rubric 变成执行方案、权限规则或每轮重新确认的协议，归入 IR32-24、IR32-35、IR32-37。 |
| transcript-persistence-and-attention-window-architecture.md 页首 S7 写入边界、§3.1.2～§3.1.5 | 适用（上游） | transcript/run/segment 的权威表示、崩溃恢复、读取和保留边界归入 IR32-08、IR32-13～IR32-17、IR32-29～IR32-30。 |
| transcript 文档 §3.2.1～§3.2.2 | 适用（上游） | 收编会话 resume 必须从 imported transcript/segment 权威基底重建注意力窗口，不得把 source 的瞬态窗口当权威搬运，归入 IR32-13、IR32-22、IR32-28、IR32-37。 |
| transcript 文档 §3.2.3～§3.2.5、§3.3～§3.5 | 适用（直接交界） | segment flush hook、resume 与不变量归入 IR32-26、IR32-29～IR32-30、IR32-37。 |
| transcript 文档信息梳理、§一～§二、§3.0～§3.1.1、分布式 assignment 历史说明 | 不适用 | 形成过程、目录形态与既有 assignment 施工说明不由本单元修改。 |
| lifecycle-concepts.md 维护约定 | 不适用 | 文档维护规则不是第 32 单元产品、架构或验收义务。 |
| lifecycle-concepts.md §一 attention window 与 turn | 适用（术语边界） | imported transcript 只重建派生 attention window，freeze 收束对象不能把单个 turn 或窗口误当完整 run，归入 IR32-07、IR32-13、IR32-28、IR32-37。 |
| lifecycle-concepts.md run | 适用 | source drain 必须等待一次 runtime.run 的完整往返及其资源终态，而不是仅等待最后一次 LLM turn，归入 IR32-07、IR32-18、IR32-32。 |
| lifecycle-concepts.md §二需求与钩子 | 不适用 | 本单元不新增或改写 AgentRuntimeLifecycle 钩子；transfer/review/memory 只消费既有 owner/segment 接缝。 |
| unit-development-workbench.md 静态目标/边界与 D32-01～D32-08 | 适用 | 八项生产、消费、装配、异常/恢复和直接测试义务反向归入 IR32-01～IR32-40。 |
| 当前完整交付物 4f843748→dd50eec8 的 67 个变化路径 | 事实来源 | 61 个第 32 单元功能路径逐一归入 IR32-01～IR32-40；6 个 workbench 流程路径明确排除，不参与功能通过判定。 |

### 审查项

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR32-01 | [x] | 单元身份、边界与完整交付物 | 冻结父提交 4f843748 到当前 HEAD dd50eec8 的 67 个变化路径并二元归属；61 个功能路径必须全部反绑 D32-01～D32-08，6 个流程路径不参与功能判定；不得含第 33～38 单元能力或无依据框架。本项在路径、来源与边界对账完成后停止。 | 封版准备重新计算而非复用旧清单计数：61 个功能路径全部反绑 D32-01～D32-08，6 个 workbench 路径仅维护流程；相对 030508e1 新出现的 11 个功能路径分别归入 storage governor、current-authority/confirmation、first-party mesh、memory 水位与对应直接测试，均已由相关审查项覆盖；生产 wire、装配与门禁未引入后继能力或无依据框架。 |
| IR32-02 | [x] | transfer 严格判别联合与导出合同 | SourceFreezeProof、ConversationTransferCommit、ConversationTransferManifest、ConversationTransferAbort、TransferRecord、command/result 必须具备唯一 v1 字段集、封闭判别、稳定导出与递归严格 validator；未知/缺失/多余字段、错类型和跨分支组合在副作用前拒绝。 | current core codec 将 result 收为按 state 封闭的 exact-key 联合：prepared 零附加、frozen/imported 绑定 ref、committed/tombstoned 绑定 commit、aborted 绑定签名 abort；client 在分类前反绑 originating command 的 request/transfer/ref/range/commit/abort，错分支和多余字段均在副作用前拒绝。 |
| IR32-03 | [x] | 规范摘要、签名与引用反绑 | JCS、schema/version 域、对象身份摘要、ArtifactRef 原始字节摘要、source/target 签名、freezeProofDigest/checkpointDigest/manifestDigest/commitDigest 必须按规格唯一计算并逐引用核对；重签、篡改、错 key/target/version 均 fail-closed。 | 直接复用已通过结论：canonicalize/byteDigest/protocolDigest、三类签名 validator、manifest 原始字节 ref、proof→manifest、imported→manifest、commit→proof/checkpoint 与 tombstone→commit 逐级反绑；错误 schema/version、签名、目标、epoch 或 digest 均在对应追加/复制/提交前失败。 |
| IR32-04 | [x] | transfer reducer 与状态边 | 双端 transfer:<transferId> 只允许 prepared→frozen→imported→committed→tombstoned 及 commit 前 aborted；prepared 后双端身份、conversation、epoch 和 payload 不漂移；同载荷重放幂等，异载荷、越级、回退、late abort、坏尾恢复零非法状态。 | 已逐分支核对 `reduceConversationTransfer` 与 durable projection：首记录、相邻 phase、同 kind digest replay、generation 继承、commit/abort/tombstone 反绑均封闭；异载荷、越级、回退、late abort 和不兼容后继在投影提交前失败，坏尾由 AuthorityCommitLog 恢复边界处理。 |
| IR32-05 | [x] | 稳定操作身份与请求重放 | requestId、xfer-ULID、source/target device、conversation、sourceOwnerEpoch/nextOwnerEpoch 必须在发起、wire、双日志、恢复和响应中全等；并发同请求、异载荷复用、效果后响应丢失和连续重启不得产生第二 transfer 或 epoch。 | requestId/transferId 由 local conversation 身份稳定派生并贯穿 wire、双日志、manifest、commit/abort 和恢复；strict client correlation 与 reducer exact replay 拒绝异载荷和错响应，响应丢失只重驱同一 transfer/epoch。 |
| IR32-06 | [x] | 源端资格、双方 prepared 与准入线性化 | 仅当前本地域 owner 可把设备前缀全等的 local conversation 收编到已认证当前锚点；双方 prepared 对账后，源日志同一顺序重验会话未删除/无在途 transfer 并耐久关闭 fresh admission；错 owner/目标/epoch/会话在首个副作用前拒绝。 | local owner 全 mutation 统一经 current-authority guard；source prepare 在 settle 后再次进入同一 journal/log prefix 重验会话身份、未删除与 ownerEpoch，再追加 prepared。prepare 前失败恢复 transient gate，prepared 后崩溃由耐久 projection 恢复 fencing；错 source/target/epoch/conversation 零权威追加。 |
| IR32-07 | [x] | freeze 前在途工作收束 | active/queued 的完整 runtime.run（不是单个 turn/attention window）、pending confirmation、interaction、final-outbox、advancement 与资源/finality 必须达到既有可判定终态或明确裁决后才冻结；drain 超时、取消竞态、final 暂态失败和并发新写不得产生假 frozen 或半终态。 | prepare 先关闭全部 owner mutation 并等待 command drain，再收束完整 run、assignment、interaction、final/recovery、advancement 与 lease，随后在 journal 锁内重验身份后冻结；drain/终态失败进入 catch 恢复 gate 且不追加 frozen，故不存在探针后并发写窗口。 |
| IR32-08 | [x] | 完整 conversation-owned 选择器 | manifest 必须覆盖 meta/transcript、run/control/publish/final-outbox、task-list/segment/advancement、session-activity、content-asset-index、intent 及 rubric 资产；共享流逐字段反绑会话，无法归属 fail-closed；GlobalState/job/trust/delivery、秘密、环境事实和缓存零进入。 | selector 严格解引用外置 control envelope，按 conversationId/requestId 收齐 received/applied、publish/final-outbox、run/intent/session activity 与 SessionState/segment/advancement/content/rubric closure；无法反绑的 authority record 拒绝，GlobalState/job/trust/delivery、秘密、环境事实与缓存未进入 manifest。 |
| IR32-09 | [x] | checkpoint、manifest 与窄取件口 | 同一 AuthorityCommitLog 前缀生成 DurableLogCheckpoint、规范 manifest artifact、记录基底和 SourceFreezeProof；checkpointDigest 必须等于 manifest ArtifactRef digest；read port 只允许 proof 绑定目标按声明 ref/range 读取，越范围、任意路径和任意 ArtifactStore 访问均拒绝。 | source 从同一 log checkpoint 生成规范 records/session/manifest 并签 proof，checkpointDigest 反绑 manifest ref；read port 每次重验耐久 phase、目标与冻结 closure exact-set，只允许声明 ref 的有界 range，未暴露路径或任意 store。 |
| IR32-10 | [x] | 源端 abort、冻结恢复与重入 | 仅 pre-commit 合法 abort 可恢复源端原 epoch 准入并要求目标 staging 隔离清理；frozen 后不得自行重开写，commit 后 abort 恒拒绝；崩溃、网络/响应丢失、重复发起、坏尾和连续重启只从源 transfer 流追平。 | stable non-retryable rejection 仅在 target status 证明未 commit 时生成同一签名 abort；target 先耐久落定并回放，source 全等校验后追加并恢复原 epoch。commit/tombstone 后 abort 永久拒绝；网络/ACK 丢失和重启均从双端耐久状态追平。 |
| IR32-11 | [x] | 目标资格与隔离 staging | target 仅存在于 anchor，且只接受 home 内 active source、正确 local conversation 前缀、source epoch 和无冲突目标/transfer；先落 target prepared，再建 transfer 私有 staging；imported/commit 前 session 目录、owner 查询、intent review 和业务写零可见。 | target 仅由 anchor 根装配并先验证 active source、local id、epoch 与冲突；每个 transfer 在 authority root 下取得独立 FileArtifactStore/receiver，prepared 后才建私有目录，imported/commit 前不进入 session、owner、review 或业务读面。 |
| IR32-12 | [x] | 拉取、容量、背压与锁顺序 | target 只经认证 transfer mesh 按 manifest 顺序 probe/range 拉取，分块接收复用 putVerifiedStream、storage governor 与设备唯一 arbiter；容量等待、取消、磁盘满、backpressure 不持 authority/ArtifactStore 锁，不得绕过治理或误报成功。 | 两根必注入同一 storage governor 与 lifecycle abort；source freeze/read、target private append/finalize、promote/cleanup 均以稳定 work key 执行 conversation-transfer step。网络先取得有界 chunk，再申请本地 permit，permit 不跨网络、authority 或 store 锁；取消、容量饱和和磁盘满保留耐久可恢复状态且不返回 commit。 |
| IR32-13 | [x] | 全量校验与会话读面重建 | imported 前必须全验双端身份、proof、manifest 规范字节、lastLsn、各流计数/摘要、记录基底、全部 ArtifactRef、reducer version 和 source checkpoint；导入记录保持源 envelope 分组、LSN/时间顺序和 exact replay 身份，与目标后继无碰撞、漏序或重复；ConversationRunJournal/SessionState/attention window 只由 manifest+commit 指向的权威记录重建，不产生第二事实源。 | imported 前全验 proof/manifest/checkpoint、stream count+digest、全部 closure refs 与 reducer version；外置 control 被解引用并保留 request 对。target 由 committed-base 中的 records/session/control 按原 LSN/envelope 重建 journal、SessionState 和派生窗口，exact replay 身份不变且无第二事实源。 |
| IR32-14 | [x] | 部分导入、幂等追平与隔离清理 | 空/大资产、共享 digest、重复/乱序分块、部分导入、响应丢失和连续重启必须从同一 staging 追平；缺件、多列、损坏、错会话/epoch/digest/version 失败封闭；pre-commit abort 幂等清理私有 staging，不污染既有会话或共享资产。 | partial 以 transfer 私有 receiver/digest 状态重驱，完整验真后才按冻结 closure 幂等提升共享 CAS；已有/共享 digest 只验证复用。abort/cleanup 仅删私有目录，提升出的共享对象交由既有 lifecycle，缺件、损坏、错身份/version 和重复恢复均不污染共享事实。 |
| IR32-15 | [x] | 唯一 commit 与不可分可见性 | 仅 imported 全验后由目标签发 ConversationTransferCommit；同一 anchor AuthorityCommitLog 事务唯一切换目录可见性、current owner 与 nextOwnerEpoch，fsync 后投影和不可变历史基底零假阴性、零半套，重启可由 commit→manifest 确定恢复。 | imported 阶段先构建不可见 publication token；commit 在同一 AuthorityCommitLog envelope 原子追加 signed committed 与 committed-base，单次 sync 同时给出 current owner 和完整可恢复 base。sync 后 token publish 只交换已构建内存视图、零 I/O；崩溃则启动在准入前从 committed-base 重建。 |
| IR32-16 | [x] | current-authority resolver 闭包 | conversation admission、run/assignment capability、control/session mutation、intent review、final/history、evidence 和公开 owner-aware route 必须读取同一窄 current-conversation-authority resolver；普通会话保持原 epoch，收编会话取 commit epoch，禁止 anchorEpoch/进程 local epoch 代替。 | CurrentConversationAuthorityPort/耐久 projection 被 local 全 port、assignment/control/session/interaction/intent、final/history/evidence、候选/列表及公开 router 共用；普通会话取本地 fallback epoch，committed/tombstoned 取 commit nextOwnerEpoch，未用 anchorEpoch 或进程 set 代替。 |
| IR32-17 | [x] | 旧 owner 永久 fencing 与 tombstone | 源端只接受身份/proof/checkpoint 全等的当前锚点 commit；随后 fresh write、exact replay、intent/evidence/control/assignment 能力全部按旧 epoch 拒绝并返回有限重定向；共享 artifact 不误删，释放源引用和 tombstone 可重驱，commit 后只允许更高 epoch 前滚。 | source 仅接受全身份/proof/checkpoint 全等 commit；committed/tombstoned 在耐久 resolver 中永久映射 target，全部 local mutation、candidate 与 evidence 均在读取前拒旧 owner，用户列表仅保留可路由项。重启仍读取同一 projection；共享 CAS 不由 source/abort 删除。 |
| IR32-18 | [x] | 双日志 coordinator 与崩溃恢复 | source/target/coordinator 以同 transferId 在各自日志协调；任一 fsync/ACK/网络边界崩溃、双方交错重启、重复往返、tombstone 失败均不得双 owner、丢 owner、重复会话/intent/task revision、资产误删或 epoch 回滚。 | coordinator 逐 phase 查询双端 durable status 并以 stable transferId 重放；target commit/abort 先落定，source 只接受签名全等终态。commit 后永久 fencing、pre-commit abort 两端全等、private cleanup 与 committed-base 启动恢复共同排除双 owner、丢 owner、资产误删和 epoch 回滚。 |
| IR32-19 | [x] | current-owner evidence verifier 装配顺序 | local ExecutorEvidenceHandler 与 mesh evidence service 两生产根必须注入同一 verifier；每次请求在 EvidenceJournal exact replay、workspace binding/路径解析及任何文件读取前核对 current device、ownerEpoch、conversation 与静态签名绑定。 | 已核对 access-surfaces 与 executor-role 两根均构造同一 `createConversationEvidenceAuthorityVerifier` 并把同一 handler 交给 local/mesh；`collect()` 顺序为 strict request/signature→executor/lease 静态绑定→durable current-owner resolver→EvidenceJournal replay→freshness→workspace/capability/path/file，旧 owner 在任何 journal/workspace/file 读取前失败。 |
| IR32-20 | [x] | evidence replay、拒绝副作用与读取安全 | 旧 owner fresh 和历史 requestId 均零 journal/workspace/file 读取；current owner exact replay 返回原 bundle，异载荷冲突；错 device/conversation/workspace revision、过期或撤销均稳定拒绝，不泄漏物理路径、文件内容或内部 owner 事实。 | 已核对旧 owner 连历史 requestId 也先过 current-owner verifier；current exact replay 由 EvidenceJournal 返回，异载荷沿 request digest 冲突。workspace revision/capability/expiry、canonical root、open-handle 身份及读后复核均封闭，公开结果仅 bundle/capability-gap/stale 产品摘要，不返回绝对路径或 owner 内部事实。 |
| IR32-21 | [x] | 第一方 owner-aware 路由与用户同意 | 仅现有第一方 session.new/list/resume、/new、/resume、REPL facade 可进入 owner-aware route；值班设备可达保持原路径，不可达必须先明确说明“继续在这台电脑工作（新对话）”及能力限制并取得显式同意；未知动态方法、渠道或工具不得旁路。 | LocalConversationRpcRouter 对 canonical session/confirmation finite exact-set 逐会话解析 current owner：local current 本地执行，frozen/importing 返回有限 busy，target current 经认证 first-party mesh 转发；离线新建仍由现有 facade 先说明能力限制并取得显式同意，动态 RPC、渠道和工具没有新增旁路。 |
| IR32-22 | [x] | local session 新建、查询与恢复 | 失联时只创建/列出/恢复本机 local-<device>-<ULID> 会话；锚点既有会话仍不可写，收编提交后原会话退出 local 可写/候选集合并只按 current owner 路由；错域/未知/已删除/冲突/忙碌具有确定终态；多接入面、响应丢失、重启和 resume 指针切换不得重复会话、双列或串 owner。 | local id 与 CRUD 保持设备域限制；list 稳定合并 local-current 与已收编可路由会话，candidate 排除 committed/tombstoned，resume/send 逐次按耐久 current owner 分流。错域、未知、删除、frozen/importing 与路由不可达均有确定终态，重启不恢复旧写或重复会话。 |
| IR32-23 | [x] | 自动收编候选与重连恢复 | 唯一 adoption coordinator 只选择当前设备未收编且用户明确同意的 local conversation，稳定复用原 transfer 身份；重连、并发触发、效果后响应丢失和连续重启不得漏收、重复收编或把失败/未完成显示为完成。 | coordinator 只在认证当前 anchor 重连后遍历 local current 候选，按 conversation ULID 稳定复用 transferId/requestId 与 durable state；并发/丢响应/重启重驱原 transfer，只有 committed current-owner 可路由时进入完成旅程，pending/retryable 不误报完成。 |
| IR32-24 | [x] | 收编后 rubric 复核 | commit/安装恢复完成后才调用第 31 单元 internal review；收编层不得自行解析、改写或绕过 rubric-protocol 的保存态校验与运行契约；无冲突 rubric 可由有限 host 自动落定，资产缺失/协议无效/CAS/暂态失败保持可重试且不改 active snapshot；不得开放公开 intent RPC、第二 review 事实源或提前读取 staging。 | 直接复用已通过结论：review 仅由 committed base 安装后触发，复用第 31 单元 DeferredIntent review/list/decide；非 time-sensitive intent 用稳定 host request 自动确认，失败保持 durable pending，time-sensitive 不自动应用。未新增公开 intent RPC、rubric 解析器、第二事实源或 staging 读取。 |
| IR32-25 | [x] | schedule 再确认与权威终态 | 四类 time-sensitive schedule intent 必须绑定当前 authenticated surface、原 intent/mutation/revision 并走现有 ConfirmationHub 和 anchor reducer；错 surface、过期、冲突、响应丢失、terminal replay 和物化失败不得重复 task revision或把 pending 显示完成。 | PostAdoptionReviewCoordinator 以 adoption-review:intentId 固定 request，重读 durable intent 并在 current owner Hub 串行接管当前 authenticated surface；旧 surface cancel 后不能新决定，四类 mutation 仍由既有 reducer/materializer 落定。过期、CAS/物化失败、丢响应和 terminal replay 保持同一 decision/task revision。 |
| IR32-26 | [x] | observer、待确认重浮现与去重 | session.resume 必须先建立 observer/当前接入面身份再触发 adoption review；confirmation.list、live/history 与 RPC broker 复用同一 pending/decision 事实，连接切换、响应丢失和连续重启恰一次重浮现，不漏帧、不重复确认。 | resume 先注册 observer/surface 再触发 review；pending 带 conversationId，list/resolve、live/history 与 broker 均路由到同一 current-owner Hub。连接换代会关闭旧 relay并以同 requestId 重建，新 surface 通过 list 重浮现，响应丢失和服务重启从 durable intent 恰一次恢复。 |
| IR32-27 | [x] | 公开结果联合与零术语产品语言 | not-found、busy、invalid、identity/version conflict、temporary failure、adoption/review pending/success 必须映射为稳定、可行动且一致的产品终态；不得泄漏 anchor/owner/epoch/intent/CAS/stream/staging 等内部术语，不得把 provisional/pending/失败说成完成。 | strict transfer rejection 保留结构化 retryable 供内部恢复；session/adoption/review 对外只呈现未找到、正忙、暂时不可用、需确认和完成等稳定可行动终态。frozen/importing/未物化均不说成完成，公开响应未泄漏 ownerEpoch、intent、CAS、stream 或 staging。 |
| IR32-28 | [x] | CLI/REPL 会话旅程完整性 | session facade、controller、commands 和 REPL 的启动 auto-resume、/new、/resume、收编摘要、能力限制与 pending confirmation 必须消费同一公开合同；单机在线行为不退化，多连接目标切换与早到事件不丢失或串会话。 | facade/controller/commands/REPL 共用 canonical session/confirmation contract：失联明确确认后本地新建与恢复，重连自动收编，原会话经 current-owner relay 继续，schedule pending 可随 surface 接管。单机在线路径保持本地执行，generation/observer 关闭旧连接，早到事件按会话定向。 |
| IR32-29 | [x] | post-adoption memory 身份与触发边界 | 只在 ConversationTransferCommit 生效并安装权威 transcript/segment 后补驱动既有 MemoryFlush；operationId 由 conversationId+segment identity+原文/摘要 digest 稳定派生，transferId 不进幂等身份；staging/commit 前和源端生成的全局 memory 零消费。 | memory consumer 只从 committed-base 安装后的 ConversationRunJournal 获取 committed segment；operationId 绑定 conversationId、segmentId、源消息/摘要 digest 且不含 transferId。manifest/staging/source 不携带或执行全局 memory，故 commit 前零消费。 |
| IR32-30 | [x] | memory 水位、失败与恢复 | 零/单/多 segment、已/未蒸馏混合、同 segment 跨 transfer、并行 intent review、LLM/GlobalState 效果前后失败、响应丢失和 anchor 连续重启必须保留可重建水位并最终追平，既有 segment 不重复 memory revision，后续 turn 沿同一水位继续。 | conversation authority log 单源化 discovery/input/attempt/plan/effect/completed；discovery 与全部规范 input/attempt 同事务冻结，首个规范 plan 胜出，effect prepared 先于 GlobalState，只有明确零效果 revision conflict 才建下一 attempt，全部 granted 后 completed。恢复只重驱未完成 input/effect，完成 segment 不再读 transcript 或调用模型。 |
| IR32-31 | [x] | 双生产根与角色 exact-set | anchor+executor 与 executor-only/远端 anchor 两根分别只能装配适用的 source、target、coordinator、evidence verifier、public router、review/memory consumer；同机复用正确日志/ArtifactStore/mesh，非 anchor 零 target/global consumer，八种 topology 的角色集合全等。 | anchor+executor 根装配 source/target/coordinator/current-owner router/evidence 与 anchor-only review/memory；executor-only 根装配 source、evidence、local router 和 remote client，零 target/global consumer。同机复用既有 logs/artifacts/mesh，八配置只改变适用角色集合。 |
| IR32-32 | [x] | 启动、恢复与关闭顺序 | 启动必须先恢复 transfer 投影与 committed authority/历史基底再开放 mesh，并在公开业务准入前追平 post-adoption memory/review；派生消费者允许在 mesh 后绑定，但必须从耐久 commit 补扫且不得让公开面误报完成。关闭先拒绝新 transfer/公开写，停止后台但保留未终态耐久事实供重启重驱；不得遗留双 loop 或伪终态。 | MeshRuntimeAssembly.start 先恢复 committed-base 再开放 control；review/memory bind 会从耐久 commits 补扫，且 bind 完成后才启动公开 HTTP server。关闭触发 transfer abort signal、停 control/worker/relay 并保留未终态日志与私有 staging供重启，未发现双 loop 或伪完成。 |
| IR32-33 | [x] | transfer mesh 与 RPC 注册边界 | conversation.transfer 仅通过既有认证 mesh request channel，command/result 严格校验且 receiver/role 有限；session/confirmation 注册表与 local router exact-set 清晰，未知方法、错角色、未认证 source、任意 artifact/path 请求均 fail-closed。 | transfer 只注册于认证且版本协商的 mesh write channel，peer role/device 与 strict command/result correlation 前置；first-party relay 只接受 canonical session/confirmation finite methods。未知方法、错角色/peer、任意 ref/range/path 均在 receiver 业务调用前拒绝。 |
| IR32-34 | [x] | S7 结构门禁与真实变异 | 现有单一 S7 gate/golden 必须反绑两根 source/target/coordinator、恢复顺序、current-owner verifier、public session exact-set、post-adoption review/memory 与 future-unit denylist；删除、重复、错角色、错顺序、绕过或新增入口真实变异失败，合法装配零误杀。 | S7/golden 已反绑两根 source/target/coordinator、CurrentConversationAuthorityPort 全写面/候选/列表/router、private staging、必注入 governor、committed-base 恢复、surface takeover、durable memory input/watermark 与 future denylist；正式证据 16/16 和 canonical golden 通过，真实删除/替换/错角色/绕过变异 fail-closed。 |
| IR32-35 | [x] | 安全、最小权限与秘密/路径隔离 | 有限核对 transfer command/result/manifest/read-range、EvidenceRequest/Bundle、session adoption result 与 confirmation list/resolve：只含各自冻结身份和内容引用；秘密、环境事实、绝对路径、任意 workspace、raw repository/ArtifactStore 与 rubric 权限能力不迁移不逸出；签名受众、scope、epoch、deadline、capacity 与 path guard 在该链首次副作用前校验。 | wire/manifest/read-range、evidence 与 confirmation 仅携带冻结身份、refs 和产品字段；selector 排除秘密、环境事实、绝对路径/raw store与权限能力。签名/受众/role/epoch/ref/range、current owner、私有根和 capacity 在各自首个副作用前验证，abort 不具共享 CAS 删除能力。 |
| IR32-36 | [x] | 资源、并发与容量失败 | 仅核对 transfer 拉取/staging、投影重建和 post-adoption memory 三类新增负载：必须复用既有 governor/arbiter，锁顺序无死锁、等待可取消、并发 single-flight/分页有界，磁盘满、容量不足和资源失败保留可恢复事实且不静默成功。 | transfer 物理步骤复用唯一 governor、256 KiB chunk 与 lifecycle cancellation，permit 不跨网络/log/store 锁；投影按有限 transfer 状态恢复。memory 以 operation single-flight 和耐久 completed 水位只重驱未完成 input/effect，不重复全历史 LLM；磁盘/容量/模型/GlobalState 失败均保留 pending 且不静默成功。 |
| IR32-37 | [x] | 有限上游与既有产品兼容 | 两种部署形态完成同一核心旅程；普通锚点/本地域会话、在线 session.new/list/resume、confirmation.list/resolve、advancement resume/evidence、segment MemoryFlush 与现有 mesh 请求是有限回归集合；schedule/rubric、transcript/segment、SessionState、ArtifactStore、EvidenceJournal、ConfirmationHub 和第 31 单元 intent seam 只按现行合同消费，不增加渠道宿主、公开 intent 或全局写能力。 | 两生产形态均闭合“失联继续→重连收编→原会话/确认继续”；普通 anchor/local 会话、在线 session、advancement/evidence 与 segment flush 沿既有端口工作。未新增渠道宿主、公开 intent、本地域全局写或改写 scheduler/rubric/transcript/SessionState/ArtifactStore/ConfirmationHub 合同。 |
| IR32-38 | [x] | 架构、规格、wire 与后继边界同步 | 总纲 §9/§14、规格 transfer DTO/TransferRecord/§3.2b/§6.3/§15、core exports、session wire 与生产调用图必须全等；历史段保持非现行，AnchorTransferCommit、CheckpointEnvelope、TrustTransition、ReadyProof、灾难恢复和服务生命周期均未被当前 wire/装配接受。 | 总纲 §9/§14、规格 DTO/TransferRecord/§3.2b/§6.3/§15、exports、session wire 与当前生产调用图已同步 private staging、atomic committed-base、current-owner route、surface takeover、governor 和 durable memory。后继 AnchorTransferCommit/CheckpointEnvelope/TrustTransition/ReadyProof、灾难恢复与服务生命周期未进入 wire 或装配。 |
| IR32-39 | [x] | 成比例的直接验收证据 | 证据计划必须覆盖 strict codec/digest/签名与 §6.3 第 1～8 行、真实双日志 source/delete/write 竞争、target staging/容量/损坏/恢复、commit/fencing/evidence 读取 spy、两生产根公开开箱/失联继续/重连收编/异常恢复四时刻、review/confirmation/memory 故障和 S7 真实变异；八配置只验证 exact-set，不做配置×故障笛卡尔积。 | 同一交付指纹证据覆盖 core transfer 5/5、storage 20/20、owner run 60/60、owner transfer 5/5、CLI 受影响场景 33/33、memory 7/7、S7 16/16+golden；真实 AuthorityCommitLog/FileArtifactStore/Hub/GlobalState 边界包含 delete/write、共享 digest、部分 I/O、sync 前后、fencing、surface 接管、LLM/CAS 和重启反例。八配置仅复用 exact-set，未扩成笛卡尔积。 |
| IR32-40 | [x] | 来源、D32 义务与路径反向闭包 | D32-01～D32-08、全部适用来源条款及 61 个功能路径必须按 core 合同/协议与 memory hook、owner-kernel transfer/assignment/manager、CLI transfer/assembly、current-owner evidence、server/RPC/session/confirmation、CLI 会话体验、架构规格同步、S7 门禁与直接测试九组逐一归入 IR32-01～IR32-39；每组有生产端、消费端、共享原语、装配、正常/异常/恢复和直接证据落点，每条实现有当前架构依据；不存在未判定来源、遗漏、重复、越界或以测试存在代替功能判断。 | D32-01～D32-08、全部适用来源和 61 个功能路径已反向对入九组与 IR32-01～IR32-39；新增 11 路径已按直接交界补入既有有限项，不产生新功能链。每组均有生产/消费/原语/装配、正常/异常/恢复和直接证据落点；源码事实而非测试单独证明功能闭环，未发现未判定来源、遗漏、重复、越界或后继能力混入。 |

> 第 32 单元本轮独立审查已完成：40 项 `[x]`、0 项 `[!]`、0 项 `[ ]`、0 项 `[~]`。P0/P1 与 P2/P3 问题列表均为空，独立审查通过。

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
