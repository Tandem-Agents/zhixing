# 单元开发工作台

> **维护原则**
>
> - 以独占一行的“开发清单”标题为界：此前为静态区，保存长期规则与用户提示词，不随开发单元重置；该标题及其后为动态区，只保存当前单元的开发清单。分隔线仅用于视觉区隔，不承担区域边界语义。
> - 动态区只固定“当前单元”“开发事项”标题、状态说明及空表，不建立独立文档、不归档。
> - 重置步骤：仅当全部开发事项均为 `[x]` 且用户明确要求结束或切换单元时，才将模块、单元、来源、边界和排除项恢复为 `—`，清空全部开发事项并将进度恢复为 `0%`；存在 `[ ]` 或 `[!]` 时禁止重置，历史摘要不构成重置授权。只重置动态区，不得删除固定骨架或改动静态区。
> - 下一单元的来源、边界、开发事项及应交付的实现与测试必须重新生成，不得继承上一单元内容。
> - 提示词由用户维护；未经用户明确授权，不得新增、删除或修改提示词，规则变化也不得自动同步到提示词。

## 一、背景信息

知行分布式运行时（`distributed-runtime`）模块第 23 开发单元（surface 内容资产授权与生命周期治理）的实现约耗时 2 小时，后续审查与修复却耗时 4 天半。复盘表明，根因是进入审查时交付物仍不完整：审查阶段既在补做开发阶段本应完成的功能，又在处理大量遗留问题。

在审查阶段补开发，必须反复经历“发现问题—修复—构建验证—再次审查”，使原本一次可完成的实现工作额外叠加多轮审查与验证成本。本工作台用于把范围识别和实现完整性控制前移到开发阶段，确保进入审查时实现已经完整，审查只负责发现残余问题，而不是继续完成开发。

## 二、目标与边界

本工作台前移的是开发范围的识别与完整实现，不是把独立审查或最终验证搬到开发阶段。开发前必须依据架构、需求和上下游合同，明确本单元应完成的边界、功能链与异常场景；开发时一次性完成这些已知义务，不得把未考虑或未实现的功能留给审查阶段补做。

开发阶段只执行支撑当前实现所必需的直接验证，不进行重复的全量审查与重型验证。审查阶段只负责发现完整实现后的残余缺陷；本单元的已知范围必须在进入审查前全部落实，不能等到审查时才识别或补做。

开发清单只定义“必须交付什么”：每项写清功能范围、边界、场景、应实现行为及直接相关的测试代码，不登记“测试通过”“连续审查无问题”“达到可提交状态”等质量状态。勾选只表示对应实现与测试已经编写，不代表审查或最终验证通过。

### 架构与需求空洞裁决

1. 现有架构总纲、规格和边界能够唯一推出清晰、可行且无明显副作用的最优方案：这只是文档细节不足，应自行补齐并继续开发，不应停工。
2. 产品目标、用户体验、功能边界和外部合同已经明确，只剩架构或实现路径需要选择：这不是需求空洞。架构者必须以整体最优、长期可维护、可扩展且不留债务为唯一标准，自主完成架构决策、补齐设计并继续开发，不得把架构选择上抛给用户。
3. 现有权威来源无法确定产品应提供什么行为、体验或边界，且不同选择会形成实质不同的产品结果：这才是需要用户确认的需求空洞。必须停止并说明缺失的需求事实及各选择的产品影响，等待用户裁决；不得用架构偏好替代产品决策。
4. 是否需要用户裁决只看产品需求是否缺失，不看架构方案是否多、实现是否复杂或工程成本是否较高。若最优方案需要改变既定产品范围或外部合同，应按需求边界变化处理并提交用户确认。

## 三、用户提示词

### 3.1 生成开发清单

```
完整读取下一开发单元的架构总纲、可执行规格或执行计划、上下游合同与验收要求，确认单元身份和边界。存在架构总纲时以其为最高依据，开发范围与方案不得偏离架构设计；文档不足以确定边界时，明确指出架构空洞并停止定稿，不得用实现假设补齐。

按照本工作台“目标与边界”，把开发阶段必须完成的功能范围、生产端与消费端、状态与异常路径、边界条件、非默认场景及直接相关的测试代码，拆成有限、可执行的开发事项，写入动态区。明确不属于本单元的内容只写入“明确排除”字段，不得生成开发事项。每项只写清必须交付的实现与测试，不得写入审查轮次、验证结果或可提交状态；动态区不得沿用上一单元的分类或内容。

本任务只建立开发清单，完成后立即停止。
```

### 3.2 审查开发清单

```
不得沿用生成清单时的范围判断。重新完整读取当前单元的权威架构、可执行规格或执行计划、上下游合同与验收要求，审查动态区开发清单；目标是在清单定稿前收齐全部已知开发义务，避免后续审查才发现功能范围遗漏。

先从权威来源正向核对本单元全部适用要求是否已有开发事项，再沿每条功能链核对生产端、消费端、装配入口、状态与异常终态、直接相关的测试代码，以及适用的边界条件、非默认场景、并发、安全、资源和兼容性要求，最后反向确认每个事项都有架构依据且没有越出单元边界。

通过标准：本单元的全部已知开发义务均有明确落点；每项只描述必须交付的功能范围、边界、场景、行为和测试代码，内容有限、无重复、无歧义且可直接执行；不存在架构偏离、范围遗漏、范围越界或依赖实现猜测的事项。完成全部核对后，一次性向我报告所有问题和架构空洞，不得修改文档；没有问题时，明确回复开发清单通过。仅报告以下四类实质问题：偏离架构、遗漏开发内容、超出单元边界、开发事项无法执行。单纯润色措辞、设想没有事实依据的风险或增加非必要功能，不得作为问题。满足全部标准后立即停止。
```

### 3.3 按清单开发

```
动手，完成本单元开发。

开始前：
1、完整读取 `research/design/workbench/unit-development-workbench.md` 的静态规则、当前单元已经定稿的开发清单及其引用的权威架构文档。
2、严格围绕架构总纲、可执行规格和单元边界开发，不得偏离架构设计。发现疑似架构空洞时，按照 “# 单元开发工作台”文档的“架构空洞裁决”规则判断并处理。发现架构设计不是最优，或不同选择会带来明显副作用时，停止开发并说明。

开发要求：
1、先以顶级架构师、顶级智能体专家的身份思考代码组织与设计，注意宏观视角看整体架构、要可维护、可扩展、可插拔，要最佳代码实践方案。
2、按开发清单逐项完成生产实现、消费链路、边界场景及直接相关测试代码；完成一项立即标为 `[x]`。勾选只表示实现与测试代码已经完成，不代表审查或最终验证通过。
3、开发中发现清单遗漏了本单元必须实现的内容时，先补入清单再实现；不得擅自扩展单元边界。
4、渐进式实现、分步验证。

原则：

我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计。

验证纪律：
1、开发中只跑最小必要验证（类型检查 + 直接相关测试），修改边界只跑对应测试；单元收尾再跑一次受影响包全量测试，最终交付前再跑必要构建。禁止无新增价值的重复全量验证，禁止并行运行会互相清理或干扰产物的命令；失败先归因再重跑。目标是用最少的时间完成同等质量的完整验证任务，尽一切可能实现目标。
2、执行构建、包测、全测或 CI 验证前，先按任务与运行条件查 `research/design/workbench/verification-runbook.md`，命中记录时必须采用其中已验证的运行方式；若本轮确认失败源于运行方式而非实现，并因此需要重跑，正确方式验证通过后当轮登记。
3、注意避免陷入“业务代码或测试代码导致无限循环、Bash 长时间无输出”的情况；出现风险时先停止并审查原因，不得持续等待。

注意：
1、不要留下注释债务，不引用 `Phase-N`、`M-N`、`INV-N`、`ADR §N`、`§X.Y` 等会变化的标识符，只保留解释当前代码所必需的稳定注释。
2、全部开发事项均为 `[x]` 时，报告本单元开发完成并立即停止；不得自行重置动态区。
```

---

## 开发清单

### 当前单元

- **模块**：知行分布式运行时（`distributed-runtime`）
- **单元**：第 25 单元（S7）——Environment 与 workscene 接入
- **架构与规格来源**：`distributed-runtime-charter.md` §3、§5、§7、§9、§11、§13～§15；`specification.md` §1.1～§1.5、§3.1～§3.4b、§3.8、§4.1～§4.5、§5.1～§5.3、§6.1～§6.2、§7～§13、§15 第 25 项；`always-online-and-local-execution-requirements.md`；`workscene-management-architecture.md`（其中 raw-workdir 与独立 touch 表述由本单元目标规格取代）；`unified-core-and-access-surfaces.md` 的工作场景 owner、会话与接入面合同；第 24 单元已冻结的控制面、数据面、资源治理与装配边界
- **单元边界**：实现 executor 本地 `EnvironmentPort` 与 workspace binding 事实源、主模式 / 无场景的显式环境选择、跨机目录探测、workscene 设备域引用、锚点注册管理、会话 owner 进出、owner 环境要求与选机、manifest 冻结及 executor 开跑前 revision 复验；同时闭合本单元新增事实的崩溃恢复、保留上界及既有资源治理接入。单机与分布式只替换 adapter，真实路径始终留在目标 executor。
- **明确排除**：不实现第 26 单元 scheduler/job 产品闭环与旧投递退役；不实现第 27 单元 advancement 独立取证；不提前完成第 28 单元 memory/skill/workscene/task-list/segment 的统一 staged/control 发布改造或第 29 单元入口覆盖 lint；不开放第 30～32 单元本地域 owner、DeferredGlobalIntent、离线新会话与收编；不实现迁居、备份、服务生命周期或发布能力；不重做第 16～24 单元已经冻结的 manifest、matcher、mesh、资源治理与数据面协议，但本单元所有新入口和维护义务必须接入这些既有合同。
- **当前进度**：0 / 12（0%）
- **状态约定**：`[ ]` 未完成；`[x]` 已完成；`[!]` 存在阻塞

### 开发事项

| 编号   | 状态 | 开发事项                                      | 功能范围、边界与场景                                                                                                                                                                                                                     | 必须交付的实现与测试                                                                                                                                                                                                                                       |
| ------ | ---- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D25-01 | [ ]  | 闭合 Environment、workspace 与 workscene wire 原语 | 以已冻结的 Environment/probe 合同为基线，补齐唯一构造、摘要、签名、严格反序列化和字段反绑；first-party input 可携只含设备域引用的 `ExplicitEnvironmentSelection`，并与 input 同摘要、同准入、同重放，channel 不得构造。workscene 读面提供对象 revision。surface/host control 写只有在权威提交后返回完整 applied 结果；assignment 的 workscene staged 写只返回绑定本 assignment 的耐久 receipt，不得预报全局 revision 或已应用对象，其他 staged 域维持原合同。派生 `lastActiveAt` 不参与管理 revision；任何新 wire、锚点记录、日志与诊断都不得包含真实路径。 | 按规格以 principal 与 mutation 双判别的 overload 收敛 `GlobalStatePort.mutate`：control 的 create/rename/setWorkdir 返回完整 `WorksceneAppliedResult`，delete 返回被删身份与删除前 revision；仅 workscene staged 返回 `WorksceneStagedReceipt`。在 core/contracts/protocol 建单源 validator、规范摘要与错误分类并完整导出；把显式环境选择接入 ControlRequest、ControlRecord、RunJournal admitted 与重放全等判据。补错 principal/method、receipt 与 applied 混用、未知/缺失字段、错 schema/version、错设备/绑定/requestId/时限、channel 伪造选择、选择异载荷重放、签名篡改、重复字段、四类 control 结果重放、workscene staged receipt 重放、其它 staged 结果不回归、对象 revision/CAS、活动投影零 CAS 冲突及路径泄漏测试。第 28 单元才接通 workscene staged 最终 applied 回传，本单元不得提前改其生产发布面。 |
| D25-02 | [ ]  | 建立 executor 本地 workspace binding 事实源与管理入口 | workspace 的真实路径、规范化结果、五态探测和 revision 只归目标 executor；binding 只能经目标设备本地受信入口建立、命名和维护，`bindingRef` 稳定且删除后不复用。本地记录 revision 对全部管理变化单调递增；`workspaceBindingRevision` 只随路径等执行语义改变，单纯改名不得使在途执行失效。用户命名同设备内规范化后唯一，禁止从路径推导。目录以 append-only 日志为唯一权威，只有显式未建档状态可初始化为空；已建档后日志缺失或损坏必须 degraded / fail-closed，投影只可由日志重建。 | 实现耐久 binding 事实日志、tombstone、建档标记与可重建投影，以及共用同一日志/reducer/命名规则的本地 `WorkspaceBindingAdminPort`、host-only `WorkspaceBindingMigrationPort`、只读 EnvironmentPort 和真实 CLI/设置入口；AdminPort 不经 mesh 暴露，管理调用取得 environment-control 根 lease，实际步骤取得 workload-interactive permit，迁移端口只接受迁移 owner 并按既有 storage governor 锁序与叶级准入规则执行，等待容量时不得持目录锁。能力快照只发布 `bindingRef`、displayName 和 workspaceBindingRevision。补入口到目录的生产接线、本地增删改、同名冲突、revision/CAS、删除引用不复用、未授权/远程管理拒绝、迁移伪造 control 拒绝、首次建档各崩溃点、投影损坏重建、权威日志缺失/截断/坏尾及快照一致性测试。 |
| D25-03 | [ ]  | 实现有权目录探测与双 adapter                  | 锚点只为确切 device/binding/request 签发短时 `environment.probe` grant 与 environment-control 根 lease，并将 grant 反绑 lease 摘要；目标 executor 双验权后解析本地 binding、在唯一设备容量面准入五态探测并签名结果。同 requestId/grant 同载荷在保留窗内回放原结果，异载荷冲突；过期凭证只能回放既有耐久结果，错 executor/设备/binding/subject 或未授权调用零探测、零状态写入。 | 实现 probe owner/client、executor handler、有界耐久幂等日志与可重建投影及进程内/mesh adapter，共用同一 guard、validator 和结果合同；调用完成后幂等结算/释放 lease，窗外请求必须重签。补五态、探测不推进 binding revision、响应丢失重投、并发同键、异载荷冲突、重启及过期后 exact replay、保留窗压缩、投影损坏重建、过期 fresh/伪签/错 lease/跨设备/跨绑定、零 lease/permit 旁路及两种 adapter conformance 测试。 |
| D25-04 | [ ]  | 将 workscene 登记升级为锚点设备域引用         | `WorkScene`、持久化记录、查询 DTO 与管理写统一使用可选 `{deviceId,bindingRef}`，不再把 `workdir` 路径当新权威字段；create/rename/set/delete 留在锚点注册表并通过 global-write、requestId、anchorEpoch、domain/expected revision 幂等线性化。旧 raw-workdir 迁移必须保持原 sceneId、名称、createdAt 及会话/记忆关联；按规范路径分组复用 binding，并按 sceneId 顺序选择首个无冲突的旧场景名，整组均无可用名称或设备归属不可证时以无 workspace 形态导入并要求本地重新授权，禁止猜设备、静默派生名称或远程迁移。每个迁移批次只有 `open → activated｜abandoned` 两条耐久终态出边。 | 先发布兼容桥：严格双读但 cutover 前仍以旧注册表为唯一权威写面。实现 host-only、路径-free、受 storage governor 治理且可分页重驱的 legacy import；冻结旧注册表快照，在本地耐久迁移报告中生成不可从路径反推的随机 token，经本地 MigrationPort 转换路径并按同 migrationId/token 幂等导入，部分导入不生效。最终持旧写锁在本地复核源快照全等，以单个 cutover 提交绑定 token 与完整 import-set 后原子切换新权威；源变化先耐久写 abandoned 再开启新批次，重启只重驱 open，activated/abandoned 永不复活。回滚边界固定为 cutover 前可退旧版、cutover 后只可退能识别新权威的兼容桥。补身份/关联保持、同路径复用、异路径同名、归属可证/不可证、token 零路径泄漏、分页准入与各崩溃点、源快照竞争、废弃批次、终态保留/中间材料清退、重复导入/cutover、响应丢失、新旧版本交叉回读、两侧回滚边界、CRUD 及删除不触碰用户目录测试。 |
| D25-05 | [ ]  | 闭合 create/setWorkdir 的本机与远程管理链      | 目标 executor 是当前设备时，用户仍可在一次场景创建或改目录中直接给出本机路径：本地受信入口在进入普通控制 wire 前就地创建/复用 binding，再只提交设备域引用；工作区名称在原确认中明确，未单独给出时以用户已确认的场景名作建议名称，不增加强制前置步骤。跨设备时只能按设备名与工作区名称选择已认证快照中的既有 binding；需要新路径时唤起目标设备本地选择/授权，不得让模型或远端接入面先接收路径。锚点授权探测后，`directory` 接受，`missing` 接受并提示下次进入自动创建，其他三态硬拒。 | 让 WorksceneDirectory、RPC/facade、CLI 面板、智能创建与模型工具消费同一选择和探测合同；本机 raw path 必须由结构化本地入口在进入 RPC/mesh 前转换，远端 raw path/建绑稳定拒绝。补单机一句式创建/改路、已有 binding 复用、名称确认/冲突、本机与远程选择、目标设备本地授权引导、空列表引导、五态裁决、binding 改变、CAS 竞争、解绑、not-found/BUSY、提示文案和现有 CRUD 回归测试。 |
| D25-06 | [ ]  | 将 workscene 进出归还会话 owner               | 场景登记仍属锚点；enter 让目标会话 owner 取回或创建 `session-meta.sceneId` 固定的场景会话，exit 只切接入面指针。正常 turn 沿既有提交更新活动时间；enter 更新进入后的场景会话，exit 在解除绑定前更新离开的场景会话。workscene `lastActiveAt` 只取同场景会话活动最大值的锚点侧可重建投影，不设独立 touch 写、不推进管理 revision，也不得因投影落后阻断进出。 | 将 workscene.enter/exit、`/work`、`/exit`、选择器、observer、当前指针、场景会话创建/恢复和 per-scene 最近活动投影接到现有 session owner 路径；选择器只展示设备与工作区名称，活动投影复用注入 storage governor 的 DurableProjectionIndex。补场景不存在/删除竞争、重复进出、owner/anchor 重启、多会话最大值、投影缺失/落后/损坏受治理重建、投影变化零 CAS 冲突、observer 竞态、多接入面、退出 fallback、排序、零维护旁路及现有会话/命令回归测试。 |
| D25-07 | [ ]  | 由显式选择与 workscene 派生环境要求并确定性选机 | 环境来源优先级固定为本次 first-party input 的显式选择 → 当前 workscene → 任务/会话冻结要求；同层冲突拒绝或询问。显式选择与 admitted 同步耐久，owner 选机时从已认证目录冻结最新 binding revision；主模式或无场景输入未选择 workspace 时明确生成无 workspace 要求，禁止从进程目录、启动参数或宿主配置暗取默认路径。场景有设备域引用时生成 workspace 硬约束；无引用时不虚构 device/binding，由其余要求、在线能力和稳定亲和选机。无匹配时以既有 queued 权威事实排队并说明缺口，能力变化只作唤醒；多候选按冻结策略选择，语义不足时询问，禁止猜测或静默回落。 | 在 first-party 会话入口、owner/组合根建立显式选择准入、唯一 `ExecutorSelector`、环境要求派生入口及能力目录变化唤醒接线；选定 executor 后只冻结实际存在的 workspace 要求及其最新 revision。补主模式/无场景显式 workspace、未选择时无 workspace、选择随重启/重派全等、来源优先级与冲突、channel 拒绝、禁止 cwd/config 回落、有/无 workscene、错设备/缺 binding/离线/撤销/快照不一致、排队后上线/建绑/改路/解绑唤醒、零/多候选、稳定亲和、无第二队列及同机/跨机等价测试。 |
| D25-08 | [ ]  | 开跑前复验 binding revision 并按本地路径装配   | executor 在 `received/started` 与真实副作用前依次完成现有 activation/dispatch/matcher 校验；有 workspace 要求时再由本地 EnvironmentPort resolve+probe，revision 漂移、binding 消失或硬拒五态以未启动拒收，`missing` 按既有策略创建后使用。无 workspace 要求时必须跳过解析，不制造默认路径，以无显式工作根形态装配。 | 有绑定时将 absolutePath 只作为本机 runtime/PathGuard 工作根注入；无绑定时沿既有 powerProfile 剔除依赖工作根的文件工具。远端 runtime 不读取锚点注册表或旧本地场景目录；补有/无 workspace、directory/missing、错 revision、映射抢跑、硬拒五态、拒收后重排、零 started/零副作用、文件工具剔除及真实工作根测试。 |
| D25-09 | [ ]  | 完成角色装配、离线能力矩阵与生产切换          | executor 持 EnvironmentPort、WorkspaceBindingAdminPort、WorkspaceBindingMigrationPort 与 probe handler，锚点持 workscene 注册、grant/lease 签发和迁移终态，会话 owner 持进出与显式环境选择语义；single-machine 与 distributed 使用同一业务实现和端口接缝。设备唯一 arbiter/storage governor 先于 binding 日志、投影、迁移器和 probe 打开并完成注入。锚点不可达时 workscene 注册管理明确不可用且不产 DeferredGlobalIntent，未启用角色零加载零监听。 | 在 CLI 单一组合根接入本地 binding 管理入口、各 owner、资源治理、adapter、能力变化唤醒、启动恢复、停止与失败回滚，清除生产路径中的跨设备 raw-workdir、cwd/config 默认 workspace 旁路和空 `workspaces` 发布；补 executor-only、anchor-only、single-machine、anchor+executor、断线/重连、角色关闭、治理未装配 fail-closed、启动失败逆序回滚和离线能力矩阵测试。 |
| D25-10 | [ ]  | 建立第 25 单元跨链与既有能力回归闭包          | 用同一有限套件贯穿“本地管理入口→binding→能力发布→input 显式选择/workscene→owner 选机/排队唤醒→manifest 冻结→executor 复验→runtime 工作根”及“管理探测→锚点提交→会话 owner 进出”；同时覆盖无 workspace 装配、单机一步式路径、路径保密、资源治理、耐久恢复与有界保留、revision 竞争、旧注册表迁移/cutover 和 local/mesh，不把组件 happy path 当作单元验收。 | 提供两种 adapter 共用的 Environment/workscene conformance、wire 路径扫描、错设备/绑定/revision/lease 对抗、control applied 与 staged receipt 分层、主模式显式选择、单机与远程 setWorkdir、排队唤醒、无 workspace、binding 日志 fail-closed 与投影重建、probe 幂等保留、legacy open/activated/abandoned 与 cutover/回滚、资源 lease/permit 零旁路、离线矩阵和崩溃/重放用例；同步受影响的 RPC/CLI/server golden 与 workscene 管理、场景运行时、权限/PathGuard 回归测试，证明单机零新增概念且第 16～24 单元合同未被削弱。 |
| D25-11 | [ ]  | 清退跨设备 raw-workdir 控制载荷并同步声明面    | `PostTurnControlIntent`、session wire 与远程场景管理不得传递或要求真实路径；统一为设备域引用，内部 `bindingRef` 不进入产品文案。本机路径只由当前设备的结构化受信入口消费并在普通控制 wire 前转换，单机用户无需先学习或手工建立工作区；远程模型只可按设备与工作区名称选择，新增路径须唤起目标设备本地授权。同一 turn 的 last-wins、冲突记录、能力门和确认边界保持不变。 | 同步 core event、RPC payload、CLI accumulator/consumer、workscene 工具与 `WORKING_MODE_TEXT`，删除 wire raw path、远端“显式目录路径”和面向用户的 bindingRef 承诺，接通本机路径选择与 first-party 显式环境选择；更新 byte-equal/golden，并补本机路径零上 wire、远端路径拒绝/本地授权引导、主模式选择、同/异 kind 冲突、无 post-turn capability、绑定/解绑及模型声明与真实工具能力一致性测试。 |
| D25-12 | [ ]  | 保留 workscene 生命周期原子链与删除闭包        | enter、setWorkdir、remove 必须继续位于同一场景操作链；setWorkdir/remove 在变更前 quiesce 场景运行态，阻止新会话、turn 与 observer 滑入并等待占用释放。删除须收敛登记、场景元数据、记忆与会话，但绝不触碰用户 workspace；权威拆分不得产生旧目录 runtime、已删除场景重入或孤儿数据。 | 将现有 per-scene 串行、`quiescePrefix`、BUSY 映射、释放顺序和删除级联迁移到锚点注册与会话 owner 的新边界；补 enter/setWorkdir/remove 全交错、creating/pending/observer/grace、落盘失败、释放失败、重复删除、锚点/owner 重启及用户 workspace 不删除测试。 |
