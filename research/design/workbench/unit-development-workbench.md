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
- 单元：第 26 单元（S7）— scheduler 与 job 产品闭环
- 架构与规格来源：`distributed-runtime-charter.md`（scheduler/job 权威、耐久事务、产品体验、故障与不变量）、`specification.md`（摘要与类型合同、scheduler/job/delivery 协议、状态机、落点矩阵及第 26 单元验收）、`scheduler-architecture.md`、`persistent-service.md`、`message-outbox.md`、`remote-confirmation-execution.md`、`remote-interruption-execution.md`，以及第 14、15A、15B、24、25 单元已冻结的 JobJournal、Delivery、job interaction、治理与环境合同；旧 scheduler 的进程内执行与公开 DeliveryPipeline 生产机制由本单元目标规格取代。
- 单元边界：将 scheduler 的 CRUD、查询、手动运行、取消和定时触发整体接入锚点唯一 TaskDefinition/JobJournal 权威；用户 job 经既有 assignment 执行链运行，system job 仅在锚点本地运行；从 occurrence 冻结投递计划、来源与 responder，提交时原子写入权威 Delivery 流；闭合状态通知、missed/uncertain 和 job 交互凭证分流；安全排空旧投递队列后退役旧 Scheduler 直执行及公开 DeliveryPipeline/queue 生产路径。
- 明确排除：第 27 单元 advancement 与独立取证；第 28 单元编排、memory、skill、task-list、segment 等其余 staged/control 接入；第 29 单元全入口覆盖 lint；第 30～38 单元本地域、迁居、备份、常驻服务、升级发布能力；新增调度类型、渠道或 webhook 平台、通用迁移框架、诊断平台、遥测、benchmark、性能采集与非必要重构；重做第 14、15、24、25 单元已经冻结且本单元不需要变更的底层协议。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`11/11（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D26-01 | 冻结 scheduler 产品合同与受信入口 | 将用户任务合同收口为显式 user `TaskDefinition` 白名单：只允许 `agent-turn`、现有 once/interval/cron 与 `none/channel/webhook` 投递；channel 保留 threadId，webhook 只持 `SecretRef`。`origin`、`interactionResponder`、`createdInTurn`、id/revision/time/state 与 system 身份只能由锚点从已认证 ingress 生成，surface/RPC/模型输入不得自报；外层 state 与兼容 `spec.enabled` 必须严格一致。实现统一严格 codec、摘要和 DTO/领域投影，并补未知/多余字段、非法 schedule、秘密/路径泄漏、伪造权威字段/system、线程绑定及兼容输入测试。 |
| [x] | D26-02 | 建立锚点唯一任务与 job 权威并切换旧任务状态 | 在锚点生产组合根装配唯一 scheduler/job owner、可重建 TaskDefinition 目录、逐任务 `JobJournal`、timer/recovery 与 GlobalStatePort/ControlAdmission adapter；新写入只进权威日志，`scheduler.json` 仅由 `JobCompatibilityProjection` 单向生成。首次切换以稳定身份幂等导入旧 user 任务，保留 taskId、计划、启停、origin、createdInTurn 与下一未来触发；旧 webhook endpoint 先原子收口到 SecretStore，旧 system 行交由 host-only 注册，缺失的可信 `interactionResponder` 不得从投递目标猜造，旧运行摘要不得伪造成 occurrence。覆盖空库、部分导入后崩溃、重复启动、异载荷冲突、秘密迁移响应丢失、损坏 fail-closed、投影重建、单机/角色装配和零双 writer/owner 测试。 |
| [x] | D26-03 | 接通任务 CRUD、查询和用户入口 | 将 schedule create/update/set-state/delete/list/run/abortRun、模型工具、RPC/facade、CLI 与 turn-context 统一接到锚点权威；写入绑定 requestId、anchorEpoch、taskRevision 与 payloadDigest，现有 partial update 由 adapter 基于当前 revision 形成完整 spec，conversation/job 内 schedule 写走 staged→commit publish，失败/cancelled/未裁决 uncertain 零外泄。本地域离线时按当前能力明确不可用，不得提前实现第 31 单元的 `DeferredGlobalIntent` 或伪生效。手动 run 的耐久受理先返回/发布稳定 jobRunId；仍需等待结果的现有 facade 只从该 job 的权威状态与结果投影完成，断线不取消、重试不新建 job，abortRun 和后续状态只认该身份。list、TaskStatusSummary、started/completed/disabled 事件均由 TaskDefinition/JobJournal 投影且只暴露 user 任务，排队、不可用、失败和 uncertain 使用现有低术语、可行动表达。补幂等回放、revision/epoch 冲突、越权伪造、响应丢失、离线拒绝零残留、投影重建、system 隔离及现有入口兼容测试。 |
| [x] | D26-04 | 以耐久 occurrence 统一手动与定时触发 | 手动 `job-run` 与锚点 timer 都先在 `JobJournal` 以稳定 jobRunId 原子写 occurrence、queued state 与 admitted；手动 admitted 携首次耐久 ingress，定时 admitted 明确无 ingress。occurrence 只冻结 taskRevision、scheduledFor 与 deliveryPlan；该 taskRevision 必须反绑不可变 definition revision 中的 origin、interactionResponder、createdInTurn，禁止另存会漂移的来源副本。实现每 task 至多一个非终态 occurrence：queued 在下一到点可过期让位，已派发或 uncertain 时只耐久记 missed；离线错过以本次 scheduler ready 时刻为固定锚，在线拥塞不得随 `now` 漂移成 missed；用户 missed 不补跑并推进下一未来时刻，system missed 仅合并一批。由终态日志派生并保留既有有界失败策略：成功清零错误计数，失败按指数退避与 Full Jitter 推进后续触发，达到阈值原子停用并通知，once 成功或错过后终止；单任务失败不得阻断其他任务。重复 tick/手动重试、时钟回拨、启停/删除与恢复均幂等，删除旧 scheduler 直调 runtime。补手动/定时竞争、once/interval/cron 边界、在线拥塞与离线错过、退避/停用、失败隔离、响应丢失和各耐久边界崩溃测试。 |
| [x] | D26-05 | 将 user job 接入既有 assignment 执行与提交链 | 从 queued occurrence 生成去敏 `JobExecutionInstruction` 与 `ExecutionManifest`，经既有 selector、资源治理、InProcess/Mesh dispatcher、executor ledger 和 JobCommitFence 执行；指令只含 action，不携投递目标、秘密或锚点权威状态，无 workspace 时不得暗取宿主 cwd。owner 按 `matchManifest → 候选 → validateDispatchBinding → reserve+assigned` 原子顺序派发，executor 复用同一 guard；可恢复缺口保持 queued 并由能力变化唤醒，确定性硬缺口 failed。补装配缺失、能力/版本/资源不匹配、重复/冲突派发、started/completed/ack 丢失、迟到 bundle、错域/epoch/fence、提交幂等及 local/mesh 测试。 |
| [x] | D26-06 | 机械分离手动 ticket 与定时 channel grant | 以 `JobJournal` 的 durable admitted/trigger 事实建立唯一 operations router：手动 assignment 只可向原始已认证 surface 签发 `run-interact`/abort ticket；定时 occurrence 不签数据面票据，只可由 owner relay 向冻结的 origin/responder 发送 challenge 并接受 channel grant。签发端、executor guard 和恢复 owner 共用同一谓词；缺来源或跨路径凭证必须在任何 `interaction-finished` 前拒绝且零追加，grant 义务只可由全等 answered mirror 或 cancelled/expired/auto-resolved 等枚举终态关闭，异常单项不得阻断 relay 继续消费其他 stream。复用第 24 单元已冻结的 token/grant 与 relay conformance，只补本单元新增的手动/定时生产路由、缺 responder、跨路径零追加、回调丢失重驱和排除项重开机械门禁。 |
| [x] | D26-07 | 闭合 job 生命周期、取消、uncertain 与恢复 | 将 `job-cancel`、任务删除、执行超时及 owner/executor 恢复接入既有 38 行 user-job 状态机：queued 原子取消，dispatched/running 走 cancel-requested 与唯一 owner cancellation dispatcher，超时只能签发耐久取消事实、不得以进程内 abort 伪造终态；completed 只重提交，可证未 started 才重派，结果不明进入 uncertain。uncertain 暂停该任务后续触发并只记 missed，迟到合法 bundle、终结证明或用户三选裁决按打开 fact 唯一收束后恢复。保证禁用不取消已派发项、删除收束全部在途项，迟到结果、取消/封包/dispatch-conflict 竞争和重启均保留原 assignment、fence、proof 与租约归属。复用第 14、24 单元的 38 行 reducer/ledger conformance，只补新生产入口、状态投影、删除/取消/超时/恢复 owner 接线及其响应丢失、崩溃和无证明禁重派测试。 |
| [x] | D26-08 | 原子提交结果、投递计划与状态通知 | user job committed 时以 `JobCommitFence` 在同一 CommitEnvelope 写权威终态、publish-decision 和从 occurrence 冻结计划派生的 delivery enqueued；显式目标优先，否则保留 origin/channel/thread，`none` 不投递，priority 取冻结任务映射，source 保留 taskName/createdInTurn 以维持 afterSlot 因果顺序，webhook `SecretRef` 只在发送 adapter 边界解析，重驱复用同一 idempotency key，transport 成败不回滚 job。每次状态转移使用耐久 `statusRevision` 生成至多一条可实时/补读 notice；渠道只收非 committed 终态与 uncertain，committed 走结果投递；missed 以稳定批次身份按 origin 聚合并幂等通知一次，能力/离线缺口只发一次可行动维护通知，裁决通知携完整 openFactDigest。复用第 15、24 单元 delivery/status 状态机，只补 job producer 原子接线、线程/slot 顺序、秘密零泄漏、publish 冲突呈现、汇总身份、断线补读和通知边界测试。 |
| [x] | D26-09 | 接入 system job 的锚点本地闭环 | 由锚点 `ensureSystemTask` 幂等注册封闭 `SystemHandlerId` 的 host-only TaskDefinition，并以本地 `runSystem`、scheduler-class resource coordinator 和 `SystemJobFence` 执行；不得产生 assignment、ExecutionManifest、数据面票据、用户投递或 uncertain，surface/RPC 不能创建、读取、触发、取消或修改。reserve+running+fence 以及 terminal+settle+release 各自同 envelope，冻结 paramsDigest 与稳定 jobRunId，崩溃后同 id 重驱；首次 seed 不立即补跑，后续错过至多合并一次 catch-up。复用第 14、18 单元 system-job/resource conformance，只补生产注册、handler 装配、重复 tick、恢复重驱、catch-up 合并和用户视图零泄漏测试。 |
| [x] | D26-10 | 排空并退役旧投递生产链 | 所有 scheduler producer 切到权威 Delivery 后，代码结构先保证旧 `IDeliveryPipeline.enqueue` 零新调用，再由单用途兼容 drainer 按旧 item 身份、目标顺序、重试与幂等语义排空 `delivery-queue.json`；持久 queued/retrying 与关停时已接管的 send 必须按既有合同收敛为 delivered 或永久 failed，队列和 in-flight 均为空前禁止删除文件或宣告退休，不为旧格式发明新的 uncertain/裁决协议。随后删除公开 `EnqueueParams/IDeliveryPipeline.enqueue`、旧 DeliveryPipeline/queue/store、CLI/server 装配、stats/flush 与全部生产调用；兼容 drainer 在无旧文件时零实例、零常驻。补最后一次旧入队/新版本启动交界、排空中崩溃、响应丢失与重复、空/损坏队列、重启重放及全仓旧入口零可达测试。 |
| [x] | D26-11 | 完成生产生命周期、文档切换与跨链直接验收 | 将任务目录、timer、JobJournal recovery、dispatcher、interaction relay、status/delivery producer、system runner 与旧链排空器纳入唯一 anchor 角色生命周期；交互 CLI、one-shot 与 daemon 只经现有 core-host/facade 接入，不再自建 Scheduler/RunRegistry，schedule profile 的按需拉起、保活、ready 与空闲退出语义保持。启动先恢复权威与未完成义务再开放触发；停机先拒绝新触发，再把已接管执行推进到终态或明确耐久恢复点，最后释放 channel/transport，未启用 anchor 时零后台实例。同步 `scheduler-architecture.md`、`persistent-service.md`、`message-outbox.md`、`remote-confirmation-execution.md` 与 `remote-interruption-execution.md` 中被本单元替代的旧 scheduler、投递、确认和中断生产路径，不扩展到第 29 单元的全模块文档治理。补 CRUD→触发→派发→交互/取消→提交→投递/通知的手动、定时、system 三条生产闭环，以及 task/occurrence 隔离、线程保真、uncertain 暂停、missed 汇总、投递唯一、system 隔离、旧 Scheduler/RunRegistry/投递入口零生产可达的直接集成与结构测试；不建立 benchmark 或性能采集门禁。 |
