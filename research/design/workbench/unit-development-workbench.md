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

本工作台前移的是开发范围的识别与完整实现，不是把独立审查或单元提交验证搬到开发阶段。开发前必须依据架构、需求和上下游合同，明确本单元应完成的边界、功能链与异常场景；开发时一次性完成这些已知义务，不得把未考虑或未实现的功能留给审查阶段补做。

### 交付优先级与扩张门禁

开发清单只承载当前单元的**最小完整产品范围**：权威来源明确要求的核心功能，以及缺少就会阻断核心使用、破坏既定产品体验或违反冻结合同的直接依赖。范围内必须好用、完整并采用最优架构；“最优”不得被解释为增加功能、预建未来能力或扩大验证设施。

任何新增事项都必须写出权威来源和当前必要性。非核心增强、未来单元能力、通用化预留、纯观测/benchmark、诊断平台、推测性防御和非必要重构不得进入开发事项；可以作为未来建议，但不得阻塞当前单元。无法判断的是产品范围变化时才交由用户确认，不能用架构偏好自行扩面。

清单定稿和开发完成后立即进入下一阶段，不得因“还可以更完整”反复扩充已经闭合的范围。

开发阶段只执行支撑当前实现所必需的直接验证，不进行重复的全量审查与重型验证。审查阶段只负责发现完整实现后的残余缺陷；本单元的已知范围必须在进入审查前全部落实，不能等到审查时才识别或补做。

开发清单只定义“必须交付什么”：每项写清功能范围、边界、场景、应实现行为及直接相关的测试代码，不登记“测试通过”“连续审查无问题”“达到可提交状态”等质量状态。勾选只表示对应实现与测试已经编写，不代表审查或单元提交验证通过。

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
2、按开发清单逐项完成生产实现、消费链路、边界场景及直接相关测试代码；完成一项立即标为 `[x]`。勾选只表示实现与测试代码已经完成，不代表审查或单元提交验证通过。
3、开发中发现清单遗漏了本单元必须实现的内容时，先补入清单再实现；不得擅自扩展单元边界。
4、渐进式实现、分步验证。

原则：

我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计。

验证纪律：
1、开发中只跑最小必要验证（类型检查 + 直接相关测试），修改边界只跑对应测试；源码修改后的必要构建按项目常驻规则执行并登记输入，同一构建输入在单元提交验证中直接复用。开发阶段不得运行受影响包全测、全模块回归或同输入重复构建；失败先归因，只重跑失效闭包。
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
- 单元：第 32 单元（S8）— conversation 收编与离线能力启用
- 架构与规格来源：`always-online-and-local-execution-requirements.md`（值班设备持续在线、本机直连与两种部署形态体验平权）、`distributed-runtime-charter.md`（每个 conversation 恰一 current owner、本地域完整会话域、统一 `AuthorityTransfer`、收编前后 fencing、公开产品语言与异常旅程）、`specification.md`（严格身份/摘要/签名、`SourceFreezeProof`、`ConversationTransferCommit`、`TransferRecord`、双端 `transfer:<transferId>`、会话域权威覆盖、§5.7 取证 current-owner 门禁、§6.3 全状态边、能力矩阵、产品旅程、不变量及第 32 单元验收）；上游生产事实以第 30 单元 `LocalConversationOwnerAssembly`/双生产根、第 31 单元 conversation-owned intent 流与 anchor internal review、现有 `AuthorityCommitLog`、SessionState/ConversationRunJournal、ArtifactStore、mesh request channel、EvidenceJournal 和 S7 入口/结构门禁为准；下游边界以第 33～35 单元全量检查点、planned anchor 迁居、TrustTransition 与灾难恢复合同为准。
- 单元边界：在本地域 conversation owner 与锚点 owner 之间实现 conversation scope 的双端耐久 `AuthorityTransfer`：双方 prepared，源端关闭该会话准入并收束在途工作，冻结包含完整会话状态、内容资产与 deferred intents 的窄会话检查点，目标隔离导入并校验，`ConversationTransferCommit` 唯一切换 ownerEpoch，旧 owner 永久 fencing 后清理。任意步骤可按双方日志幂等恢复，commit 前可 abort 并恢复源端同 epoch，commit 后只能前滚。收编闭合后开放现有第一方会话入口的离线新建/查询/恢复与自动收编旅程，接通第 31 单元复核接缝，并把同一 current-owner verifier 前置到 local/mesh 取证的 journal 和 workspace 读取之前。
- 明确排除：anchor scope 的 planned/disaster-recovery transfer、`AnchorTransferCommit`、TrustTransition、ReadyProof、全量/周期加密 `CheckpointEnvelope`、恢复根、信任换代和凭据轮换；第 36～38 单元托管服务、设备移除/销毁、卸载、升级与发布；锚点域既有会话离线写、非权威只读副本、跨设备秘密/环境事实迁移、缓存迁移或本地消费追认为全局预算；新增第二事实源、跨存储通用事务、通用同步/备份/registry/事件总线/调用图/测试 runner、监控、诊断、benchmark 或信息采集设施；渠道仍只由值班设备承载，不在干活电脑新增渠道宿主。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`8/8（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D32-01 | 冻结 conversation transfer 严格合同与纯状态机 | 在现有 contracts/authority codec 中落地 conversation scope 的 `SourceFreezeProof`、`ConversationTransferCommit`、`TransferRecord`、窄 `ConversationTransferManifest` 及仅供已认证 mesh 协调/取件的 transfer command/result 联合：稳定 requestId/`transferId=xfer-<Ulid>`、source/target device、subject/conversation、sourceOwnerEpoch、nextOwnerEpoch、lastLsn、各会话逻辑流记录范围/计数/摘要、权威记录基底与可重建 SessionState 物化引用、内容资产引用全部显式反绑；manifest 规范字节先入 ArtifactStore，`SourceFreezeProof.checkpointDigest` 必须等于该 `ArtifactRef.digest`，物化快照只作 commit 前预备的派生读面、不得成为第二事实源。proof/commit/abort 身份、签名与摘要沿现有协议单源，`nextOwnerEpoch=sourceOwnerEpoch+1`。reducer 严格实现 prepared→frozen→imported→committed→tombstoned 及 commit 前 aborted，prepared 后 scope/subject/source epoch/双端身份不可漂移；重复同载荷幂等，异载荷、越级、回退、伪签 abort、late abort、未知字段在副作用前拒绝。manifest 只描述单 conversation 的可转移权威，不复用或扩展第 33 单元加密 `CheckpointEnvelope`。补严格 codec、摘要/签名、全联合、逐状态边、双端错绑、乱序、重复和坏尾重放测试。 |
| [x] | D32-02 | 实现源端冻结、完整会话导出与可恢复 abort | 在本地域 owner 上按 conversation 装配唯一 transfer source：仅允许该 conversation 当前权威发起，目标必须是已认证的当前锚点；以稳定 requestId/transferId 完成双方 prepared 对账后，在同一 owner 日志顺序内先重验会话未删除/无进行中 transfer，再耐久关闭该会话 fresh admission。等待 active/queued/confirmation/finality 达到既有可判定终态或明确裁决后，以 `DurableLogCheckpoint` 冻结同一 AuthorityCommitLog 前缀并生成 D32-01 manifest/proof。建立有限 conversation-owned selector，覆盖 meta/transcript、`run:<conversationId>`、该会话的 `control`、`publish`、`final-outbox`、task-list/segment/advancement、`session-activity:<conversationId>`、content-asset-index 与全部被引 ArtifactStore 内容、`intent:<conversationId>` 及其 rubric 资产；共享物理流只选逐字段全等反绑该 conversation 的记录，任何无法归属的记录 fail-closed。源端通过现有 mesh range/probe 原语提供窄 transfer read port，只允许 proof 绑定目标按 transferId 读取 manifest 精确列出的 ref/范围，不暴露路径或任意 ArtifactStore。不得导出 GlobalState/job/trust/delivery、环境事实、本地秘密、窗口/执行资产缓存或非权威投影。合法 pre-commit abort 恢复源端原 ownerEpoch 准入并驱动目标 staging 隔离清理；失败、响应丢失和重启只从源 transfer 流继续，冻结后不得自行重开写。补写入/删除/freeze 竞争、在途收束、共享流夹杂、越 ref/范围/目标取件、全域清单、缺件/磁盘失败、各耐久边界崩溃、重复发起/abort、响应丢失和连续重启测试。 |
| [x] | D32-03 | 实现目标隔离导入、全量校验与幂等追平 | 锚点 target 只接受当前 home 内 active source device、与设备前缀全等的 local conversation、当前 source ownerEpoch 且无既有目标会话/进行中 transfer 的请求，先在自己的 `transfer:<transferId>` 落 prepared，再以现有 ArtifactStore 建立仅该 transfer 可见的 staging。按 D32-01 验证双端身份、SourceFreezeProof、manifest ArtifactRef/规范字节、lastLsn、每个逻辑流计数/摘要、权威记录基底及全部资产引用；仅从 D32-02 transfer read port 按规范 ref 顺序 probe/range 拉取，分块接收复用现有 `putVerifiedStream`、storage governor 与设备唯一 capacity arbiter，等待容量时不持 authority/ArtifactStore 锁，`capacity-gap`、backpressure、取消和内容损坏分型。imported 前用现有 reducer 把冻结记录基底预备为耐久、不可变且可从 manifest 重建的 ConversationRunJournal/SessionState 读面，校验其 source checkpoint 与 reducer version；该读面仍由 manifest+commit 引用的权威记录决定，不另写业务事实。全验和预备完成后才落 imported；部分导入只记耐久进度，公开 session 目录、owner 查询和 intent review 在 commit 前均不可见、不可写。重复/乱序分块、效果后响应丢失与重启从同一 staging 追平；缺失/多列/损坏/错 conversation/epoch/digest/流 fail-closed，abort 幂等隔离并清理，不污染既有会话或同 digest 合法资产。补空/大资产、共享 digest、跨流错绑、reducer/version 漂移、部分/重复/乱序、容量不足、损坏、清理失败、响应丢失和连续重启测试。 |
| [x] | D32-04 | 以唯一 commit 切换 current owner 并永久 fencing 旧端 | 目标只在 imported 全验后签发 `ConversationTransferCommit`；同一锚点 AuthorityCommitLog 事务只追加该 commit 作为唯一 current-owner/ownerEpoch 切换事实，并在写前预备全局 conversation directory、已导入会话可见性和 current-authority 派生 delta。fsync 后以不可失败指针同时发布这些投影及 D32-03 不可变历史基底；ConversationRunJournal/SessionState 统一读取该基底加目标日志后继，不复制历史或目录为第二事实源，重启从 commit→manifest 确定性恢复。把现有 conversation-scoped admission、run/assignment capability、control/session mutation、intent review、final/history 与 evidence request 的标量 ownerEpoch 读取收敛为同一窄 current-conversation-authority resolver：普通锚点/本地域会话保持原 epoch，收编会话从 commit 取得 nextOwnerEpoch，禁止用 anchorEpoch 或进程级 localOwnerEpoch 覆盖。源端仅接受与原 source/target、proof/checkpoint 全等且由当前锚点签发的 commit，随后永久拒绝旧 epoch 的 fresh write、exact replay、intent/evidence/control 能力并返回重定向；确认目标已持完整权威后，只释放该 conversation 的源引用、保留共享 artifact、commit/tombstone/fencing 证据，再落 tombstoned。commit 后 abort 恒拒绝，只允许更高 epoch 正向 transfer。双方 coordinator 以同 transferId 对账，ACK/响应丢失、双方重启或重复网络往返不得产生双 owner、重复 conversation/intent/task revision、资产误删或 epoch 回滚。补普通锚点会话与收编会话并存、所有 epoch 消费面、commit 前后每一崩溃点、并发写、旧能力/旧 requestId、基底发布/恢复、共享资产、迟到 abort、tombstone 失败和连续重启测试。 |
| [x] | D32-05 | 将 current-owner 验证前置到 local/mesh 取证读取 | 从 D32-04 的同一 current-owner 事实提供窄 `EvidenceRequest` verifier，并作为本地 `ExecutorEvidenceHandler` 与 mesh evidence service 两个生产根的必注入依赖；在 `EvidenceJournal` exact replay、workspace binding/路径解析和任何文件读取之前校验 owner identity、ownerEpoch、conversation 与请求静态绑定。终态 exact replay 只可豁免时效/激活/吊销，不得豁免 current owner；旧 owner 的新 request 与历史 requestId 均零 journal/workspace 读取并返回稳定拒绝，current owner 对原请求重放原 bundle，异载荷冲突。补迁移前后切换、local/mesh 同谓词、fresh/exact、重复/并发、响应丢失、旧 epoch、错 conversation/device/workspace binding 及读取 spy 测试。 |
| [x] | D32-06 | 开放零术语的离线会话、自动收编与意向复核旅程 | 在 transfer/intents 闭合后，把现有第一方 `session.new/list/resume`、`/new`、`/resume` 与 REPL conversation facade 接到 owner-aware 窄路由：值班设备可达时保持现状；不可达时先明确提示“继续在这台电脑工作（新对话）”及不可用能力，用户确认后只创建/列出/恢复本机 local conversation，锚点域旧会话仍不可写。重连由唯一 adoption coordinator 自动收编本机未收编会话，并以稳定摘要呈现合并数量和待确认提醒；收编后调用第 31 单元 anchor review，rubric 无冲突可收敛，schedule 必须由 authenticated surface 对当前 intent/mutation 再确认。建立窄公开结果联合，将 not-found、busy、无效请求、身份/版本冲突和暂态失败映射为一致、可行动的产品语言，禁止泄漏 anchor/owner/epoch/intent/CAS/stream 等内部术语或把 pending/失败显示为完成。补单机零新概念、值班失联、local create/list/resume、旧会话拒写、重连收编、复核成功/冲突/重试、响应丢失、live/history 去重和连续重启产品测试。 |
| [x] | D32-07 | 补驱动收编会话的锚点侧记忆蒸馏 | `ConversationTransferCommit` 生效后，从已导入的权威 transcript/segment 事实按既有生命周期水位补驱动锚点 MemoryFlush；只复用现有 segment flush hook 与 GlobalState 写路径，稳定 operationId 由 conversationId、segment identity 与原文/摘要 digest 确定，transferId 只作恢复来源、不得进入幂等身份，保证后续前滚转移也不重复蒸馏。不信任源端生成的全局 memory，不在 staging 或 commit 前运行。成功水位可由原会话事实与现有幂等结果重建；LLM/全局写失败、响应丢失或锚点重启保留未消费水位并重驱，已经落定的 segment 不重复产生 memory revision，后续正常 turn 从同一水位继续。该项只补总纲明确要求的收编后蒸馏，不新增 memory transfer、第二队列或通用 lifecycle 框架。补零/单/多 segment、已蒸馏与未蒸馏混合、同 segment 跨 transfer、LLM/写入效果前后失败、响应丢失、连续重启、与 deferred intent review 并行及零 pre-commit 全局副作用测试。 |
| [x] | D32-08 | 闭合双生产根装配、恢复、结构门禁与 S8 验收 | 在 anchor+executor 与 executor-only/远端 anchor 两份真实生产装配中分别放置恰一个适用的 transfer target/source/coordinator，复用现有 mesh request channel、AuthorityCommitLog、ArtifactStore、local owner lifecycle 与 anchor review；启动先恢复未终态 transfer/current-owner/收编后消费水位再开放对应准入，关闭拒绝新 transfer 并保留可重驱耐久事实，不适用角色零装配。扩展现有 S7 registry/AST/golden，只覆盖 transfer/evidence/public session 的有限生产 descriptor、current-owner verifier 必注入、旧 owner/禁用能力零旁路及两根 exact-set，不新建通用发现框架。以真实双拓扑执行 §6.3 conversation 全边、每一步崩溃重入、完整会话域与资产/intent 零遗漏、old-owner fencing、EvidenceRequest 切换、D32-06 四时刻旅程及 D32-07 后续消费；八配置只复用装配 exact-set，不构造配置×故障笛卡尔积。同步当前 wire/架构说明并机械确认第 33～35 单元合同未提前启用，全部通过后才标记 S8 已启用。 |
