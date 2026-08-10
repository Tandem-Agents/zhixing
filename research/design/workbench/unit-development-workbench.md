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
- 单元：第 35 单元（S9）— 灾难恢复与安全域换代
- 架构与规格来源：`always-online-and-local-execution-requirements.md`（唯一值班设备、设备离线不等于权威切换、秘密与环境事实本地化）、`distributed-runtime-charter.md`（恢复根双键授权、永久丢失值班设备时人工安全域换代、旧 epoch/旧签发者拒绝、凭据与信任重建、恢复包轮换/丢失/泄露、无自动升主及零术语恢复旅程）、`specification.md`（`HomeTrustEvent`/`HomeTrustRecord`、`AnchorTransferCommit(disaster-recovery)`、`RecoveryActivationPlan`、`RecoveryCheckpointVerification`、`CredentialExposureRecord`/`exposure` 流、`AuthorityTransfer` disaster 全状态边、`pending-reenroll`、六类权威覆盖/资源治理及第 35 单元验收）、`s2-security-supply-chain-review.md`（恢复封装与签名算法的安全边界）；上游冻结复用第 33 单元已封版的 full `CheckpointEnvelope`、checkpoint-only `ChunkSource/ChunkSink`、directory/paired target、恢复包/target identity 与 root-activation/readiness 接缝，以及第 34 单元已封版的 target-wide candidate、per-transfer private import、immutable/composite authority base、单 envelope install、`InstalledAuthorityGeneration`、current-owner 接管和双端 terminal replay 原语；下游只向第 36 单元交付已完成安全域换代、可公开服务的唯一 current anchor/trust generation 和明确的逐 binding 凭据状态，不提前实现服务托管或通用生命周期能力。
- 单元边界：仅闭合两条现行 S9 恢复旅程。其一，当前值班设备永久丢失且用户持有有效恢复包时，用户从既有独立 directory/paired target 的有限 inventory 选择完整副本；恢复目标在没有 source/freeze proof、也不依赖已丢 source 上 `checkpoint-verified` 记录的前提下，以恢复根真解封并现场签发 verification，重放载荷内 authority/trust 前缀形成无秘密 catalog，私有导入后生成新 issuer/ready 证明和 disaster `issuer-transition`，再以恢复根签名的唯一 `AnchorTransferCommit(disaster-recovery)` 原子发布更高 `anchorEpoch/trustEpoch`、current anchor、trust generation、旧 issuer 撤销与其凭据阻断事实；提交前只接受恢复根签名 abort，提交后只前滚。其二，current issuer 仍在但恢复包轮换、泄露或丢失时，分别复用既有 rotate/invalidate，或仅允许 issuer 与另一台 active 设备共同授权、经已复制并真解封验证的新根检查点把 `domain-reset + establish` 计划原子入链；非 issuer 设备转 `pending-reenroll`，只能凭新一次单次配对 transcript 逐台重新加入。单设备或同时丢失 issuer 与恢复包时不得原地自授权，只能如实进入重建 home 旅程。未轮换的外部 binding 保持 degraded/不可路由，不阻断与其无关的已恢复核心能力；S9 仅在权威恢复、信任换代、旧设备隔离和核心可用性均闭合后启用。
- 明确排除：第 36～38 单元的托管服务、自恢复常驻、三路径停机/移除/卸载、升级回滚和发布；网络分区自动升主、quorum/witness、多 active anchor、source-less 自动判定、无人值守灾难恢复、全局连续同步、多目标或云备份；重做第 33 单元 envelope/chunk/target 生命周期或第 34 单元 planned fence/private publication/current-owner 原语（本单元只为人工无源恢复补 checkpoint-owned 完整副本 inventory 与现场 verification，不建设通用扫描或备份浏览框架）；自动登录第三方平台或建设 provider 专用凭据轮换系统；把 SecretStore 内容、环境事实、workspace 原始路径或设备缓存写入恢复载荷；通用迁移/恢复/路由/存储/事务/outbox/事件总线/registry、扫描框架、新 lint/test runner、监控、诊断、benchmark 和信息采集设施。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`9/9（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D35-01 | 冻结 disaster recovery 的授权、身份与全状态合同 | 依据总纲“恢复根人工授权、无自动升主”和规格 disaster 状态边，在现有 contracts/mesh 严格联合中新增与 planned 结构隔离的 `disaster-recovery` command/record/result/commit/abort 分支：仅目标端允许 `prepared→imported→committed→tombstoned` 及 `prepared|imported→aborted`，无 source、`SourceFreezeProof`、frozen 或 planned export 字段；DR abort 必须是带 mode、request/transfer/target、checkpoint envelope 与原因的恢复根签名对象，不能复用要求 sourceDeviceId/sourceAnchorEpoch 的 planned abort，commit 后 late abort 永久拒绝。candidate/commit 稳定 identity 冻结 home、recovery-root generation、request/transfer/target、checkpoint envelope、现场 verification、authority catalog、trust transition、ready proof、next anchor/trust epoch 与目标签发公钥；恢复主秘密永不入 wire/log。严格 codec 在分类前反绑 originating command/result，逐字段验签顺序固定，同载荷 exact/terminal replay，任一错绑、跨 mode/state、未知/多余字段、错误根或异载荷均零副作用拒绝。补状态行 0b/2/3b/5b/6/7/8、abort/commit 竞争、效果/响应丢失与连续重启直接测试；这是无源恢复不伪造 source 前提、也不误入 planned reducer 的必要合同。 |
| [x] | D35-02 | 提供 source-less 完整副本 inventory 与可行动选择 | 依据“锚点永久丢失仍能从用户指定位置或配对设备恢复”和第 33 单元现有 target 只按 checkpointId 读取的生产事实，为 directory/paired checkpoint target 增加 checkpoint-owned 的有限只读 inventory：只枚举冻结物理 root 下已 durable commit、manifest/chunk exact-set 完整且未物理 retire 的 full `CheckpointEnvelope`，排除 staging、部分写、历史 trust-only 包、额外文件和越根对象；paired wire 只增加同语义严格结果并反绑请求、target generation 与 envelope identity，不开放通用文件扫描/列表。公开管理面只展示目标名称、备份时间和“待验证”，唯一候选可直接选择，多候选必须由用户按时间/位置明确选择，内部 checkpoint/target id 不展示也不接受用户自报；选择输出只作为 D35-03 candidate claim 的不可变输入，由该 claim 提供响应丢失/重启后的唯一耐久选择事实，不另建 selection 状态源。补空/单/多候选、directory/paired、partial/retired/额外文件、父子路径替换、错 result、列表后目标变化、取消/断连/响应丢失与重启测试；缺此项时恢复包本身不含 checkpointId，核心无源旅程无法到达既有 `read(checkpointId)`。 |
| [x] | D35-03 | 建立 target-only claim，真解封并现场形成唯一 verification | 依据灾难状态边 0b、恢复包双键派生、`RecoveryCheckpointVerification` 与“备份存在不等于可恢复”，无回显解码恢复包后先用现有 target-wide candidate journal，以 home/root generation/request/transfer/target/所选 envelope exact identity 耐久 claim并对同/异 transfer 单飞；claim 前零 issuer key、reservation、staging 或 authority 写。随后复用有界 `CheckpointChunkSource`，在恢复目标本机派生 Ed25519 签名根与 X25519 解封根，反绑所选 envelope recipient/root 后逐块 KEM/AEAD 解封；从 record pages 重放 trust 前缀，验旧 issuer envelope 签名、payload issuer/home/source/trust head、manifest purpose、nonce、chunk digest/size/order、四类 full coverage 与 retained exact-set。checkpoint trust 必须与目标本地及可达 active peer 已耐久的 signed trust/current-authority evidence 属于同一可验祖先链；只做本次恢复所需的有限 reconcile，冻结最先进且全等的 `{trust head,current issuer,anchorEpoch,trustEpoch,current recovery root}` 作为 `RecoveryBaseline`，禁止用旧根、旧 issuer/epoch 或分叉证据回滚，缺少 anchorEpoch 的裸 `HomeTrustRecord` 不得单独抬升 baseline。source 已丢失且独立 target 不持 source `checkpoint-verified` 流记录，禁止假设可读取旧 verification；真解封后用 baseline 当前恢复根对 nonce/envelope/checkpoint-storage target 现场签发并立即复验新的 `RecoveryCheckpointVerification`，把完整 verification 与 baseline evidence 耐久追加到同一 claim 后才允许 import。正文/key material 只在受 governor 管理的固定 buffer 内存在并及时清零，网络等待零 permit，秘密/环境/路径/缓存不可由载荷产生。补当前 full 与历史 trust-only 严格分流、同/异 claim、checkpoint 后非根 trust 前进/已提交 planned 换代、空/大 authority、伪造 verification、错 key/nonce/issuer/target/digest、缺块/重排/额外块、旧根/分叉链/缺 epoch evidence、容量/磁盘、取消/断连/丢响应与重启测试；任一失败在 issuer key/private import 前零副作用，claim 只可由同身份 signed abort 收束。 |
| [x] | D35-04 | 建立 ReadyProof、确定性 catalog 与私有完整导入 | 依据灾难状态边 3b、六类权威覆盖及第 34 单元 target-private publication，恢复目标必须在 D35-03 有效 trust snapshot 中为 active anchor，且本机角色、配置、协议、资产、服务与 SecretStore 当前可承担值班职责。只在 verified candidate 上按 transfer 耐久生成唯一 issuer key 和带 expiry 的 `ReadyProof` reservation；proof/candidate/现场 verification 全等后才进入 per-transfer 私有 root/journal/`FileArtifactStore`。按原 envelope bytes/LSN/digest 重建不可见 authority base，并用现有 `AuthorityCommitLog` schema/reducer只读重放同一 source prefix，确定性产出旧 issuer/sourceDeviceId、restored sourceAnchorEpoch、stream ranges、trust、六类 coverage、pending obligation 与 retained ref exact-set，形成无秘密 `AuthorityCatalog`；禁止从 payload header 猜 epoch、用空 pending 或另建分类谓词。共享 CAS 仅在 records/artifacts/catalog 全验后幂等提升，部分导入、key、reservation 和 base 对 authority consumer 零可见；signed abort 只清本 transfer 私有状态且不误删共享 ref。补非 active/错角色/本机不 ready、proof 过期/revision 漂移、零/非空 pending/retained、坏 record page、共享 digest、部分导入、容量/stop、响应丢失与连续恢复测试；缺此项会发布不可重放 catalog、半套权威或错误值班代际。 |
| [x] | D35-05 | 以恢复根唯一提交原子发布换代并撤销旧锚点 | 依据 `AnchorTransferCommit(disaster-recovery)`、root-signed `issuer-transition`、设备撤销收束与单 envelope 原子性，imported 后重验 D35-03 `RecoveryBaseline`、现场 verification/catalog、ReadyProof reservation 与新 issuer；checkpoint authority base保持原 LSN/digest，不把后继 trust/current-owner evidence伪装进旧 base，baseline 较新的全验 trust events与签名 current-anchor commit仅作为本次 install 前缀证据。`nextAnchorEpoch=baseline.anchorEpoch+1`、`nextTrustEpoch=baseline.trustEpoch+1`，transition 的 from issuer/chain head与baseline current issuer全等，commit每个digest/target/key/epoch均由baseline有效恢复根签名。目标在同一 `AuthorityCommitLog` envelope/fsync 先接续缺失的已验 trust events，再原子发布 immutable/composite base pointer、commit、transition、current anchor、next epochs、`InstalledAuthorityGeneration` 与 install；transition 后由新 issuer 对 baseline 失控 current issuer device写有序 `revoke`，并把该设备现存 active exposure记录在同一提交推进 `compromised`，使旧设备信任和外部路由在公开前同时失效。此前零业务可见，此后无决定可服务性的发布 I/O，失败只从同一 durable identity前滚。pre-commit root-signed abort先耐久terminal再清key/staging/reservation；commit先赢则abort永久拒绝。补 checkpoint 后 trust 前进/一次 planned 换代、旧 root/checkpoint/issuer、每个 digest/epoch/target 字段、revoke/exposure缺失或错序、abort/commit双序、唯一sync前后崩溃、exact/异载荷replay、响应丢失和连续重启测试；该项防止恢复复用旧epoch、撤错设备，或让数据、current owner、trust与旧设备隔离形成半安全域。 |
| [x] | D35-06 | 恢复 runtime 消费闭包并永久 fencing 旧安全域 | 依据“换代后旧签发者永久失权、提交后只前进”及第 34 单元 installed-generation/current-owner 合同，target live/startup 均从同一 disaster installation 取得 `InstalledAuthorityGeneration`，在公开准入前统一重绑 runtime epoch、外部 projection/cursor、surface authority 和 scheduler/conversation/global/delivery 固定 consumer，逐项恢复 catalog 全部 pending obligation并回读归属新 current owner；原 request/task/conversation/interaction/effect identity 与水位不变，终态效果不重跑。认证 mesh、第一方 CLI/server/channel/confirmation/notification、管理入口及 credential route guard 逐次消费同一 signed trust/exposure projection；旧 anchorEpoch/trustEpoch/issuer、revoked source、迟到 capability/结果和旧 binding 全部拒绝且不得回退，未轮换 binding 只令对应外部能力 degraded。用户确认旧设备已隔离或擦除后才把 transfer 幂等推进 tombstoned。补两 current-anchor profile、live/startup、六类 pending 空/单/多、cursor 已推进、epoch 多次换代、旧端在线/离线/迟到、consumer/route-guard 各切点、响应丢失和连续重启测试；仅追赶本次 transition，不建设持续全局同步。 |
| [x] | D35-07 | 闭合恢复根 rotate、invalidate、丢失 reset 与逐设备 reenroll | 依据恢复根生命周期和 `domain-reset` 制衡守卫，复用第 33 单元 root-activation create/replicate/readback/verify/atomic activation：用户仍持旧根且主动置换或泄露后立即换新时走 recovery-root `rotate`；泄露但暂不能换新时只允许旧根签 `invalidate`，立即令 DR/readiness 不可用，后续仍须 issuer 经新 `establish` 恢复；主秘密真正丢失且 current issuer 可用时，issuer 与另一台不同 active 设备分别验身份和用户确认后共同签出连续 `domain-reset + establish`。完整计划必须绑定候选新根 full checkpoint，由持候选主秘密的引导端从独立目标真解封验证后，才在同一 `CommitEnvelope` 原子写两条 trust event、verified 与旧 checkpoint superseded；任何单独 reset、断链、错 coSign/rootProof 或提前开放均拒绝。reset 后所有非 issuer 设备立即断连并转 `pending-reenroll`；每台只可复用既有 pairing 流新生成的单次 fresh transcript，在 device/current trustEpoch/pending 身份全等且 acceptance 与 `reenroll` 同 envelope 后回 active，再走原角色/配置 ready。旧根包/备份不再 current-ready。单设备、缺第二 active 共签者、或 issuer 与恢复包同时丢失时禁止原地重置，进入重建 home/旧备份不可用旅程。补 rotate/invalidate/reset 双序、计划各崩溃点、伪造/重放/旧 transcript/错设备、逐台 reenroll、旧根拒绝、双重灾难与连续重启测试。 |
| [x] | D35-08 | 闭合凭据轮换清单、逐 binding 路由与恢复后 readiness | 依据 `CredentialExposureRecord` 的锚点域 `exposure` 流和“revoke→compromised→阻断路由→rotated”，把 D35-05 已原子写入的 compromised 事实作为唯一输入，由 current-anchor 组合根装配恰一 exposure owner/projector；按 device/binding/service/principal/tenant/scopes latest-wins 重建非秘密清单，provider/channel/MCP/webhook/rendezvous 在解引用 SecretRef 或发起外部调用前共用同一 route guard，失控旧设备不可达不得冒充本地清退或 rotated。公开清单按 service/principal/tenant/scopes 去重，只给稳定 `rotationHint` 与可行动状态。用户在第三方轮换后仅通过既有 credential binding 发布路径把新秘密写目标本地 SecretStore并回读，以 service-verified principal、目标 device/binding、单调 binding revision 与对应 readiness 全等为守卫；同一 control request 在一个 authority envelope 同时追加新目标 device/binding 的 `active` exposure 与旧 compromised exposure 的 `rotated` 后才恢复路由，禁止只改旧记录而让新设备凭据没有后续撤销事实。丢响应、重启和重复确认不得跳过验证或生成第二身份；未完成项只阻断对应 binding，其他核心能力保持可用。补零/多/重复 exposure、旧设备可达/失控、旧凭据调用、部分轮换、错 principal/revision、SecretStore 锁定、新 active exposure 缺失/重复、路由竞争、丢响应和重启测试；不自动登录第三方或新建 provider 轮换系统。 |
| [x] | D35-09 | 开放零认知恢复旅程并冻结生产 exact-set 与必要证据 | 依据总纲产品语言、角色 exact-set 与第 35 单元验收，在现有第一方 CLI/server 管理面开放两条旅程：值班设备丢失时选择备份位置/设备及备份时间、无回显输入恢复包，按“查找备份→验证备份→恢复数据→接管值班→处理旧设备账号”展示可行动阶段；恢复包轮换/泄露/丢失时分别展示换新或停用、另一设备共同确认、保存并回读新恢复码、逐设备重新加入；单设备/双重灾难只说明重建 home 与数据损失，不提供绕过。公开 DTO/错误不得出现 root key、raw device/checkpoint/transfer ID、digest、epoch、路径或原始异常，备份 inventory 不得把“完整存储”冒充“已验证”，取消只在唯一 commit 前可用。冻结 topology：两个 current-anchor profile各恰一 root-lifecycle/exposure owner；本机 eligible recovery target 在 commit 前恰一有限 disaster owner/receiver、提交后切换到既有 current-anchor runtime；distinct active co-signer 只走既有认证 pairing/confirmation 边界，executor-only/surface/disabled/无关设备零 owner。扩展现有 S7 descriptor/validator 与 golden 双向反绑 inventory、DR owner、root plan、reenroll、exposure guard和开放顺序，不建新 runner。同步总纲、规格、入口矩阵与直接测试；用真实 log/store/index、directory/paired target、SecretStore、governor 和认证 mesh 跑无源发现/恢复、伪造 verification、计划断链、旧根/旧锚点、逐设备 reenroll、凭据清单、双重灾难及零认知端到端小表，并机械断言第 36～38 单元、自动 failover 和连续同步未启用。 |
