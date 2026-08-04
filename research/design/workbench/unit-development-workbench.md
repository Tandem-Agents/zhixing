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

### 交付优先级与扩张门禁

开发清单只承载当前单元的**最小完整产品范围**：权威来源明确要求的核心功能，以及缺少就会阻断核心使用、破坏既定产品体验或违反冻结合同的直接依赖。范围内必须好用、完整并采用最优架构；“最优”不得被解释为增加功能、预建未来能力或扩大验证设施。

任何新增事项都必须写出权威来源和当前必要性。非核心增强、未来单元能力、通用化预留、纯观测/benchmark、诊断平台、推测性防御和非必要重构不得进入开发事项；可以作为未来建议，但不得阻塞当前单元。无法判断的是产品范围变化时才交由用户确认，不能用架构偏好自行扩面。

清单定稿和开发完成后立即进入下一阶段，不得因“还可以更完整”反复扩充已经闭合的范围。

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
先按本工作台维护原则处理动态区：当前单元为空时直接继续；仍登记上一单元且全部开发事项均为 `[x]` 时，先重置动态区并保留固定骨架，再生成下一单元清单；存在 `[ ]` 或 `[!]` 时立即停止，不得清空旧内容。

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

```text
目标：通过多轮“独立审查—集中修正—受影响范围复审”，将当前单元开发清单定稿；一次收齐架构总纲、执行规格和单元边界已经确定的全部开发义务，确保后续审查只需寻找实现缺陷，不再补做已知功能。

首个动作及每次续跑或历史压缩后的首个动作：读取本工作台静态规则、当前开发清单及其已列权威来源，只依据文档中的当前状态继续；不得沿用生成清单时的范围判断，也不得重做已有事实未变化且已通过的局部复审。

进度反馈：首次读取后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，以百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮或单项进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 首轮从权威来源正向枚举全部适用义务，再沿每条完整功能链核对生产端、消费端、装配入口、状态与异常终态、边界与非默认场景及直接相关测试，最后反向确认每项都有架构依据且未越出单元边界。整轮完成后一次性归并同根问题，不得边发现边零散修补。
2. 只修改开发清单，按根因集中修正范围遗漏、架构偏离、范围越界和事项不可执行；不得修改实现或运行构建、测试。修正后只复审变化项及其直接交界，未受影响且事实未变化的结论继续复用；出现反证时扩大受影响范围，不得让历轮问题无依据消失。
3. 每个新增或扩写事项都必须同时反绑权威来源与当前单元必要性。无法证明“不做就会阻断当前核心使用、破坏明确产品体验或违反既定合同”的未来能力、通用化预留、纯观测或 benchmark、诊断设施、推测性防御和非必要增强，一律排除，不得以“更完整”推动清单无限扩张。
4. 持续循环至全部实质问题闭合。准备封版时，对同一份未修改清单执行一次冷启动对抗复审，不得复用前轮结论：分别从“权威要求是否全部有落点”“完整功能链是否存在断点”“事项是否越界或缺乏当前价值”三个对立视角重新推导应有范围，并与清单及明确排除项双向对账。发现真实缺口后必须修正并重新执行本步骤。

只有按本工作台“架构与需求空洞裁决”确属需要用户确认的需求空洞时才暂停；其余清单组织和架构选择自主按锁定范围内的最优方案收敛。

完成条件：同一份未修改清单通过冷启动对抗复审；当前单元全部已知开发义务均有有限、无重复、无歧义且可直接执行的实现与测试落点，明确排除项有事实依据，不存在架构偏离、范围遗漏、范围越界、实现猜测或未处置反证。满足后明确回复“开发清单通过”并立即停止，不得继续增加审查视角或扩充范围。
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

### 3.4 专项循环审查补充开发清单

```
目标：把开发清单中的 D25-F08、D25-F09 补充完整，在开发前一次收齐两项功能的全部已知开发义务，避免实现完成后才由独立审查发现功能遗漏。单元边界、架构一致性和可执行性是必须遵守的限制条件，不得以它们代替功能完整性。

只读取 D25-F08、D25-F09，以及判断当前疑点所需的最小事实；不得重审其他开发事项，不得重新横扫整个单元或无关架构来源。只修改这两项清单内容，不实现代码、不运行构建或测试。

持续执行：

1. 审查 D25-F08 是否完整闭合：唯一生产组合根、本机受信入口、排他 bootstrap、唯一 owner/arbiter、稳定操作身份与重放、reset 展示—确认—恢复链，以及首装、并发、响应丢失、重启和路径保密场景。
2. 审查 D25-F09 是否完整闭合：两阶段恢复合同、真实 registry golden、逐分支结构账本，以及能够识别合同漂移、分支缺失和错绑的机械验收。
3. 整轮审查后一次收齐问题，按根因集中修正 D25-F08、D25-F09；收敛过程中只复审发生变化及受其影响的部分，未受影响的结论可临时复用，但不得据此直接判定封版。
4. 持续循环，直到两项的生产端、消费端、装配与所有权、正常与异常终态、重试恢复、边界场景及直接相关测试均有明确落点，同时不存在范围越界、架构偏离、重复、歧义或依赖实现猜测。
5. 准备封版时，对同一份未修改终稿执行一次冷启动对抗复审，不得复用前述结论：D25-F08 从 client prepare、host prepared/committed、权威结果、completed 回放、终态确认到 checkpoint 压缩，逐个核对 owner、线性化点、响应丢失、任意边界崩溃及重启收敛；D25-F09 从规格合同、production registry、runtime descriptor、scenario adapter、validator/reducer 到唯一 recovery owner 逐段核对，确认每个分支均由真实生产事实产生并能识别缺格、错绑和绕过。冷启动复审发现问题后必须修正并重新执行本步骤，任何修改都会使本次复审失效。

只有出现无法由现有产品目标确定的真实需求选择时才暂停；其余架构选择按整体最优且不留债务的标准自主决定。

完成条件：同一份未修改的 D25-F08、D25-F09 通过冷启动对抗复审；执行者仅凭两项内容就能一次性完整交付功能及直接相关测试，不需要自行补充范围或猜测关键方案；后续独立审查只需寻找实现缺陷，不应再补做已知功能。满足后明确回复“D25-F08、D25-F09 开发清单通过”并立即停止。
```

---

## 开发清单

### 当前单元

- 模块：分布式运行时（`distributed-runtime`）
- 单元：第 28 单元（S7）— 编排、memory、技能与生命周期接入
- 架构与规格来源：`distributed-runtime-charter.md`（唯一 owner、staged/commit 边界、资源治理、双拓扑同构、最小完整产品与不变量）、`specification.md`（SessionStatePort / GlobalStatePort、mutation 守卫、MutationBatch 与 publish-decision、落点矩阵、资源终结、文档影响及第 28 单元验收）、`file-based-orchestration-infrastructure.md`、`subagent-execution.md`、`memory-system.md`、`work-mode.md`、`skill-system.md`、`agent-runtime-lifecycle.md`、`transcript-persistence-and-attention-window-architecture.md`、`workscene-management-architecture.md`，以及第 12、18、25、26 单元已冻结的提交发布、父子资源租约、workscene applied result 与既有 scheduler staged 链；第 18 单元排除项 X18-02 在本单元按重开条件转为必须闭合的 Task 子 agent 与编排节点子租约接入义务。
- 单元边界：把当前 run 内的 memory、skill、workscene、task-list 与 segment 权威写统一接入 assignment staged overlay 和 owner 提交后的耐久发布链，把写类 lifecycle 的外部副作用移动到权威提交之后；保持个人与 workscene 记忆隔离、技能渐进披露和既有管理体验；让 Task 子 agent 与文件编排节点在父 run 下取得、使用并终结有界子租约。run 外管理入口仍走 owner/anchor control，读取入口走权威 query 或只读资产投影，单机与 mesh 共用同一合同和业务实现，不新增产品功能。
- 明确排除：第 29 单元的全入口覆盖 registry/lint、广泛模块文档同步和旧入口集中清理；第 30～32 单元的本地域 owner、DeferredGlobalIntent、离线会话与收编；第 33～38 单元的迁居、备份、服务生命周期与发布；重建资源 governor、MutationBatch、GlobalStatePort、workscene registry 或现有编排 DAG；编排循环、动态分支、跨 run/跨重启编排、后台执行、人工门和通用重试；新建通用 outbox、事件总线、监控、诊断、benchmark、性能采集、未来扩展框架或非必要 UI；改变 memory、skill、workscene、task-list 与 segment 的既有产品能力和确认边界。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`9/9（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D28-01 | 建立 assignment 作用域的统一 staged 写、receipt 与 overlay 接缝 | 将当前 schedule 专用 run stager 泛化为类型受限的 session/global assignment 端口，复用 ledger 的有序 `staged-mutation` 与既有 MutationBatch；operationId 必须来自耐久 tool call、segment/lifecycle 或编排操作身份，不得以进程 ordinal/random UUID 充当重启身份。统一 assignment-local receipt 为 `{requestId, recordSeq, mutationDigest}`（workscene 沿用命名别名），同步修正会在提交前返回全局 revision 的 staged 结果合同；任何域都不得伪造 applied/revision。conversation/job 按 execution 联合严格路由，global 写绑定当前 anchor fence，错 assignment/conversation/run/域/capability/fence 在追加前拒绝；Task 子 agent 与编排节点继承同一 assignment、query、overlay 和带稳定 lineage 的 operation namespace，不得另开事实源或丢失当前 staged 写。task-list、segment、memory、skill、workscene 按 recordSeq 提供 read-own-writes overlay，assignment 外只见权威状态，同键全等重放原 receipt、异载荷拒绝。补全部 mutation kind、双 execution、父子 run、并发顺序、响应丢失/重启重放、错绑零追加、receipt 严格 codec 与 overlay 隔离测试。 |
| [x] | D28-02 | 完成 MutationBatch 封包、owner 原子决策与幂等发布 | sealed 前按规范顺序导出不可变 MutationBatch，先上传 batch 本体及技能内容等全部 dependency artifact，再允许 owner CAS；owner 在 CAS 前一次性校验所有 global 项的 anchorEpoch、对象 CAS、业务前提和资产闭包，并在提交 run 的同一 CommitEnvelope 写入逐项 granted/conflicted、目标 revision 与 session/global 计数。granted 自该点不可撤销，发布只由既有 owner 日志重驱唯一锚点/会话物化 adapter；conflicted 为终态、不回滚 committed run，并由 conversation 的 FinalFrame/PublishConflictNotice 或 job 的既有维护投影给出可行动反馈。workscene granted outcome 同时固化首次生成的完整 `WorksceneAppliedResult`，重放逐字复用，非 workscene outcome 禁止携带；publish progress 只表示幂等派生完成，不成为第二事实源。补缺 batch/依赖、全量预检、部分冲突、CAS、决策前后与逐项物化崩溃、响应丢失、重复发布、重启续发、workscene exact replay 和损坏 outcome 拒绝测试。 |
| [x] | D28-03 | 将 task-list 与 segment 写接入会话 staged 链 | 将 TaskListService 的 run 内 `set` 与 SegmentManager 的 run 内 `appendSegment` 从 ConversationRepository/cache 直写改为 `task-list-op` / `segment-append` stager；`/task` 以及 `/clear`、`/compact` 等 run 外 task/window 管理仍只经 SessionStatePort/ControlCompletionPort control，不得误入无 assignment 的 stager。运行中读取由权威快照叠加本 assignment overlay，工具与段切换判据可读己之写，但缓存、订阅者、CLI/RPC、段投影和其他 run 在 commit 前零变化；commit 后按 batch 顺序一次更新权威投影并发通知。工具以产品语言反馈“本轮成功完成后生效”，不得暴露 staged 术语或声称已持久化；failed/cancelled 整批丢弃，uncertain 不可见并等待裁决，无 conversation 的临时 run 明确拒绝且零追加。补同 run 连续替换、跨 run 隔离、run/control 竞争、手动 compact、commit 可见性、取消/失败/uncertain、响应丢失、段切换警告语义与既有 task-list 产品回归测试。 |
| [x] | D28-04 | 补齐并接入 memory 的作用域、读写合同与锚点物化 | 以既有产品能力为闭包修正 memory wire/port：冻结 `MemoryScopeRef = {kind:"personal"} | {kind:"workscene"; sceneId}`；`memory-append` 增 `scope` 与 update 时必带的 `expectedDigest`，新增 `{kind:"memory-delete"; scope; domain; category?; id; expectedDigest}` 和 `memory-list` query。assignment scope 由静态会话身份派生并由 guard 反绑，跨 scope 需命中精确 `memory-domain` capability、不得用通配或模型自报；保留 save/update/search/list/delete、三域 flush 与 main 对 workscene 记忆的按需只读检索。id/category 严格校验并收口到目标根，GlobalQuery 返回无主机路径的逻辑 DTO、对象 revision/digest 和必要统计，不得把 `MemoryEntry.filePath` 上 wire。memory 工具、MemoryFlush 及只读 workscene 查询只依赖 query/stager，executor/runtime 不持有可写 MemoryStore；锚点 adapter 是三域唯一文件/索引物化点，同 run overlay 合并暂存 upsert/delete，工具只以产品语言说明对应记忆会在本轮成功完成后生效；workscene 删除投影只清理该 sceneId 的记忆作用域且不得触及 personal。补个人/workscene 隔离、save/update/list/search/delete、三域 adapter conformance、错 scope/capability/CAS、路径穿越与路径零泄漏、场景删除清理、重放/冲突、提交边界、重启续发、同 run overlay 与 executor 零可写 Store 测试，并同步规格及 memory/work-mode 中被改写的合同。 |
| [x] | D28-05 | 将技能目录、内容资产、管理写与 usage 接入全局权威边界 | 冻结 path-free `SkillCatalogEntry`，完整承载 own/linked 的 `id/name/description/source/mode/pinned/disabled/createdAt/usage/contentRef/revision/digest`；runtime 的用户技能 top-N、`load_skill`、动态 slash source 与 `/skills` 只经 GlobalQuery + ArtifactStore 读取，不因发现缺省状态而写磁盘，catalog revision 驱动既有 onWindowOpen/命令 refresh，窗口内 prompt 保持 byte-equal。保留现有视图语义：builtin 仍来自包内只读注册集、独立预算池且零 usage/管理/slash 记录，own 同名遮蔽 builtin；用户池按 mode/disabled/pinned/usage 排序，补全剔 disabled，管理全集含 disabled 与 usage；全链只用 Unicode-safe `skillNameToId`，与核心命令重名时仍由核心命令优先。`save_skill`/`admit_skill` 保留用户显式同意、影响确认、内容扫描、独立裁决和 token/digest 反绑，把规范化 SKILL.md 先作为 immutable artifact 加入 batch dependency，再暂存 create/update/admit；`setState/archive` 等 run 外管理只经 control。将 own/linked 命中写冻结为 `{skillId, occurredAt, hitDelta:1}` 的幂等 usage delta，每次成功加载以稳定 requestId 恰一次累加，禁止 executor 直接改 usage/index；同 run 新/改技能由 overlay 读取同一 artifact，工具只以产品语言说明本轮成功后入库，不虚报库已更新。granted 后锚点按对象 CAS 唯一物化内容、状态、索引与 usage，冲突/失败/取消/uncertain 清理未引用临时件且零全局可见。补目录/全文/双池 top-N、窗口/命令刷新、slash 冲突/管理视图、builtin 负向边界、save/admit/control/usage、确认取消、恶意内容与错 token、依赖缺件、CAS、并发 usage、响应丢失/崩溃、临时件回收、overlay 与现有技能体验回归测试，并同步规格与 skill 文档中的目录/usage 合同。 |
| [x] | D28-06 | 将 run 内 workscene 管理接入 staged/applied 双阶段 | `workscene_*` run 内 create/rename/setWorkdir/delete 只经 assignment stager，确认摘要与 mutation digest 全等反绑，返回通用 staged receipt；工具、prompt 和 post-turn accumulator 不得把 receipt、overlay、预计 sceneId/revision 表述为已应用或提前切换 runtime，enter/exit 的合法 turn-boundary 意图保持不变。CLI/RPC 等 run 外入口仍经 control。现有对象的同 run 多次变更按 recordSeq 在 overlay/owner 预检中串行，新建对象在 applied 前不得供依赖其权威 sceneId 的后续操作使用。owner 决策时生成并固化 `WorksceneAppliedResult`，权威 CommitEnvelope 落定后只据该结果给出产品反馈及必要的本地 runtime 转换；失败、取消、uncertain、冲突或响应丢失不得重生结果、查列表猜对象或复活管理写的旧 post-turn 旁路。补四类操作、连续变更、create 后依赖拒绝、确认/取消、commit/冲突、响应丢失/重启、用户文案、旧管理旁路零可达、enter/exit 回归与双拓扑全等测试。 |
| [x] | D28-07 | 收口 lifecycle 与维护写的权威时序 | 对生产注册表中的 AgentRuntime 四阶段、SegmentTransition 三阶段和 CleanupRegistry 消费者建立封闭分类：只读 prompt/context 注入与本地资源释放保持原时点；MemoryFlush 的提取结果只形成当前 run 的 memory staged 记录，segment 元数据走 D28-03，真正全局/会话物化及成功反馈只由 commit/publish 事实驱动；journal retention 等 run 外全局维护仅由锚点 host 的 control/maintenance owner 执行。failed/cancelled 不触发物化，uncertain 等裁决，恢复只重驱未 settled 义务；保留 hook 隔离、deadline、abort、warning 与非关键失败策略，不新增 hook 事实源或通用 outbox。同步 lifecycle/transcript 中直接落盘和触发时点描述，补各生产 hook 正常/异常/取消、commit 前零外泄、commit 后恰一次、响应丢失/重启及只读 hook 回归测试。 |
| [x] | D28-08 | 为 Task 子 agent 与编排节点接入父 run 子租约和设备容量 | `Task → runChildAgent` 与文件 DAG 的每个实际 agent node 均须在 provider 前，以父 reservation + 耐久 toolCallId 或 definition/node/attempt 派生稳定 `orchestration-node` workload，从父 ResourceLease delegation 取得有界 child lease；子 run 的全部 modelCallMetering 改绑 child，不得继续继承父 meter 直接计量，子工具的权威读写仍进入 D28-01 的父 assignment/MutationBatch。每个实际本机执行批次另取唯一 `workload-orchestration` device permit，等待容量时不持 authority/manifest/artifact 锁，网络、用户交互及闲置 lease 期间不占 permit，逻辑租约不得冒充物理容量；装配/工具选择/静态校验失败在 provider 前发生且零 child/permit。completed/failed/aborted/timeout 均先收敛 usage、settle/release child 并释放 permit，再允许父终态；获取/终结响应不明依既有日志与水位回放或 reclaim，重放不得产生第二 active child。保留有限 DAG、fail-fast、abort 隔离、结果只入父 bundle和无跨重启编排，补两类入口、稳定身份、预算/受众/父绑定、子工具 staged 写、并发/公平/容量、provider 各终态、网络等待、崩溃恢复、子先父及 X18-02 重开测试。 |
| [x] | D28-09 | 完成生产装配、结构隔离与双拓扑验收代码 | 在单机与 anchor+executor 组合根注入同一 assignment stager/overlay、GlobalQuery、publish owner、memory/skill/workscene 锚点 adapter、commit consumer、ResourceReservationPort 与 DeviceCapacityArbiterPort；同机只折叠传输，不折叠角色所有权，未启用角色零实例/零监听。executor/runtime-host/orchestrator/tools 生产图只能持只读 query/asset facade 与 assignment stager，不得构造或可达可写 MemoryStore、SkillStore、Workscene registry、ConversationRepository 写面；`workscene_memory_query` 亦不得按场景 new MemoryStore。anchor adapter 是全局唯一物化入口，run 外 control 与 run 内 staged 不互降级，既有 scheduler staged 基础设施不分叉。补现有模块测试代码、两拓扑 contract conformance、生产依赖可达性断言、角色缺失/断线重连/进程重启、五域 commit/failed/cancelled/uncertain、路径零泄漏、workscene 零伪 applied、技能资产闭包及 Task/DAG 子租约的集成测试；不得提前建设第 29 单元的全入口 registry/lint。 |
