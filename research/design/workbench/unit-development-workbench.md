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
- 单元：第 27 单元（S7）— advancement 与独立取证
- 架构与规格来源：`distributed-runtime-charter.md`（对话 owner 权威、advancement 取证、资源治理、离线能力与不变量）、`specification.md`（摘要与冻结类型、SessionStatePort、ControlCompletionPort、AdvancementReviewerPort、资源租约、EvidenceRequest/Bundle/ObservationToken、落点与能力矩阵、资源终结及第 27 单元验收）、`task-advancement-rubric-architecture.md`、`rubric-protocol.md`，以及第 18、20、23、25 单元已冻结的资源治理、mesh、设备容量、PathGuard 与 workspace binding/revision 合同；可执行规格中第 27 单元目标形态取代推进模块现有的进程内状态、直接本地取证和“先入全局 Rubric 库再生效”语义。
- 单元边界：将现有 advancement 准入、契约确认、accepted run 验收、代理续推、恢复与收场整体接入对话 owner 的权威状态端口和控制资源治理；以签名、短租约、耐久、幂等的 EvidenceRequest/Bundle 协议替换本地直接取证，使目标 executor 在绑定 workspace 内产生一致、只读、可核验的独立证据；把 Rubric 确认拆为立即生效的会话契约快照与可延后的全局库沉淀，并保持既有零认知确认、进度与接管体验。
- 明确排除：第 28 单元编排、memory、skill、task-list、segment 与写类 lifecycle 接入；第 29 单元全入口覆盖 lint；第 30～32 单元本地域 owner、DeferredGlobalIntent 耐久流、离线会话启用与收编；第 33～38 单元迁居、备份、服务生命周期与发布；验证性执行测试/构建的第二级取证、历史文件系统快照、通用取证或任务执行框架、通用诊断/观测平台、benchmark、性能采集与非必要 UI 扩展；重做既有 advancement 产品闭环、资源 governor、mesh、workspace binding 或 PathGuard 底座。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`11/11（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D27-01 | 收口 advancement 与取证合同 | 复用唯一 `AdvancementSnapshot ≙ AdvancementSession`、`AdvancementControlEvent ≙ AdvancementStoreEvent` 导出，按冻结 schema 落严格式 `EvidenceRequest`、`EvidenceBundle`、`ObservationToken` 及请求/内容/观测指纹算法；把 `ConfirmedRubricSnapshot` 身份改为 `library | local-draft` 判别来源，local-draft 固定 `snapshotId + contentDigest`。请求与 bundle 的规范 JCS 总字节沿 authority control 内联上限固定为 32 KiB，summary 沿既有结构事实摘要上限固定为 4 KiB；未知/多余字段、非法枚举、空或重复证据项、超限、错摘要、错 schema/version、路径/秘密混入 wire 均拒绝。补 codec、固定向量、类型负例、边界字节、重签身份不变和逐字段篡改测试，禁止再造并行 DTO、事件族或摘要语义。 |
| [x] | D27-02 | 将 AdvancementStore 接入对话 owner 权威日志 | 以 `SessionStatePort.readAdvancementState` 和 `SessionControlMutation(kind:"advancement-event")` 替换生产路径的进程内/独立文件状态；在同一 `AdvancementStoreEvent` 联合及 `AdvancementSnapshot` reducer 中补齐取证请求的 closed lifecycle（请求已耐久、验真结果已耐久、已结算或 deferred）与有界 pending 投影，使发送、结果接收和 review 之间任意崩溃都能只凭会话日志重入，禁止另建取证事实源。事件只由当前 conversation owner 的 host principal 经统一 authority guard 写入，并和 session revision/ownerEpoch、conversationId、advancementSessionId 严格绑定。保留每对话至多一个 open session、事件顺序、复合 review/proxy/terminal 原子性、恢复补审与删除闭包；advancement 继续归既有会话域 control 流的转移、保留与检查点分类，本单元只登记分类、不提前实现第 30～32 单元的转移。投影缺失从权威日志重建，损坏 fail-closed。补重复/异载荷事件、旧 owner/epoch、非 host、响应丢失、各原子边界崩溃、重启重放、删除/分类与现有状态机回归测试。 |
| [x] | D27-03 | 以 ControlCompletionPort 与 AdvancementReviewerPort 承载推进推理 | 将准入、草案生成/修订和收场的模型调用收口到 owner 设备的 `ControlCompletionPort`。保持 `AdvancementSnapshot` 只承载状态读取；把 owner-services 现有完整 `AdvancementReviewRunInput/Outcome` 提升为 core advancement 的唯一领域合同，再令 contracts 的 `AdvancementReviewerPort` 使用它，加入 owner 已验真的 canonical evidence并显式携带被审 run、rubric、既往 review、窗口、lease 与 abort；禁止 contracts 反向依赖 owner-services，禁止端口通过闭包或拓扑对象暗取输入。owner-services 只依赖端口和领域类型，不读取 anchor/local、in-process/mesh 拓扑；authority 事件仍由 owner-services 生成并经 SessionStatePort 提交，reviewer 不直接写状态。裁判继续使用强 schema 工具；基础设施失败/abort 保持 deferred 且不推进 review，非法或无裁判提交按既有 fail-closed 终局。补端口输入全等、依赖方向、角色选择、取消/deadline、响应错绑、transient/结论性失败分流及现有准入—确认—验收—续推—收场测试。 |
| [x] | D27-04 | 接入 advancement 与 review 的资源治理 | 推进准入、裁判和收场分别取得 advancement admission class 的 control 根租约，真实 provider 调用沿稳定 usageId 做耐久预占、consume、settle/release；每次 review 调用的根租约是该次所有取证子租约的唯一 parent，EvidenceRequest 必须携 `workload.kind="evidence"`、`workload.id=requestId`、目标 executor audience、parentId/parentDigest 与有界预算。executor 取证批次另经唯一设备容量裁决器取得 workload-advancement permit，租约不得冒充物理容量。bundle 或 typed-stale 是对应 evidence 子租约的正常终结点并经既有 usage intake 对账；发送不明、超时或 abort 先按可核验水位 settle/release、否则 reclaim，再按子先父后结束本次 review 调用，耐久未审 run/取证义务留给下一次 review attempt 以新租约重驱，禁止离线等待长期占租约或复用过期 lease。补无/伪/过期/错域/错父/越预算租约、重复 usage、调用成功/失败/abort、bundle/stale/传输不明终结与 intake、崩溃恢复、子先父后终结和 advancement 满载公平回归测试。 |
| [x] | D27-05 | 建立 owner 侧耐久取证请求与恢复链 | owner 从已接受 run 对应的 owner ledger/ExecutionManifest、确认版 Rubric 构造规范 items：按契约顺序携 locator，存在不可变目标摘要时携 digestHint，并在会话日志耐久保存 item index 到一个或多个 requirementId 的映射，wire 不新增内部 id，禁止临场猜路径。目标固定为冻结 workspace.deviceId；发送前用已验签 CapabilityDescriptor 核对该 executor、binding/revision 与所需 provider-level evidenceCapabilities，不得另选不持该 workspace 的设备。每个 attempt 使用可稳定重建的 requestId，先把完整签名请求、attempt、映射与 requestDigest 写入 AdvancementStore，再驱动进程内或 mesh；同一未过期 attempt 只重发原请求，stale、lease 终结或 ownerEpoch 变化后以当前 owner 和新租约生成下一 attempt/requestId，旧结果零推进。目标离线时保持已接受 run 未审、关闭本次资源调用并等待恢复重驱；能力或 binding 不满足、历史精确证据不可得按 capability-gap 收束。无 workspace 是正常分支：不得伪造 cwd/binding 或发送请求，conversation-fact 仍可审，required 客观证据按 capability-gap、非 required 按 unknown。验签并全等绑定 bundle、耐久记录结果后才交给 reviewer；`consistent=false` 记 typed-stale，最多重试 2 次后保持 deferred，缺 required 独立证据绝不通过。补无 workspace、目标离线/能力变化、owner 换代、写前/写后、发送、响应、结果落盘各点崩溃，响应丢失、重复/异载荷 bundle、旧 epoch、错绑定与有限重试测试。 |
| [x] | D27-06 | 实现 executor 独立取证入口与幂等账本 | 在 executor 角色装配受限 evidence handler；取证只走独立入口，不创建 assignment、不复用 run dispatch。任何文件系统访问前验证 owner 签名与信任、expiry、ownerEpoch、目标 executor、requestDigest、review/run/conversation、workspace binding/revision、provider capability、子租约与容量 permit；经本地 EnvironmentPort 解析绑定并复用 PathGuard，真实路径永不上 wire。以有界耐久 journal 按 requestId 保存规范请求身份和原 EvidenceBundle/typed 结果，同键全等重放不再读取，异载荷拒绝，过期后只允许回放已耐久结果；终态按既有 27 天保留窗回收，pending 不回收。补非法请求零文件访问、响应落盘前后崩溃、同键并发、重启回放、日志投影重建/损坏、binding 改路、symlink 逃逸、零 assignment 与 journal 有界回收测试。 |
| [x] | D27-07 | 生成一致且诚实的 ObservationToken 与证据包 | 只实现第一级只读取证：file-diff 读取当前 git 工作区事实；无 locator 时仅使用全工作区变更与该 run 已有触碰路径投影，log/artifact 必须严格按契约 locator 读取，不得越界降级全量扫描。每项以原始字节计算 contentDigest，并核对可选 digestHint；整个 locator 集合在读取前后按请求顺序计算状态指纹并冻结 observedAt，前后不等即 `consistent=false`，不得返回可采信证据。missing 如实进入状态指纹并形成缺证据；无快照文件系统不得声称历史精确状态，git/locator 能力不足返回 capability-gap。EvidenceBundle 由 executor 签名、绑定 EvidenceRequest 对象身份且所有 item 固定 `source:"independent"`；summary 只承载有界证据事实，真实路径不上行，并复用既有秘密脱敏边界处理已知凭据。补采集中改写/删除/替换、无 git/unborn、missing、locator/digestHint 错绑、摘要篡改、秘密/路径泄漏及文件/日志/产物正常路径测试。 |
| [x] | D27-08 | 收紧裁判采信与通过判据 | owner 按耐久 item→requirement 映射把已验真 bundle 转为稳定 evidenceId 与 requirementId 的 canonical evidence，模型只能按 evidenceId 引用，不能改写事实字段；客观证据不得由 run 输出、工具自述或执行侧生成的摘要冒充 independent，request/review/run/workspace 任一错绑证据不得进入 prompt 或 store。保持两层通过门：criteria 无 unmet，且每个 required、当前具备独立核验能力的要求均有通过的独立证据；同一证据可按耐久映射支撑多个全等要求但不得重复计数，无 independent 支撑的客观项至多 unknown，能力外 required 诚实退出请用户裁决。补伪 independent、自报替代、item/requirement 错绑、缺/重复/未知 evidenceId、criterion 错绑、stale bundle、required/unknown/capability-gap 组合和代理归因确定性测试。 |
| [x] | D27-09 | 拆分会话契约采用与全局 Rubric 沉淀 | 把 `RubricContractBuilder` 的候选检索收口到注入的只读 Rubric catalog：锚点 adapter 消费 GlobalStatePort 的 rubric asset index/内容资产，本地域未来只注入同步缓存，owner-services 不直接打开设备文件 Store。已有库条目确认生成 `source:library` 的不可变会话快照；新草案确认先以稳定 local-draft snapshotId/contentDigest 随 advancement 事件落当前 owner 并立即执行原任务，不得等待全局写或锚点可用。全局保存/修订是独立后续动作：锚点在线先把规范 Rubric 内容落 ArtifactStore，再以 dependency closure 经 GlobalStatePort 写入；owner-services 的离线分支只消费已注入的 `DeferredGlobalIntentPort` 合同，登记 rubric 意向并提示“已用于本任务，连接值班设备后保存”。本单元以 catalog/intent contract fake 验证未来本地域分支，不实现 intent 日志、生产本地域 owner 装配或收编；这些仍归第 30～32 单元。端口未装配时不得伪装已保存，保存失败不回滚已采用契约，后续 link 只关联库身份、不改写 active 快照内容。补 matched/generated、缓存只读、资产缺件、保存成功/失败/响应丢失、离线延后/端口缺失、重复确认、修订竞争、恢复后快照不漂移和产品文案测试。 |
| [x] | D27-10 | 完成生产装配与双适配取证链 | 在 anchor conversation owner 生产组合根注入唯一 SessionState-backed advancement adapter、ControlCompletion/Reviewer、资源 governor 和 evidence client，在 executor 角色注入唯一 evidence handler/provider/journal，并把真实可用的第一级 provider kinds 发布进已签名 CapabilityDescriptor，能力变化时严格推进 descriptor revision；稳定 descriptor 只声明 provider 能力，具体 workspace 是否为 git、locator 是否可达等动态前提由请求级解析诚实返回 capability-gap，禁止虚报成功。单机走进程内 adapter，分布式走 mesh adapter，两者复用同一 codec、guard、状态机与业务实现，未启用对应角色时零实例/零监听。启动先恢复 advancement 与未完成 evidence 义务再接受相关控制调用；停机拒绝新请求、已耐久请求停在可重驱点，释放 transport 不改变权威状态。补单机与 anchor+executor 同一 conformance、descriptor/请求能力交界、角色缺失、断线重连、owner/executor 重启、adapter 互换、重复装配、旧文件 AdvancementStore 与旧直接 provider 零生产可达及零拓扑分支测试。 |
| [x] | D27-11 | 同步推进架构并完成直接产品闭环验收 | 更新 `task-advancement-rubric-architecture.md` 中被本单元替代的直接本地取证、全局 workspace 和“先保存 Rubric 再生效”描述，并修正可执行规格中 reviewer 只有 snapshot、无法承载被审 run 与 canonical evidence 的字面签名，使文档与本单元唯一端口合同一致；明确取证请求生命周期、EvidenceRequest/Bundle/ObservationToken、owner 权威端口、review 子租约、能力声明/请求级前提及 local-draft/全局沉淀边界，不提前治理第 28、29 或第 30～32 单元能力。以现有 RPC/CLI 的普通任务直通、草案确认/修订/取消、accepted run review、失败续推、用户接管、详情、completed/exited 与恢复旅程为产品基线，新增有/无 workspace、local/remote evidence、目标离线、capability-gap、stale→重试→deferred、缺 required 证据、binding revision 漂移、离线 local-draft 立即生效/沉淀延后的端到端测试；确认等待/缺口都有可行动的人话反馈，取证严格只读，用户不见 topology/bindingRef/lease 等术语，不建立 benchmark、性能采集或非必要诊断门禁。 |
